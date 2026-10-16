use crate::logger::log;
use crate::types::{AppState, S99ZKEEN_UI};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use std::path::Path;
use tokio::net::TcpListener;
use tokio::process::Command;

#[derive(Deserialize)]
pub struct PortReq {
    port: u16,
}

/// Unauthenticated liveness probe for local watchdog / load balancers.
pub async fn get_health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

pub async fn get_panel(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "success": true,
        "port": state.listen_port,
    }))
}

pub async fn post_panel_port(State(state): State<AppState>, Json(req): Json<PortReq>) -> impl IntoResponse {
    let port = req.port;
    if !(1024..=65535).contains(&port) {
        return Json(serde_json::json!({
            "success": false,
            "error": "invalid_panel_port",
        }));
    }

    let old_port = state.listen_port;
    if port == old_port {
        return Json(serde_json::json!({
            "success": true,
            "port": port,
            "restarted": false,
        }));
    }

    // Probe before rewriting init: occupied port must not take the panel down.
    if let Err(e) = probe_port_free(port).await {
        return Json(serde_json::json!({
            "success": false,
            "error": e,
        }));
    }

    let Ok(previous_init) = tokio::fs::read_to_string(S99ZKEEN_UI).await else {
        return Json(serde_json::json!({
            "success": false,
            "error": "panel_init_missing",
        }));
    };

    if let Err(e) = write_init_port(port).await {
        return Json(serde_json::json!({
            "success": false,
            "error": e,
        }));
    }

    if !Path::new(S99ZKEEN_UI).exists() {
        let _ = restore_init_content(&previous_init).await;
        return Json(serde_json::json!({
            "success": false,
            "error": "panel_init_missing",
        }));
    }

    log("INFO", format!("Panel port changed to {port}, restarting…"));
    match Command::new(S99ZKEEN_UI)
        .arg("restart")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(_) => {
            // Watchdog only after restart was requested; uses public /api/health (no session).
            if let Err(e) = spawn_port_watchdog(old_port, port) {
                log("WARN", format!("Watchdog смены порта не запущен: {e}"));
            }
            Json(serde_json::json!({
                "success": true,
                "port": port,
                "restarted": true,
            }))
        }
        Err(e) => {
            log("ERROR", format!("Не удалось запустить restart панели: {e}"));
            let _ = restore_init_content(&previous_init).await;
            Json(serde_json::json!({
                "success": false,
                "error": format!("restart_failed:panel:{e}"),
            }))
        }
    }
}

async fn probe_port_free(port: u16) -> Result<(), String> {
    match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => Err("port_in_use".into()),
        Err(e) => Err(format!("port_bind_failed:{e}")),
    }
}

async fn restore_init_content(content: &str) -> Result<(), String> {
    let tmp = format!("{S99ZKEEN_UI}.tmp");
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("write_init_failed:{e}"))?;
    tokio::fs::rename(&tmp, S99ZKEEN_UI)
        .await
        .map_err(|e| format!("write_init_failed:{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(S99ZKEEN_UI, std::fs::Permissions::from_mode(0o755)).await;
    }
    Ok(())
}

/// Survives replacement of the current panel process: checks the new port, rolls back ARGS on failure.
/// Uses unauthenticated `/api/health` so an enabled password cannot force a false rollback (ZK-29).
/// If neither curl nor wget is available, leaves the new port in place (fail-open).
fn spawn_port_watchdog(old_port: u16, new_port: u16) -> Result<(), String> {
    let script = format!(
        r#"sleep 6
checked=0
ok=0
if command -v curl >/dev/null 2>&1; then
  checked=1
  curl -fsS -m 3 "http://127.0.0.1:{new_port}/api/health" >/dev/null 2>&1 && ok=1
elif command -v wget >/dev/null 2>&1; then
  checked=1
  wget -q -T 3 -O /dev/null "http://127.0.0.1:{new_port}/api/health" 2>/dev/null && ok=1
fi
if [ "$checked" != 1 ]; then
  exit 0
fi
if [ "$ok" != 1 ]; then
  if [ -f "{init}" ]; then
    tmp="{init}.tmp"
    sed "s/^ARGS=.*/ARGS=\"-p {old_port}\"/" "{init}" > "$tmp" && mv "$tmp" "{init}"
    chmod 755 "{init}" 2>/dev/null || true
  fi
  "{init}" restart >/dev/null 2>&1 || true
fi
"#,
        new_port = new_port,
        old_port = old_port,
        init = S99ZKEEN_UI,
    );
    Command::new("sh")
        .arg("-c")
        .arg(script)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("watchdog_spawn_failed:{e}"))?;
    Ok(())
}

async fn write_init_port(port: u16) -> Result<(), String> {
    let path = S99ZKEEN_UI;
    if !Path::new(path).exists() {
        return Err("panel_init_missing".into());
    }
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| format!("read_init_failed:{e}"))?;

    let new_args = format!("ARGS=\"-p {port}\"");
    let updated = if content.lines().any(|l| l.trim_start().starts_with("ARGS=")) {
        content
            .lines()
            .map(|line| {
                if line.trim_start().starts_with("ARGS=") {
                    new_args.clone()
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + if content.ends_with('\n') { "\n" } else { "" }
    } else {
        format!("{content}\n{new_args}\n")
    };

    let tmp = format!("{path}.tmp");
    tokio::fs::write(&tmp, &updated)
        .await
        .map_err(|e| format!("write_init_failed:{e}"))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("write_init_failed:{e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).await;
    }

    Ok(())
}

#[cfg(test)]
mod audit_regression_tests {
    use super::*;

    #[tokio::test]
    async fn occupied_port_is_rejected() {
        let listener = TcpListener::bind(("0.0.0.0", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(probe_port_free(port).await.unwrap_err(), "port_in_use");
    }
}
