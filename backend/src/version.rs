use crate::logger::log;
use crate::types::{AppState, VERSION};
use crate::updater::{self, get_repo};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::cmp::Ordering;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;

const GITHUB_RELEASE: &str = "https://github.com";

pub async fn get_local_core_version(core: &str) -> Option<String> {
    let arg = if core == "mihomo" { "-v" } else { "version" };
    let mut cmd = Command::new(format!("/opt/sbin/{}", core));
    cmd.arg(arg);
    let out = timeout(Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;

    let s = String::from_utf8_lossy(&out.stdout);
    let p: Vec<&str> = s.split_whitespace().collect();

    let ver = match core {
        "xray" => p.get(1).copied(),
        "mihomo" => p.get(if p.first() == Some(&"mihomo") { 1 } else { 2 }).copied(),
        _ => None,
    }?;

    Some(if ver.starts_with('v') || ver.starts_with("alpha") {
        ver.to_string()
    } else {
        format!("v{}", ver)
    })
}

pub async fn version_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(build_version_payload(&state).await)
}

async fn build_version_payload(state: &AppState) -> serde_json::Value {
    let check = |outdated, last: &std::sync::RwLock<Option<Instant>>| {
        outdated && {
            let mut l = last.write().unwrap();
            if l.map_or(true, |t| t.elapsed().as_secs() > 86400) {
                *l = Some(Instant::now());
                true
            } else {
                false
            }
        }
    };

    let (ui, core_outdated) = (
        *state.update_checker.ui_outdated.read().unwrap(),
        *state.update_checker.core_outdated.read().unwrap(),
    );

    let current_core = state.core.read().unwrap().name.clone();

    let (xray_version, mihomo_version) = tokio::join!(get_local_core_version("xray"), get_local_core_version("mihomo"));

    let mut res = serde_json::Map::new();

    let ui_tag = state.update_checker.ui_latest_tag.read().unwrap().clone();
    let core_tag = state.update_checker.core_latest_tag.read().unwrap().clone();

    let make_link = |repo: &str, tag: Option<&str>| -> Option<String> {
        tag.map(|t| format!("{}/{}/releases/tag/{}", GITHUB_RELEASE, repo, t))
    };

    {
        let link = get_repo("self").and_then(|r| make_link(r, ui_tag.as_deref()));
        let latest = ui_tag
            .as_deref()
            .map(|t| t.trim_start_matches('v').to_string())
            .unwrap_or_else(|| VERSION.trim_start_matches('v').to_string());
        res.insert("zkeen-ui".into(), json!({
            "version": VERSION.trim_start_matches('v'),
            "latest": latest,
            "outdated": ui,
            "show_toast": check(ui, &state.update_checker.last_ui_toast),
            "link": link,
            "channel": updater::ui_update_channel(),
        }));
    }

    let make_core_obj = |v: String, repo: &str, tag: Option<&str>| -> serde_json::Value {
        let latest = tag
            .map(|t| t.trim_start_matches('v').to_string())
            .unwrap_or_else(|| v.trim_start_matches('v').to_string());
        let mut obj = json!({
            "version": v,
            "latest": latest,
            "outdated": core_outdated,
            "show_toast": check(core_outdated, &state.update_checker.last_core_toast)
        });
        if let Some(link) = make_link(repo, tag) {
            obj["link"] = json!(link);
        }
        obj
    };

    if current_core == "mihomo" {
        if let Some(v) = mihomo_version {
            if let Some(repo) = get_repo("mihomo") {
                res.insert("mihomo".into(), make_core_obj(v, repo, core_tag.as_deref()));
            }
        }
        if let Some(v) = xray_version {
            res.insert("xray".into(), json!({ "version": v }));
        }
    } else {
        if let Some(v) = xray_version {
            if let Some(repo) = get_repo("xray") {
                res.insert("xray".into(), make_core_obj(v, repo, core_tag.as_deref()));
            }
        }
        if let Some(v) = mihomo_version {
            res.insert("mihomo".into(), json!({ "version": v }));
        }
    }

    res.insert("success".into(), json!(true));
    serde_json::Value::Object(res)
}

pub fn start_update_checker(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;

            let (check_ui, check_core, proxies) = {
                let s = state.settings.read().unwrap();
                let need = |on, last: &std::sync::RwLock<Option<Instant>>, sec| {
                    on && last.read().unwrap().map_or(true, |t| t.elapsed().as_secs() > sec)
                };
                (
                    need(s.updater.auto_check_ui, &state.update_checker.last_ui_check, 14400),
                    need(s.updater.auto_check_core, &state.update_checker.last_core_check, 14400),
                    s.updater.github_proxy.clone(),
                )
            };

            if check_ui {
                let _ = refresh_ui_latest(&state, &proxies).await;
            }

            if check_core {
                let core = state.core.read().unwrap().name.clone();
                let cur_opt = get_local_core_version(&core).await;
                let cur_str = cur_opt.as_deref().map(|v| v.trim_start_matches('v'));
                if let Ok((latest, tag)) = updater::fetch_latest_version(&state.http_client, &core, &proxies, cur_str).await
                {
                    if let Some(cur) = cur_str {
                        if !cur.is_empty() {
                            *state.update_checker.core_outdated.write().unwrap() = compare_versions(&latest, cur);
                        }
                    }
                    *state.update_checker.core_latest_tag.write().unwrap() = Some(tag);
                    *state.update_checker.last_core_check.write().unwrap() = Some(Instant::now());
                }
            }
        }
    });
}

