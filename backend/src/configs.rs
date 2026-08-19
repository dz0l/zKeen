use crate::logger::log;
use crate::types::*;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
struct ConfigItem {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct ConfigReq {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct DeleteReq {
    file: String,
}
#[derive(Deserialize)]
pub struct RenameReq {
    file: String,
    new_file: String,
}

async fn collect_configs(paths: &[String], is_mihomo: bool) -> Vec<ConfigItem> {
    let mut results = Vec::new();
    for path_str in paths {
        let path = Path::new(path_str);
        if path.is_dir() {
            match tokio::fs::read_dir(path).await {
                Err(e) => {
                    log("ERROR", format!("Не удалось открыть директорию {}: {}", path_str, e));
                }
                Ok(mut entries) => {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let entry_path = entry.path();
                        let matches = if is_mihomo {
                            entry_path.extension().map_or(false, |e| e == "yaml" || e == "yml")
                        } else {
                            entry_path.extension().map_or(false, |e| e == "json")
                        };
                        if matches {
                            match tokio::fs::read_to_string(&entry_path).await {
                                Ok(content) => results.push(ConfigItem {
                                    file: entry_path.to_string_lossy().into(),
                                    content,
                                }),
                                Err(e) => {
                                    log(
                                        "ERROR",
                                        format!("Не удалось прочитать файл {}: {}", entry_path.display(), e),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        } else if path.exists() {
            match tokio::fs::read_to_string(path).await {
                Ok(content) => results.push(ConfigItem {
                    file: path_str.clone(),
                    content,
                }),
                Err(e) => {
                    log("ERROR", format!("Не удалось прочитать файл {}: {}", path_str, e));
                }
            }
        } else {
            log("WARN", format!("Файл не найден: {}", path_str));
        }
    }
    results.sort_by(|a, b| a.file.cmp(&b.file));
    results.dedup_by(|a, b| a.file == b.file);
    results
}

pub async fn get_configs(
    State(state): State<AppState>, Query(parameters): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let target_core = parameters
        .get("core")
        .cloned()
        .unwrap_or_else(|| state.core.read().unwrap().name.clone());
    let is_mihomo = target_core == "mihomo";

    let core_paths = {
        let settings = state.settings.read().unwrap();
        let default_path = if is_mihomo {
            MIHOMO_CONF_DIR.to_string()
        } else {
            XRAY_CONF_DIR.to_string()
        };
        let mut paths = vec![default_path];
        let extra = if is_mihomo {
            settings.append_config_paths.mihomo.clone()
        } else {
            settings.append_config_paths.xray.clone()
        };
        paths.extend(extra);
        paths
    };

    let mut core_configs = collect_configs(&core_paths, is_mihomo).await;
    let mut lst_configs = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(XKEEN_CONF_DIR).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.extension().map_or(false, |e| e == "lst") || name == "xkeen.json" {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    lst_configs.push(ConfigItem {
                        file: path.to_string_lossy().into(),
                        content,
                    });
                }
            }
        }
    }

    lst_configs.sort_by(|a, b| a.file.cmp(&b.file));
    core_configs.append(&mut lst_configs);

    Json(serde_json::json!({ "success": true, "configs": core_configs }))
}

fn all_write_prefixes(state: &AppState) -> Vec<String> {
    let settings = state.settings.read().unwrap();
    let mut paths = vec![
        MIHOMO_CONF_DIR.to_string(),
        XRAY_CONF_DIR.to_string(),
        XKEEN_CONF_DIR.to_string(),
    ];
    paths.extend(settings.append_config_paths.mihomo.clone());
    paths.extend(settings.append_config_paths.xray.clone());
    paths.sort();
    paths.dedup();
    paths
}

fn is_path_allowed(file: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| {
        let prefix_path = Path::new(prefix.as_str());
        let file_path = Path::new(file);
        if prefix_path.is_dir() {
            file_path.starts_with(prefix_path)
        } else {
            file == prefix
        }
    })
}

fn check_access(file: &str, state: &AppState) -> Result<bool, &'static str> {
    if file.contains("..") {
        return Err("Invalid path");
    }
    let prefixes = all_write_prefixes(state);
    if !is_path_allowed(file, &prefixes) {
        return Err("Path not allowed");
    }
    Ok(file.ends_with(".lst"))
}

pub async fn put_config(
    State(state): State<AppState>, Query(params): Query<HashMap<String, String>>, Json(req): Json<ConfigReq>,
) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(e) => {
            return Json(ApiResponse::<()> {
                success: false,
                error: Some(e.into()),
                data: None,
            });
        }
    };
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };

