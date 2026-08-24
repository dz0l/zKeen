use crate::logger::log;
use crate::types::{AppState, S99ZKEEN_UI};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use std::path::Path;
use tokio::process::Command;

#[derive(Deserialize)]
pub struct PortReq {
    port: u16,
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

    if port == state.listen_port {
        return Json(serde_json::json!({
            "success": true,
            "port": port,
            "restarted": false,
        }));
    }

    if let Err(e) = write_init_port(port).await {
        return Json(serde_json::json!({
            "success": false,
            "error": e,
        }));
    }

    log("INFO", format!("Panel port changed to {port}, restarting…"));

    if Path::new(S99ZKEEN_UI).exists() {
        let _ = Command::new(S99ZKEEN_UI)
            .arg("restart")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }

    Json(serde_json::json!({
        "success": true,
        "port": port,
        "restarted": true,
    }))
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