/// Check zkeen-ui in the selected channel; `Err` carries the API error code.
async fn refresh_ui_latest(state: &AppState, proxies: &[String]) -> Result<(), &'static str> {
    let cur = VERSION.trim_start_matches('v');
    let res = updater::fetch_latest_version(&state.http_client, "self", proxies, Some(cur)).await;
    let checker = &state.update_checker;
    match res {
        Ok((latest, tag)) => {
            *checker.ui_outdated.write().unwrap() = compare_versions(&latest, cur);
            *checker.ui_latest_tag.write().unwrap() = Some(tag);
            *checker.last_ui_check.write().unwrap() = Some(Instant::now());
            Ok(())
        }
        Err(code) => {
            if code == "no_beta_release" {
                *checker.ui_outdated.write().unwrap() = false;
                *checker.ui_latest_tag.write().unwrap() = None;
                *checker.last_ui_check.write().unwrap() = Some(Instant::now());
            }
            Err(code)
        }
    }
}

fn compare_versions(latest: &str, current: &str) -> bool {
    if current.to_lowercase().contains("alpha") || latest.to_lowercase().contains("alpha") {
        return latest != current;
    }
    cmp_versions(latest, current) == Ordering::Greater
}

/// `1.2.3-beta.2` → ([1, 2, 3], ["beta", "2"]); build metadata after `+` is ignored.
fn parse_version(v: &str) -> (Vec<u64>, Option<Vec<&str>>) {
    let v = v.trim().trim_start_matches('v');
    let v = v.split('+').next().unwrap_or(v);
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let nums = core.split('.').map(|s| s.parse::<u64>().unwrap_or(0)).collect();
    (nums, pre.map(|p| p.split('.').collect()))
}

/// SemVer order: `0.1.5-beta.9 < 0.1.5-beta.10 < 0.1.5 < 0.1.6-beta.1`.
fn cmp_versions(a: &str, b: &str) -> Ordering {
    let (an, ap) = parse_version(a);
    let (bn, bp) = parse_version(b);
    for i in 0..an.len().max(bn.len()) {
        let o = an.get(i).copied().unwrap_or(0).cmp(&bn.get(i).copied().unwrap_or(0));
        if o != Ordering::Equal {
            return o;
        }
    }
    match (ap, bp) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => {
            for (p, q) in x.iter().zip(y.iter()) {
                let o = match (p.parse::<u64>(), q.parse::<u64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    _ => p.cmp(q),
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
            x.len().cmp(&y.len())
        }
    }
}

#[derive(Deserialize)]
pub struct ChannelReq {
    channel: String,
}

/// Switch the zkeen-ui update channel (`stable` | `beta`); the next check uses it.
pub async fn set_channel_handler(
    State(state): State<AppState>, Json(req): Json<ChannelReq>,
) -> impl IntoResponse {
    let channel = req.channel.trim().to_ascii_lowercase();
    if channel != "beta" && channel != "stable" {
        return (StatusCode::BAD_REQUEST, Json(json!({ "success": false, "error": "invalid_channel" })));
    }
    if let Err(e) = updater::set_ui_update_channel(&channel) {
        log("ERROR", format!("Не удалось сохранить канал обновлений: {}", e));
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": "save_failed" })),
        );
    }
    *state.update_checker.ui_outdated.write().unwrap() = false;
    *state.update_checker.ui_latest_tag.write().unwrap() = None;
    *state.update_checker.last_ui_check.write().unwrap() = None;
    log("INFO", format!("Канал обновлений zKeen UI: {}", channel));
    (StatusCode::OK, Json(json!({ "success": true, "channel": channel })))
}

/// Force-refresh GitHub latest tags for UI and current core, then return `/api/version` payload.
pub async fn check_updates_handler(State(state): State<AppState>) -> impl IntoResponse {
    let proxies = state.settings.read().unwrap().updater.github_proxy.clone();
    let mut core_ok = false;

    let ui_res = refresh_ui_latest(&state, &proxies).await;
    let ui_ok = ui_res.is_ok();

    {
        let core = state.core.read().unwrap().name.clone();
        let cur_opt = get_local_core_version(&core).await;
        let cur_str = cur_opt.as_deref().map(|v| v.trim_start_matches('v'));
        if let Ok((latest, tag)) =
            updater::fetch_latest_version(&state.http_client, &core, &proxies, cur_str).await
        {
            if let Some(cur) = cur_str {
                if !cur.is_empty() {
                    *state.update_checker.core_outdated.write().unwrap() = compare_versions(&latest, cur);
                }
            }
            *state.update_checker.core_latest_tag.write().unwrap() = Some(tag);
            *state.update_checker.last_core_check.write().unwrap() = Some(Instant::now());
            core_ok = true;
        }
    }

    let mut res = build_version_payload(&state).await;
    if let Some(obj) = res.as_object_mut() {
        obj.insert("check_ok".into(), json!(ui_ok));
        obj.insert("core_check_ok".into(), json!(core_ok));
        if let Err(code) = ui_res {
            obj.insert("check_error".into(), json!(code));
        }
        obj.insert("success".into(), json!(true));
    }
    Json(res)
}