    if let Some(core_type) = params.get("validate") {
        let mut validate_files = Vec::new();
        if core_type == "mihomo" {
            validate_files.push(ConfigReq {
                file: req.file.clone(),
                content: content.clone(),
            });
        } else if core_type == "xray" {
            if let Ok(mut entries) = tokio::fs::read_dir(XRAY_CONF_DIR).await {
                let mut found_current = false;
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "json") {
                        let path_str = path.to_string_lossy().into_owned();
                        let file_content = if path_str == req.file {
                            found_current = true;
                            content.clone()
                        } else {
                            tokio::fs::read_to_string(&path).await.unwrap_or_default()
                        };
                        validate_files.push(ConfigReq {
                            file: path_str,
                            content: file_content,
                        });
                    }
                }
                if !found_current {
                    validate_files.push(ConfigReq {
                        file: req.file.clone(),
                        content: content.clone(),
                    });
                }
            } else {
                validate_files.push(ConfigReq {
                    file: req.file.clone(),
                    content: content.clone(),
                });
            }
        }

        if let Err(err_msg) = validate_core(core_type, &validate_files).await {
            log("ERROR", err_msg.clone());
            let detail = truncate_validation_error(&err_msg);
            return Json(ApiResponse::<()> {
                success: false,
                error: Some(if detail.is_empty() {
                    "Validation failed".into()
                } else {
                    format!("Validation failed: {detail}")
                }),
                data: None,
            });
        }
    }

    if fs::write(&req.file, &content).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Write error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub async fn post_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(e) => {
            return Json(ApiResponse::<()> {
                success: false,
                error: Some(e.into()),
                data: None,
            });
        }
    };
    if Path::new(&req.file).exists() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("File already exists".into()),
            data: None,
        });
    }
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };
    if fs::write(&req.file, content).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Write error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub async fn delete_config(State(state): State<AppState>, Json(req): Json<DeleteReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if fs::remove_file(&req.file).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Delete error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub async fn patch_config(State(state): State<AppState>, Json(req): Json<RenameReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if let Err(e) = check_access(&req.new_file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if Path::new(&req.new_file).exists() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("File already exists".into()),
            data: None,
        });
    }
    if fs::rename(&req.file, &req.new_file).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Rename error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

async fn validate_core(core: &str, files: &[ConfigReq]) -> Result<(), String> {
    if core == "mihomo" {
        let content = files
            .iter()
            .find(|f| {
                f.file.ends_with(".yaml")
                    || f.file.ends_with(".yml")
                    || f.file.ends_with("config.yaml")
            })
            .map(|f| f.content.as_str())
            .unwrap_or(&files[0].content);

        let validate_path = Path::new(MIHOMO_CONF_DIR).join(".zkeen-validate.yaml");
        tokio::fs::create_dir_all(MIHOMO_CONF_DIR)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(&validate_path, content)
            .await
            .map_err(|e| e.to_string())?;

        let mut cmd = tokio::process::Command::new("mihomo");
        cmd.args(["-t", "-f"]).arg(&validate_path);
        cmd.env("CLASH_HOME_DIR", MIHOMO_CONF_DIR);

        let output = cmd.output().await;
        _ = tokio::fs::remove_file(&validate_path).await;

        let output = output.map_err(|e| e.to_string())?;
        if output.status.success() {
            return Ok(());
        }

        let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        return Err(combined);
    }

    let temp_dir = std::env::temp_dir().join(format!(
        "xkeen-validate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| e.to_string())?;

    for item in files {
        let Some(name) = Path::new(&item.file).file_name() else {
            continue;
        };
        if let Err(e) = tokio::fs::write(temp_dir.join(name), &item.content).await {
            _ = tokio::fs::remove_dir_all(&temp_dir).await;
            return Err(e.to_string());
        }
    }

    let mut cmd = tokio::process::Command::new("xray");
    cmd.args(["-test", "-confdir"]).arg(&temp_dir);
    cmd.env("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR);

    let output = cmd.output().await;
    _ = tokio::fs::remove_dir_all(&temp_dir).await;

    let output = output.map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Err(combined)
}

fn truncate_validation_error(raw: &str) -> String {
    let lines: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let tail: Vec<&str> = lines.iter().copied().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect();
    let summary = tail.join(" · ");
    if summary.len() > 240 {
        summary.chars().rev().take(240).collect::<String>().chars().rev().collect()
    } else {
        summary
    }
}
