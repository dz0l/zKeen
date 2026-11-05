use crate::logger::log;
use crate::types::{AppState, S99ZKEEN_UI};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};
use tokio::net::TcpListener;
use tokio::process::Command;

/// Temporary copy of this binary that runs the port watchdog; init scripts kill by
/// process name `zkeen-ui`, so the watchdog must run under a different name (ZK-29).
const WATCHDOG_PREFIX: &str = "zkeen-port-watchdog-";
const WATCHDOG_STALE_AFTER: Duration = Duration::from_secs(3600);

fn port_backup_path() -> String {
    format!("{S99ZKEEN_UI}.zkeen-port-backup")
}

#[derive(Deserialize)]
pub struct PortReq {
    port: u16,
}

/// Unauthenticated liveness probe for local watchdog / load balancers.
/// `version` lets the self-update watchdog tell the NEW process from the old one (ZK-21).
pub async fn get_health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true, "version": crate::types::VERSION }))
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

    // Exact durable copy of the previous init: the watchdog restores it if the new
    // port never answers, even after a power loss in the middle of the restart (ZK-29).
    if let Err(e) = write_file_atomic(&port_backup_path(), &previous_init, 0o600).await {
        return Json(serde_json::json!({
            "success": false,
            "error": e,
        }));
    }

    if let Err(e) = write_init_port(port).await {
        let _ = tokio::fs::remove_file(port_backup_path()).await;
        return Json(serde_json::json!({
            "success": false,
            "error": e,
        }));
    }

    if !Path::new(S99ZKEEN_UI).exists() {
        let _ = restore_init_content(&previous_init).await;
        let _ = tokio::fs::remove_file(port_backup_path()).await;
        return Json(serde_json::json!({
            "success": false,
            "error": "panel_init_missing",
        }));
    }

    cleanup_stale_port_watchdogs().await;

    // The watchdog must be alive BEFORE the restart takes this process down.
    let (mut watchdog, watchdog_exe) = match spawn_port_watchdog(port, &port_backup_path()).await {
        Ok(v) => v,
        Err(e) => {
            let _ = restore_init_content(&previous_init).await;
            let _ = tokio::fs::remove_file(port_backup_path()).await;
            return Json(serde_json::json!({
                "success": false,
                "error": e,
            }));
        }
    };

    log("INFO", format!("Panel port changed to {port}, restarting…"));
    match Command::new(S99ZKEEN_UI)
        .arg("restart")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => Json(serde_json::json!({
            "success": true,
            "port": port,
            "restarted": true,
        })),
        Err(e) => {
            log("ERROR", format!("Не удалось запустить restart панели: {e}"));
            let _ = watchdog.kill().await;
            let _ = tokio::fs::remove_file(&watchdog_exe).await;
            let _ = restore_init_content(&previous_init).await;
            let _ = tokio::fs::remove_file(port_backup_path()).await;
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
    write_file_atomic(S99ZKEEN_UI, content, 0o755).await
}

/// Atomic write + fsync of file and parent directory; used for init script and its backup.
pub(crate) async fn write_file_atomic(path: &str, content: &str, mode: u32) -> Result<(), String> {
    let path_buf = PathBuf::from(path);
    let tmp = format!("{path}.tmp");
    let content = content.to_string();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &path_buf)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path_buf, std::fs::Permissions::from_mode(mode))?;
        }
        if let Some(dir) = path_buf.parent() {
            std::fs::File::open(dir)?.sync_all()?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("write_init_failed:{e}"))?
    .map_err(|e| format!("write_init_failed:{e}"))
}

async fn wait_panel_health(client: &reqwest::Client, url: &str, attempts: u32) -> bool {
    for _ in 0..attempts {
        match client.get(url).send().await {
            Ok(r) if r.status().is_success() => return true,
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
    false
}

/// Copy of the panel binary that watches the port change from outside the restarted
/// process: on success it removes the init backup and itself; on failure it restores
/// the previous init from the backup and restarts the panel on the old port (ZK-29).
pub async fn run_port_watchdog(port: u16, backup: &Path) -> Result<(), String> {
    let own_exe = std::env::current_exe().unwrap_or_default();
    tokio::time::sleep(Duration::from_secs(6)).await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("watchdog_client:{e}"))?;
    let url = format!("http://127.0.0.1:{port}/api/health");
    if wait_panel_health(&client, &url, 12).await {
        let _ = tokio::fs::remove_file(backup).await;
        let _ = tokio::fs::remove_file(&own_exe).await;
        return Ok(());
    }

    log("WARN", format!("Панель не отвечает на порту {port} — откат init скрипта"));
    let content = tokio::fs::read_to_string(backup)
        .await
        .map_err(|e| format!("watchdog_rollback:{e}"))?;
    write_file_atomic(S99ZKEEN_UI, &content, 0o755).await?;
    let restarted = Command::new(S99ZKEEN_UI)
        .arg("restart")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    if !restarted {
        // Keep the backup so a later run can retry the rollback.
        return Err("watchdog_rollback:restart".into());
    }
    let mut alive = false;
    for _ in 0..10 {
        let ok = Command::new(S99ZKEEN_UI)
            .arg("status")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            alive = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !alive {
        return Err("watchdog_rollback:status".into());
    }
    let _ = tokio::fs::remove_file(backup).await;
    let _ = tokio::fs::remove_file(&own_exe).await;
    Ok(())
}

/// Spawn the watchdog before the panel restart: returns the child so the caller can
/// kill it (and drop the binary copy) if the restart itself never starts.
async fn spawn_port_watchdog(port: u16, backup: &str) -> Result<(tokio::process::Child, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| format!("watchdog_spawn_failed:{e}"))?;
    let copy = PathBuf::from(format!("/opt/tmp/{WATCHDOG_PREFIX}{}", std::process::id()));
    let dst = copy.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        std::fs::copy(&exe, &dst)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::File::open(&dst)?.sync_all()
    })
    .await
    .map_err(|e| format!("watchdog_spawn_failed:{e}"))?
    .map_err(|e| format!("watchdog_spawn_failed:{e}"))?;

    match Command::new(&copy)
        .arg("port-watchdog")
        .arg("--port")
        .arg(port.to_string())
        .arg("--backup")
        .arg(backup)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => Ok((child, copy)),
        Err(e) => {
            let _ = std::fs::remove_file(&copy);
            Err(format!("watchdog_spawn_failed:{e}"))
        }
    }
}

/// Remove watchdog binary copies orphaned by killed panel processes.
async fn cleanup_stale_port_watchdogs() {
    let Ok(mut entries) = tokio::fs::read_dir("/opt/tmp").await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(WATCHDOG_PREFIX) {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .is_some_and(|age| age > WATCHDOG_STALE_AFTER);
        if stale {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
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

    write_file_atomic(path, &updated, 0o755).await
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

    #[tokio::test]
    async fn health_wait_succeeds_when_panel_answers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = conn.read(&mut buf).await;
            conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{port}/api/health");
        assert!(wait_panel_health(&client, &url, 3).await);
    }

    #[tokio::test]
    async fn health_wait_fails_on_dead_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{port}/api/health");
        assert!(!wait_panel_health(&client, &url, 1).await);
    }
}
