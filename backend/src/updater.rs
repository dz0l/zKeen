use crate::types::MIHOMO_CONF_DIR;
use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Json};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const GITHUB_API: &str = "https://api.github.com/repos";
const GITHUB_RELEASE: &str = "https://github.com";

const OPT_TMP: &str = "/opt/tmp";
const OPT_SBIN: &str = "/opt/sbin";
/// Each update stages its files in its own `/opt/tmp/zkeen-update-<uuid>/`.
const OP_DIR_PREFIX: &str = "zkeen-update-";
/// Leftovers of a killed run are removed only after this age.
const STALE_AFTER: Duration = Duration::from_secs(3600);
/// Pause between body chunks before switching to the next source.
const DOWNLOAD_IDLE_SECS: u64 = 30;
/// Wall-clock budget for all download attempts of one file.
const DOWNLOAD_BUDGET_SECS: u64 = 180;
/// Keep downloads in RAM only up to this size; larger or unknown spill to disk.
const MAX_RAM_DOWNLOAD: usize = 32 * 1024 * 1024;
/// Hard cap for a single downloaded artifact (compressed).
const MAX_DOWNLOAD_BYTES: u64 = 96 * 1024 * 1024;
/// Hard cap for unpacked binary size.
const MAX_UNPACKED_BYTES: u64 = 128 * 1024 * 1024;
/// Minimal working reserve; actual artifact sizes are enforced while streaming to staging.
const UPDATE_WORK_RESERVE: u64 = 1024 * 1024;

static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Durable copy of the last update operation; a panel restart must not lose the outcome (ZK-34).
const UPDATE_STATUS_FILE: &str = "/opt/etc/xkeen/zkeen-ui-update-status.json";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct OpStatus {
    id: String,
    core: String,
    version: String,
    stage: String,
    detail: String,
    error: Option<String>,
    running: bool,
    updated_at: u64,
}

static OP_STATUS: LazyLock<Mutex<OpStatus>> = LazyLock::new(|| Mutex::new(OpStatus::default()));

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Atomic persist of the operation status (tmp + fsync + rename + dir fsync).
/// Failures are logged but never fail the update itself.
fn persist_status(s: &OpStatus) {
    let Ok(body) = serde_json::to_string(s) else {
        return;
    };
    let path = Path::new(UPDATE_STATUS_FILE);
    let tmp = path.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> {
        std::fs::write(&tmp, &body)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, path)?;
        if let Some(dir) = path.parent() {
            std::fs::File::open(dir)?.sync_all()?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        log("WARN", format!("Не удалось сохранить статус обновления: {e}"));
    }
}

fn set_stage(stage: &str, detail: &str) {
    if let Ok(mut s) = OP_STATUS.lock() {
        s.stage = stage.to_string();
        s.detail = detail.to_string();
        s.updated_at = unix_now();
        persist_status(&s);
    }
}

fn begin_op(id: String, core: &str, version: &str) {
    if let Ok(mut s) = OP_STATUS.lock() {
        *s = OpStatus {
            id,
            core: core.to_string(),
            version: version.to_string(),
            stage: "starting".into(),
            detail: String::new(),
            error: None,
            running: true,
            updated_at: unix_now(),
        };
        persist_status(&s);
    }
}

fn finish_op(error: Option<String>) {
    if let Ok(mut s) = OP_STATUS.lock() {
        s.running = false;
        s.error = error.clone();
        s.stage = if error.is_some() {
            "failed".into()
        } else {
            "done".into()
        };
        s.updated_at = unix_now();
        persist_status(&s);
    }
}

/// Persist the final outcome of an in-flight self-update (ZK-34): the process that
/// started the operation is usually dead by the time the result is known, so the
/// watchdog / boot recovery write the verdict directly to the status file.
fn record_self_update_outcome(error: Option<&str>) {
    let Ok(raw) = std::fs::read_to_string(UPDATE_STATUS_FILE) else {
        return;
    };
    let Ok(mut s) = serde_json::from_str::<OpStatus>(&raw) else {
        return;
    };
    if !s.running || s.core != "self" {
        return;
    }
    s.running = false;
    s.error = error.map(str::to_string);
    s.stage = if error.is_some() { "failed".into() } else { "done".into() };
    s.updated_at = unix_now();
    persist_status(&s);
}

/// Restore the persisted operation after a panel restart (ZK-34). A still-"running"
/// entry means the panel died mid-operation; only a pending self-update marker may
/// still be committed by recovery — everything else is reported as interrupted
/// instead of silently disappearing.
pub async fn load_persisted_status() {
    let Ok(raw) = std::fs::read_to_string(UPDATE_STATUS_FILE) else {
        return;
    };
    let mut s: OpStatus = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            log("WARN", format!("Статус обновления повреждён и сброшен: {e}"));
            return;
        }
    };
    if s.running {
        let self_pending =
            s.core == "self" && Path::new(&update_marker_path("zkeen-ui")).exists();
        if !self_pending {
            s.running = false;
            s.stage = "failed".into();
            s.error = Some("update_interrupted".into());
            s.updated_at = unix_now();
            persist_status(&s);
        }
    }
    if let Ok(mut g) = OP_STATUS.lock() {
        *g = s;
    }
}

/// Last update operation (for UI after a long wait or a reopened phone tab).
pub async fn get_update_status() -> Json<Value> {
    let s = OP_STATUS.lock().map(|g| g.clone()).unwrap_or_default();
    Json(json!({
        "success": true,
        "id": s.id,
        "core": s.core,
        "version": s.version,
        "stage": s.stage,
        "detail": s.detail,
        "error": s.error,
        "running": s.running,
        "updated_at": s.updated_at,
    }))
}

/// Held for the whole update; a concurrent request gets 409 instead of sharing staging files.
struct UpdateGuard;

impl UpdateGuard {
    fn acquire() -> Option<Self> {
        UPDATE_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| UpdateGuard)
    }
}

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATE_RUNNING.store(false, Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

enum DownloadResult {
    RAM(Vec<u8>),
    Disk(PathBuf),
}

pub fn get_repo(core: &str) -> Option<&'static str> {
    match core {
        "xray" => Some("XTLS/Xray-core"),
        "mihomo" => Some("MetaCubeX/mihomo"),
        "self" => Some("dz0l/zKeen"),
        _ => None,
    }
}

/// Read `mixed-port` from Mihomo config (default 1080). Outbound via this port
/// follows the user's Proxy selection (GitHub group / GLOBAL), unlike DIRECT.
pub fn read_mihomo_mixed_port() -> u16 {
    let path = format!("{MIHOMO_CONF_DIR}/config.yaml");
    let Ok(content) = std::fs::read_to_string(path) else {
        return 1080;
    };
    for line in content.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("mixed-port:") {
            let v = rest.split('#').next().unwrap_or(rest).trim();
            if let Ok(p) = v.parse::<u16>() {
                if p > 0 {
                    return p;
                }
            }
        }
    }
    1080
}

/// HTTP client that sends traffic through local Mihomo mixed-port (HTTP/SOCKS).
pub fn build_mihomo_proxy_client() -> Option<reqwest::Client> {
    let port = read_mihomo_mixed_port();
    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).ok()?;
    reqwest::Client::builder()
        .user_agent("zKeen-UI")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .proxy(proxy)
        .build()
        .ok()
}

/// Clients to try for GitHub: 1) via Mihomo (user proxy), 2) direct (CDN mirrors).
fn github_http_clients<'a>(direct: &'a reqwest::Client) -> Vec<reqwest::Client> {
    let mut out = Vec::with_capacity(2);
    if let Some(via) = build_mihomo_proxy_client() {
        out.push(via);
    }
    out.push(direct.clone());
    out
}

/// Latest release of the requested channel: `(version, tag, asset)`.
/// `asset` is the verified name for this architecture; `None` means the release was
/// resolved through a path that cannot enumerate assets (redirect) and the updater
/// falls back to the constructed name.
/// Errors: `no_beta_release` (beta channel, GitHub reachable, no pre-release),
/// `no_suitable_asset` (release found, but it has no binary for this architecture)
/// or `github_unreachable`.
pub async fn fetch_latest_version(
    client: &reqwest::Client, core: &str, proxies: &[String], current_ver: Option<&str>,
) -> Result<(String, String, Option<String>), &'static str> {
    let repo = get_repo(core).ok_or("unknown_core")?;
    let is_alpha = current_ver.map_or(false, |v| v.contains("alpha"));
    let mihomo_alpha = is_alpha && core == "mihomo";
    // Beta channel looks at pre-releases only, stable at regular releases only.
    let prefer_prerelease = core == "self" && ui_update_channel() == "beta";
    let has_mihomo = build_mihomo_proxy_client().is_some();

    for (i, c) in github_http_clients(client).into_iter().enumerate() {
        let via_mihomo = has_mihomo && i == 0;
        // Via Mihomo: try raw GitHub first (follows user Proxy selection), then CDN mirrors.
        // Direct client: CDN mirrors + GitHub (existing behavior).
        let empty: &[String] = &[];
        let mirror_pass: Vec<&[String]> = if via_mihomo {
            vec![empty, proxies]
        } else {
            vec![proxies]
        };
        for mirrors in mirror_pass {
            match fetch_latest_from_api(&c, repo, core, mirrors, mihomo_alpha, prefer_prerelease).await {
                Lookup::Found(v) => {
                    if via_mihomo {
                        log("INFO", "Версия получена через Mihomo mixed-port".into());
                    }
                    return Ok(v);
                }
                Lookup::NoBeta => {
                    log("INFO", "Beta-версий zKeen UI на GitHub нет".into());
                    return Err("no_beta_release");
                }
                Lookup::NoAsset => {
                    log(
                        "WARN",
                        format!("Подходящий asset для {} отсутствует в найденных релизах", std::env::consts::ARCH),
                    );
                    return Err("no_suitable_asset");
                }
                Lookup::Failed => {}
            }
            if !prefer_prerelease {
                if let Some(v) = fetch_latest_from_redirect(&c, repo, mirrors).await {
                    if via_mihomo {
                        log("INFO", "Версия получена через Mihomo mixed-port (redirect)".into());
                    }
                    return Ok((v.0, v.1, None));
                }
            }
        }
    }
    Err("github_unreachable")
}

/// Panel update channel, shared with `install.sh` (`zkeen --update`).
const UI_CHANNEL_FILE: &str = "/opt/etc/xkeen/zkeen-ui.channel";

/// Without the channel file a pre-release build stays on beta, a stable build on stable.
pub fn ui_update_channel() -> &'static str {
    match std::fs::read_to_string(UI_CHANNEL_FILE).map(|s| s.trim().to_ascii_lowercase()) {
        Ok(s) if s == "beta" => "beta",
        Ok(s) if s == "stable" => "stable",
        _ if VERSION.contains('-') => "beta",
        _ => "stable",
    }
}

pub fn set_ui_update_channel(channel: &str) -> std::io::Result<()> {
    let tmp = format!("{UI_CHANNEL_FILE}.tmp");
    std::fs::write(&tmp, format!("{channel}\n"))?;
    std::fs::rename(&tmp, UI_CHANNEL_FILE)
}

enum Lookup {
    /// `(version, tag, asset)`: asset is the verified name for this architecture when known.
    Found((String, String, Option<String>)),
    /// The release list was read, but it has no pre-release.
    NoBeta,
    /// Releases were read, but none has a usable asset for this architecture (ZK-28).
    NoAsset,
    Failed,
}

/// Expected release asset name for this router's architecture (ZK-28); a release
/// without it must not be offered as an update.
fn expected_asset_name(core: &str, tag: &str) -> Option<String> {
    let arch = std::env::consts::ARCH;
    match core {
        "self" => match arch {
            "aarch64" => Some("zkeen-ui-arm64-v8a".into()),
            "mips" if cfg!(target_endian = "little") => Some("zkeen-ui-mips32le".into()),
            "mips" => Some("zkeen-ui-mips32".into()),
            _ => None,
        },
        "xray" => match arch {
            "aarch64" => Some("Xray-linux-arm64-v8a.zip".into()),
            "mips" if cfg!(target_endian = "little") => Some("Xray-linux-mips32le.zip".into()),
            "mips" => Some("Xray-linux-mips32.zip".into()),
            _ => None,
        },
        "mihomo" => mihomo_arch_suffix().map(|m| format!("mihomo-linux-{m}-{tag}.gz")),
        _ => None,
    }
}

fn mihomo_arch_suffix() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "aarch64" => Some("arm64"),
        "mips" if cfg!(target_endian = "little") => Some("mipsle-softfloat"),
        "mips" => Some("mips-softfloat"),
        _ => None,
    }
}

/// Exact asset match for the expected name, or the alpha variant for this architecture.
fn find_matching_asset<'a>(core: &str, tag: &str, assets: &'a [GhAsset]) -> Option<&'a str> {
    if core == "mihomo" && tag == "Prerelease-Alpha" {
        let suffix = mihomo_arch_suffix()?;
        let prefix = format!("mihomo-linux-{suffix}");
        return assets
            .iter()
            .map(|a| a.name.as_str())
            .find(|n| n.contains(&prefix) && n.contains("alpha-") && n.ends_with(".gz"));
    }
    let expected = expected_asset_name(core, tag)?;
    assets.iter().find(|a| a.name == expected).map(|a| a.name.as_str())
}

fn github_url_candidates(url: &str, proxies: &[String]) -> Vec<String> {
    std::iter::once(url.to_string())
        .chain(
            proxies
                .iter()
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
                .map(|p| format!("{}/{}", p.trim_end_matches('/'), url)),
        )
        .collect()
}

async fn fetch_latest_from_api(
    client: &reqwest::Client,
    repo: &str,
    core: &str,
    proxies: &[String],
    mihomo_alpha: bool,
    prefer_prerelease: bool,
) -> Lookup {
    if !prefer_prerelease {
        let latest_url = format!("{}/{}/releases/latest", GITHUB_API, repo);
        for u in github_url_candidates(&latest_url, proxies) {
            if let Some(v) = parse_single_release_json(client, &u, core).await {
                return Lookup::Found(v);
            }
        }
    }

    let list_url = format!("{}/{}/releases?per_page=15", GITHUB_API, repo);
    for u in github_url_candidates(&list_url, proxies) {
        let res = match client
            .get(&u)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .timeout(Duration::from_secs(25))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        if res
            .headers()
            .get("content-type")
            .map_or(false, |v| v.to_str().unwrap_or("").contains("text/html"))
        {
            continue;
        }
        let rels = match res.json::<Vec<GhRelease>>().await {
            Ok(v) => v,
            Err(_) => continue,
        };

        if mihomo_alpha {
            if let Some(r) = rels.iter().find(|r| r.tag_name == "Prerelease-Alpha") {
                // Only assets matching THIS architecture are usable (ZK-28).
                if let Some(asset) = find_matching_asset(core, &r.tag_name, &r.assets) {
                    if let Some(idx) = asset.find("alpha-") {
                        let hash = asset[idx..].trim_end_matches(".gz").trim_end_matches(".zip");
                        return Lookup::Found((hash.to_string(), "Prerelease-Alpha".into(), Some(asset.to_string())));
                    }
                }
            }
        }

        if prefer_prerelease {
            // First pre-release that actually ships a binary for this architecture (ZK-28).
            return match rels
                .iter()
                .find(|r| r.prerelease && !r.tag_name.is_empty() && find_matching_asset(core, &r.tag_name, &r.assets).is_some())
            {
                Some(r) => {
                    let tag = r.tag_name.clone();
                    let asset = find_matching_asset(core, &tag, &r.assets).map(str::to_string);
                    Lookup::Found((tag.trim_start_matches('v').to_string(), tag, asset))
                }
                None if rels.iter().any(|r| r.prerelease) => Lookup::NoAsset,
                None => Lookup::NoBeta,
            };
        }

        let stable: Vec<&GhRelease> = rels
            .iter()
            .filter(|r| !r.prerelease && !r.tag_name.is_empty())
            .collect();
        if let Some(r) = stable
            .iter()
            .find(|r| find_matching_asset(core, &r.tag_name, &r.assets).is_some())
        {
            let tag = r.tag_name.clone();
            let asset = find_matching_asset(core, &tag, &r.assets).map(str::to_string);
            return Lookup::Found((tag.trim_start_matches('v').to_string(), tag, asset));
        }
        if !stable.is_empty() {
            return Lookup::NoAsset;
        }
    }
    Lookup::Failed
}

async fn parse_single_release_json(client: &reqwest::Client, url: &str, core: &str) -> Option<(String, String, Option<String>)> {
    let res = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    if res
        .headers()
        .get("content-type")
        .map_or(false, |v| v.to_str().unwrap_or("").contains("text/html"))
    {
        return None;
    }
    let r = res.json::<GhRelease>().await.ok()?;
    if r.prerelease || r.tag_name.is_empty() {
        return None;
    }
    // Release without a binary for this architecture is not an update candidate (ZK-28).
    let asset = find_matching_asset(core, &r.tag_name, &r.assets).map(str::to_string);
    let tag = r.tag_name;
    Some((tag.trim_start_matches('v').to_string(), tag, asset))
}

/// Follow `/releases/latest` redirect — works when API is blocked but github.com/proxy is reachable.
async fn fetch_latest_from_redirect(
    client: &reqwest::Client, repo: &str, proxies: &[String],
) -> Option<(String, String)> {
    let page = format!("{GITHUB_RELEASE}/{repo}/releases/latest");
    for u in github_url_candidates(&page, proxies) {
        let res = match client.get(&u).timeout(Duration::from_secs(25)).send().await {
            Ok(r) if r.status().is_success() || r.status().is_redirection() => r,
            _ => continue,
        };
        let final_url = res.url().clone();
        if let Some(tag) = tag_from_release_url(final_url.as_str()) {
            return Some((tag.trim_start_matches('v').to_string(), tag));
        }
        if let Ok(body) = res.text().await {
            if let Some(tag) = tag_from_release_html(&body) {
                return Some((tag.trim_start_matches('v').to_string(), tag));
            }
        }
    }
    None
}

fn tag_from_release_url(url: &str) -> Option<String> {
    let marker = "/releases/tag/";
    let idx = url.find(marker)?;
    let tag = url[idx + marker.len()..]
        .split(|c| c == '/' || c == '?' || c == '#')
        .next()?
        .trim();
    if tag.is_empty() {
        None
    } else if tag.starts_with('v') {
        Some(tag.to_string())
    } else {
        Some(format!("v{tag}"))
    }
}

fn tag_from_release_html(body: &str) -> Option<String> {
    for part in body.split("/releases/tag/") {
        let tag = part
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != '_')
            .next()
            .unwrap_or("")
            .trim();
        if tag.starts_with('v') && tag.contains('.') {
            return Some(tag.to_string());
        }
    }
    None
}

fn http_for_error(code: &str) -> StatusCode {
    match code {
        "update_in_progress" => StatusCode::CONFLICT,
        "unknown_core" | "arch_unsupported" | "asset_not_found" => StatusCode::BAD_REQUEST,
        "download_http_404"
        | "download_http_403"
        | "download_http_429"
        | "download_http_error"
        | "download_html"
        | "download_timeout"
        | "download_network"
        | "download_empty"
        | "download_budget"
        | "download_too_large"
        | "update_failed"
        | "github_unreachable"
        | "opkg_update_failed"
        | "jq_install_failed" => StatusCode::BAD_GATEWAY,
        "no_space" => StatusCode::INSUFFICIENT_STORAGE,
        "verify_failed" | "chmod_failed" => StatusCode::INTERNAL_SERVER_ERROR,
        "backup_failed"
        | "install_failed"
        | "unpack_failed"
        | "unpack_too_large"
        | "save_failed"
        | "restart_failed"
        | "rollback_failed"
        | "rollback_missing" => StatusCode::INTERNAL_SERVER_ERROR,
        // Local disk write failures are server-side faults, not upstream 502 (ZK-34).
        e if e.starts_with("download_write_failed") => StatusCode::INTERNAL_SERVER_ERROR,
        e if e.starts_with("init_failed")
          || e.starts_with("restart_failed")
          || e.starts_with("rollback_")
          || e.starts_with("stop_failed") => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn response(success: bool, error: Option<String>) -> (StatusCode, HeaderMap, Json<Value>) {
    let status = if success {
        StatusCode::OK
    } else {
        error
            .as_deref()
            .map(http_for_error)
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
    };
    response_with(status, success, error)
}

fn response_with(status: StatusCode, success: bool, error: Option<String>) -> (StatusCode, HeaderMap, Json<Value>) {
    let mut h = HeaderMap::new();
    h.insert(header::CONNECTION, "close".parse().unwrap());
    (status, h, Json(json!({ "success": success, "error": error })))
}

fn download_fail_code(kind: &str, status: Option<u16>) -> String {
    match kind {
        "http" => match status {
            Some(404) => "download_http_404".into(),
            Some(403) => "download_http_403".into(),
            Some(429) => "download_http_429".into(),
            _ => "download_http_error".into(),
        },
        "html" => "download_html".into(),
        "idle" => "download_timeout".into(),
        "network" => "download_network".into(),
        "empty" => "download_empty".into(),
        "write" => "download_write_failed".into(),
        "budget" => "download_budget".into(),
        "too_large" => "download_too_large".into(),
        "no_space" => "no_space".into(),
        _ => "update_failed".into(),
    }
}

fn is_no_space(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(nix::libc::ENOSPC)
}

fn write_error(error: std::io::Error, fallback: &str) -> String {
    if is_no_space(&error) {
        "no_space".into()
    } else {
        format!("{fallback}:{error}")
    }
}

fn ensure_free_space(paths: &[&str], need: u64) -> Result<(), String> {
    for p in paths {
        let path = Path::new(p);
        if !path.exists() {
            continue;
        }
        let st = rustix::fs::statvfs(path).map_err(|e| {
            log("ERROR", format!("statvfs({}) не удался: {e}", path.display()));
            String::from("space_check_failed")
        })?;
        let free = (st.f_bavail as u64).saturating_mul(st.f_frsize as u64);
        if free < need {
            log(
                "ERROR",
                format!(
                    "Мало места на {}: {:.1} МБ свободно, нужно {:.1} МБ",
                    p,
                    free as f64 / 1048576.0,
                    need as f64 / 1048576.0
                ),
            );
            return Err("no_space".into());
        }
        log(
            "INFO",
            format!("Свободно на {}: {:.1} МБ (нужно ≥ {:.1} МБ)", p, free as f64 / 1048576.0, need as f64 / 1048576.0),
        );
    }
    Ok(())
}

fn copy_limited<R: Read, W: Write>(rdr: &mut R, out: &mut W, limit: u64) -> std::io::Result<u64> {
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = rdr.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n as u64);
        if total > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unpack_too_large",
            ));
        }
        out.write_all(&buf[..n])?;
    }
    Ok(total)
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    proxies: &[String],
    tmp_path: &Path,
) -> Result<DownloadResult, String> {
    ensure_free_space(&[OPT_TMP], UPDATE_WORK_RESERVE)?;

    async fn load(
        r: reqwest::Response, path: &Path, source: &str,
    ) -> Result<DownloadResult, String> {
        let content_length = r.content_length();
        if let Some(cl) = content_length {
            if cl > MAX_DOWNLOAD_BYTES {
                log(
                    "WARN",
                    format!(
                        "Content-Length {:.1} МБ превышает лимит {:.1} МБ ({})",
                        cl as f64 / 1048576.0,
                        MAX_DOWNLOAD_BYTES as f64 / 1048576.0,
                        source
                    ),
                );
                return Err("download_too_large".into());
            }
        }

        let declared = content_length.unwrap_or(0) as usize;
        let mut use_disk = declared == 0 || declared > MAX_RAM_DOWNLOAD;
        if use_disk {
            ensure_free_space(
                &[OPT_TMP],
                content_length.unwrap_or(0).saturating_add(UPDATE_WORK_RESERVE),
            )?;
        }
        let mut stream = r.bytes_stream();
        let mut file = if use_disk {
            Some(fs::File::create(path).await.map_err(|e| write_error(e, "download_write_failed"))?)
        } else {
            None
        };
        let mut buf = if use_disk {
            Vec::new()
        } else {
            Vec::with_capacity(declared.min(MAX_RAM_DOWNLOAD).max(1024 * 1024))
        };
        let mut total: u64 = 0;

        loop {
            match tokio::time::timeout(Duration::from_secs(DOWNLOAD_IDLE_SECS), stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    total = total.saturating_add(chunk.len() as u64);
                    if total > MAX_DOWNLOAD_BYTES {
                        log("WARN", format!("Превышен лимит загрузки ({})", source));
                        if use_disk {
                            _ = fs::remove_file(path).await;
                        }
                        return Err("download_too_large".into());
                    }
                    if let Some(f) = &mut file {
                        if let Err(e) = f.write_all(&chunk).await {
                            log("WARN", format!("Ошибка записи на диск ({}): {}", source, e));
                            _ = fs::remove_file(path).await;
                            return Err(write_error(e, "download_write_failed"));
                        }
                    } else if buf.len().saturating_add(chunk.len()) > MAX_RAM_DOWNLOAD {
                        // Spill before growing past the RAM ceiling (ZK-23).
                        log(
                            "INFO",
                            format!(
                                "Сброс загрузки на диск после {:.1} МБ ({})",
                                buf.len() as f64 / 1048576.0,
                                source
                            ),
                        );
                        let mut f = fs::File::create(path)
                            .await
                            .map_err(|e| write_error(e, "download_write_failed"))?;
                        if let Err(e) = f.write_all(&buf).await {
                            _ = fs::remove_file(path).await;
                            return Err(write_error(e, "download_write_failed"));
                        }
                        if let Err(e) = f.write_all(&chunk).await {
                            _ = fs::remove_file(path).await;
                            return Err(write_error(e, "download_write_failed"));
                        }
                        buf.clear();
                        buf.shrink_to_fit();
                        file = Some(f);
                        use_disk = true;
                    } else {
                        buf.extend_from_slice(&chunk);
                    }
                }
                Ok(None) => {
                    if !use_disk && buf.is_empty() {
                        log("WARN", format!("Загрузка вернула 0 байт ({})", source));
                        return Err("download_empty".into());
                    }
                    let stored = if use_disk { total } else { buf.len() as u64 };
                    log(
                        "INFO",
                        format!(
                            "Файл загружен {} ({:.1} МБ)",
                            if use_disk { "на диск" } else { "в ОЗУ" },
                            stored as f64 / 1048576.0
                        ),
                    );
                    return Ok(if use_disk {
                        DownloadResult::Disk(path.to_path_buf())
                    } else {
                        DownloadResult::RAM(buf)
                    });
                }
                Ok(Some(Err(e))) => {
                    log("WARN", format!("Соединение оборвалось ({}): {}", source, e));
                    if use_disk {
                        _ = fs::remove_file(path).await;
                    }
                    return Err("download_network".into());
                }
                Err(_) => {
                    log(
                        "WARN",
                        format!(
                            "Таймаут простоя {} с при загрузке ({})",
                            DOWNLOAD_IDLE_SECS, source
                        ),
                    );
                    if use_disk {
                        _ = fs::remove_file(path).await;
                    }
                    return Err("download_timeout".into());
                }
            }
        }
    }

    let urls: Vec<String> = std::iter::once(url.to_string())
        .chain(proxies.iter().map(|p| format!("{}/{}", p, url)))
        .collect();
    let clients = github_http_clients(client);
    let mihomo_first = clients.len() > 1;
    let budget = Instant::now();
    let mut last_err = String::from("update_failed");

    for (ci, http) in clients.iter().enumerate() {
        let via_mihomo = mihomo_first && ci == 0;
        let via_label = if via_mihomo { "mihomo" } else { "direct" };
        for (i, u) in urls.iter().enumerate() {
            let elapsed = budget.elapsed();
            if elapsed >= Duration::from_secs(DOWNLOAD_BUDGET_SECS) {
                log(
                    "ERROR",
                    format!(
                        "Исчерпан бюджет загрузки {} с, последняя ошибка: {}",
                        DOWNLOAD_BUDGET_SECS, last_err
                    ),
                );
                return Err(if last_err == "update_failed" {
                    download_fail_code("budget", None)
                } else {
                    last_err
                });
            }
            // Hard deadline for the whole download (ZK-34): the final attempt is
            // capped by the remaining budget too, not only the idle-per-chunk timeout.
            let deadline = tokio::time::Instant::now()
                + Duration::from_secs(DOWNLOAD_BUDGET_SECS).saturating_sub(elapsed);

            let (source, is_cdn) = if i == 0 {
                (format!("напрямую/{via_label}"), false)
            } else {
                (format!("CDN/{via_label}"), true)
            };
            set_stage("downloading", &source);
            if is_cdn {
                log(
                    "INFO",
                    format!("Попытка загрузки через CDN #{} ({via_label}): {}", i, proxies[i - 1]),
                );
            } else if via_mihomo {
                log(
                    "INFO",
                    format!("Попытка загрузки через Mihomo mixed-port:{}", read_mihomo_mixed_port()),
                );
            }

            let sent = match tokio::time::timeout_at(deadline, http.get(u).send()).await {
                Ok(v) => v,
                Err(_) => {
                    log(
                        "ERROR",
                        format!("Жёсткий дедлайн загрузки {} с ({source})", DOWNLOAD_BUDGET_SECS),
                    );
                    let _ = fs::remove_file(tmp_path).await;
                    return Err(download_fail_code("budget", None));
                }
            };
            match sent {
                Ok(r) if r.status().is_success() => {
                    if r.headers()
                        .get("content-type")
                        .map_or(false, |v| v.to_str().unwrap_or("").contains("text/html"))
                    {
                        log(
                            "WARN",
                            if is_cdn {
                                format!("CDN #{} вернул HTML", i)
                            } else {
                                "URL вернул HTML".into()
                            },
                        );
                        last_err = download_fail_code("html", None);
                        continue;
                    }
                    let loaded = match tokio::time::timeout_at(deadline, load(r, tmp_path, &source)).await {
                        Ok(v) => v,
                        Err(_) => {
                            log(
                                "ERROR",
                                format!("Жёсткий дедлайн загрузки {} с ({source})", DOWNLOAD_BUDGET_SECS),
                            );
                            let _ = fs::remove_file(tmp_path).await;
                            return Err(download_fail_code("budget", None));
                        }
                    };
                    match loaded {
                        Ok(res) => return Ok(res),
                        Err(e) => {
                            last_err = e.clone();
                            // Disk / size errors will not improve on the next mirror.
                            if e == "download_too_large"
                                || e == "no_space"
                                || e.starts_with("download_write_failed")
                            {
                                log("ERROR", format!("Загрузка остановлена ({source}): {e}"));
                                return Err(e);
                            }
                        }
                    }
                }
                Ok(r) => {
                    let code = r.status().as_u16();
                    log("WARN", format!("Ошибка загрузки: {}", r.status()));
                    last_err = download_fail_code("http", Some(code));
                    // Missing asset on the real GitHub URL — mirrors will not help.
                    if !is_cdn && code == 404 {
                        log("ERROR", "Asset не найден на GitHub (404), повторы отменены".into());
                        return Err(last_err);
                    }
                    if code == 429 {
                        log("WARN", "GitHub rate limit (429), дальнейшие попытки бессмысленны".into());
                        return Err(last_err);
                    }
                }
                Err(e) => {
                    log("WARN", format!("Ошибка загрузки: {}", e));
                    last_err = download_fail_code("network", None);
                }
            }
        }
    }
    log("ERROR", format!("Не удалось выполнить обновление ({})", last_err));
    Err(last_err)
}
async fn save(dl: DownloadResult, out_path: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        match dl {
            DownloadResult::RAM(d) => {
                let mut out = File::create(&out_path)?;
                out.write_all(&d)?;
                out.sync_data()
            }
            DownloadResult::Disk(p) => {
                if std::fs::rename(&p, &out_path).is_ok() {
                    return Ok(());
                }
                std::io::copy(&mut File::open(&p)?, &mut File::create(&out_path)?)?;
                std::fs::remove_file(p)
            }
        }
    })
    .await
    .map_err(|e| format!("save_failed:{e}"))?
    .map_err(|e| write_error(e, "save_failed"))
}

/// Names this updater itself leaves behind: operation dirs and the fixed staging
fn is_own_leftover(name: &str) -> bool {
    if name.starts_with(OP_DIR_PREFIX) || name.starts_with(SELF_WATCHDOG_PREFIX) {
        return true;
    }
    if matches!(name, "bin.tmp" | "download.tmp" | "yq.tmp" | "yq.bin" | "mihomo_Prerelease-Alpha") {
        return true;
    }
    ["zkeen-ui_v", "mihomo_v", "xray_v"].iter().any(|p| {
        name.strip_prefix(p)
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    })
}

fn is_stale(meta: &std::fs::Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|age| age > STALE_AFTER)
}

/// Remove our own leftovers of interrupted runs. Other files in `/opt/tmp` are never touched;
/// `/opt/etc/mihomo/cache.db` (store-selected) is outside this directory.
async fn sweep_stale_leftovers(current: &Path) {
    let Ok(mut entries) = fs::read_dir(OPT_TMP).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path == current || !is_own_leftover(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !is_stale(&meta) {
            continue;
        }
        let removed = if meta.is_dir() {
            fs::remove_dir_all(&path).await
        } else {
            fs::remove_file(&path).await
        };
        match removed {
            Ok(()) => log("INFO", format!("Удалены остатки прерванного обновления: {}", path.display())),
            Err(e) => log("WARN", format!("Не удалось удалить {}: {}", path.display(), e)),
        }
    }
}

async fn remove_op_dir(dir: &Path) {
    match fs::remove_dir_all(dir).await {
        Ok(()) => log("INFO", "Временные файлы обновления очищены".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log("WARN", format!("Не удалось удалить {}: {}", dir.display(), e)),
    }
}

fn update_marker_path(core: &str) -> String {
    format!("{OPT_SBIN}/{core}.zkeen-updating")
}

async fn sync_file(path: &Path, code: &str) -> Result<(), String> {
    let path = path.to_path_buf();
    let code = code.to_string();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&path)?;
        file.sync_all()
    })
    .await
    .map_err(|e| format!("{code}:{e}"))?
    .map_err(|e| format!("{code}:{e}"))
}

async fn sync_parent_dir(path: &Path, code: &str) -> Result<(), String> {
    let dir = path.parent().unwrap_or_else(|| Path::new("/")).to_path_buf();
    let code = code.to_string();
    tokio::task::spawn_blocking(move || {
        let dir = std::fs::File::open(&dir)?;
        dir.sync_all()
    })
    .await
    .map_err(|e| format!("{code}:{e}"))?
    .map_err(|e| format!("{code}:{e}"))
}

async fn write_update_marker(core: &str, state: &str) -> Result<(), String> {
    // Atomic state change: a power loss must never leave a half-written marker (ZK-21).
    let marker = PathBuf::from(update_marker_path(core));
    let tmp = PathBuf::from(format!("{}.tmp", marker.display()));
    fs::write(&tmp, format!("{state}\n"))
        .await
        .map_err(|e| format!("backup_failed:{e}"))?;
    sync_file(&tmp, "backup_failed").await?;
    fs::rename(&tmp, &marker)
        .await
        .map_err(|e| format!("backup_failed:{e}"))?;
    sync_parent_dir(&marker, "backup_failed").await
}

async fn clear_update_marker(core: &str) -> Result<(), String> {
    let marker = PathBuf::from(update_marker_path(core));
    match fs::remove_file(&marker).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("backup_failed:{e}")),
    }
    sync_parent_dir(&marker, "backup_failed").await
}

async fn remove_file_durable(path: &Path, code: &str) -> Result<(), String> {
    match fs::remove_file(path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{code}:{e}")),
    }
    sync_parent_dir(path, code).await
}

/// Remove leftover permanent copies from older panel versions (`core-backup/<core>-*`).
/// After a successful update they must not remain on flash (REC-01 / ZK-23).
async fn cleanup_legacy_core_backups(core: &str) {
    let bk_dir = PathBuf::from(format!("{OPT_SBIN}/core-backup"));
    let Ok(mut entries) = fs::read_dir(&bk_dir).await else {
        return;
    };
    let prefix = format!("{core}-");
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(&prefix) {
            continue;
        }
        match fs::remove_file(entry.path()).await {
            Ok(()) => log("INFO", format!("Удалён устаревший core-backup: {}", entry.path().display())),
            Err(e) => log("WARN", format!("Не удалось удалить {}: {e}", entry.path().display())),
        }
    }
    // Drop empty directory if nothing else remains.
    if let Ok(mut left) = fs::read_dir(&bk_dir).await {
        if left.next_entry().await.ok().flatten().is_none() {
            let _ = fs::remove_dir(&bk_dir).await;
        }
    }
}

/// Move the previous core aside atomically; this avoids a second 50+ MiB copy on small UBIFS.
async fn publish_rollback(target: &Path, rollback: &Path) -> Result<(), String> {
    if rollback.exists() {
        remove_file_durable(rollback, "backup_failed").await?;
    }
    fs::rename(target, rollback)
        .await
        .map_err(|e| format!("backup_failed:{e}"))?;
    sync_parent_dir(rollback, "backup_failed").await?;
    sync_parent_dir(target, "backup_failed").await
}

async fn copy_file_synced(from: &Path, to: &Path, code: &str) -> Result<(), String> {
    let from = from.to_path_buf();
    let to_tmp = to.with_extension("zkeen-restore-tmp");
    let to_final = to.to_path_buf();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let _ = std::fs::remove_file(&to_tmp);
        std::fs::copy(&from, &to_tmp)?;
        let staged = std::fs::File::open(&to_tmp)?;
        staged.sync_all()?;
        std::fs::rename(&to_tmp, &to_final)
    })
    .await
    .map_err(|e| format!("{code}:{e}"))?
    .map_err(|e| format!("{code}:{e}"))?;
    sync_parent_dir(to, code).await
}

/// Restore `to` from `from` as a hard link + atomic rename: no extra data blocks, so the
/// restore works even when the filesystem cannot fit a second copy (ZK-21 ENOSPC).
/// Returns Ok(false) when the filesystem does not support hard links.
async fn link_file_synced(from: &Path, to: &Path, code: &str) -> Result<bool, String> {
    let from = from.to_path_buf();
    let to_tmp = to.with_extension("zkeen-restore-tmp");
    let to_final = to.to_path_buf();
    let linked = tokio::task::spawn_blocking(move || -> std::io::Result<bool> {
        let _ = std::fs::remove_file(&to_tmp);
        match std::fs::hard_link(&from, &to_tmp) {
            Ok(()) => {
                let staged = std::fs::File::open(&to_tmp)?;
                staged.sync_all()?;
                std::fs::rename(&to_tmp, &to_final)?;
                Ok(true)
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::CrossesDevices
                    || matches!(e.raw_os_error(), Some(nix::libc::EPERM) | Some(nix::libc::ENOSYS) | Some(nix::libc::EOPNOTSUPP)) =>
            {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("{code}:{e}"))?
    .map_err(|e| format!("{code}:{e}"))?;
    if linked {
        sync_parent_dir(to, code).await?;
    }
    Ok(linked)
}

/// Restore `/opt/sbin/<core>` while keeping rollback reusable until chmod/restart succeeds.
async fn restore_core_rollback(rollback: &str, target: &str, core: &str, was_running: bool) -> Result<(), String> {
    restore_core_rollback_inner(rollback, target, core, was_running).await?;
    if target.starts_with(OPT_SBIN) {
        clear_update_marker(core).await?;
    }
    let rollback_path = Path::new(rollback);
    if let Err(e) = remove_file_durable(rollback_path, "rollback_failed").await {
        log("WARN", format!("Откат выполнен, но файл {} не удалён: {e}", rollback_path.display()));
    }
    Ok(())
}

async fn restore_core_rollback_inner(
    rollback: &str, target: &str, core: &str, was_running: bool,
) -> Result<(), String> {
    let rollback_path = Path::new(rollback);
    let target_path = Path::new(target);
    if !rollback_path.exists() {
        return Err("rollback_missing".into());
    }
    log("WARN", format!("Откат {} из {}", target, rollback));
    let broken = PathBuf::from(format!("{target}.zkeen-bad"));
    if target_path.exists() {
        if broken.exists() {
            remove_file_durable(&broken, "rollback_failed").await?;
        }
        fs::rename(target_path, &broken)
            .await
            .map_err(|e| format!("rollback_failed:{e}"))?;
        sync_parent_dir(target_path, "rollback_failed").await?;
    }

    // Prefer a hard link: restoring then needs no extra data blocks, so recovery works
    // even on an almost full filesystem (ZK-21). Falls back to a copy only when the
    // filesystem cannot hard-link; the rejected binary is freed first in that case.
    let linked = match link_file_synced(rollback_path, target_path, "rollback_failed").await {
        Ok(linked) => linked,
        Err(e) => {
            log("ERROR", format!("Откат не удался: {e}"));
            if broken.exists() {
                let _ = fs::rename(&broken, target_path).await;
                let _ = sync_parent_dir(target_path, "rollback_failed").await;
            }
            return Err(e);
        }
    };
    if !linked {
        log("WARN", "Hard link не поддержан, откат копированием после освобождения отвергнутого файла".into());
        if broken.exists() {
            // Free the rejected binary so the last working version fits (ZK-21).
            remove_file_durable(&broken, "rollback_failed").await?;
        }
        if let Err(e) = copy_file_synced(rollback_path, target_path, "rollback_failed").await {
            log("ERROR", format!("Откат не удался: {e}"));
            // The rejected file is already gone; the rollback itself is intact and the
            // marker stays, so the next boot retries the restore instead of losing both.
            return Err(e);
        }
    }

    fs::set_permissions(target_path, std::fs::Permissions::from_mode(0o755))
        .await
        .map_err(|e| format!("chmod_failed:{e}"))?;
    if was_running {
        crate::controller::soft_restart(core)
            .await
            .map_err(|e| format!("rollback_restart_failed:{e}"))?;
    }
    if broken.exists() {
        remove_file_durable(&broken, "rollback_failed").await?;
    }
    Ok(())
}

/// Temporary copy of the NEW panel binary running the self-update watchdog; init stops
/// processes by name `zkeen-ui`, so the watchdog must run under a different name (ZK-21).
const SELF_WATCHDOG_PREFIX: &str = "zkeen-self-watchdog-";

/// Self-update recovery: if the panel is running at all, the installed binary is serving;
/// complete the commit the watchdog could not finish (e.g. power loss after restart).
pub async fn recover_interrupted_self_update() {
    let marker = PathBuf::from(update_marker_path("zkeen-ui"));
    if !marker.exists() {
        return;
    }
    let rollback = PathBuf::from(format!("{OPT_SBIN}/zkeen-ui.zkeen-rollback"));
    if rollback.exists() {
        match remove_file_durable(&rollback, "rollback_failed").await {
            Ok(()) => log("INFO", "Self-update подтверждён запущенной панелью, rollback удалён".into()),
            Err(e) => log("WARN", format!("Не удалось удалить rollback self-update: {e}")),
        }
    }
    match clear_update_marker("zkeen-ui").await {
        Ok(()) => log("INFO", "Маркер self-update очищен".into()),
        Err(e) => log("ERROR", format!("Не удалось очистить маркер self-update: {e}")),
    }
    record_self_update_outcome(None);
}

/// Health check that requires the expected version: the OLD still-running process must
/// not confirm the update it never performed (ZK-21).
async fn wait_self_health(client: &reqwest::Client, url: &str, expect_version: &str, attempts: u32) -> bool {
    for _ in 0..attempts {
        if let Ok(r) = client.get(url).send().await {
            if r.status().is_success() {
                if let Ok(body) = r.json::<Value>().await {
                    let served = body.get("version").and_then(|v| v.as_str()).unwrap_or("");
                    if expect_version.is_empty() || served == expect_version {
                        return true;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    false
}

/// External finisher for self-update: after the restart, confirm the NEW binary serves
/// the expected version and commit; otherwise atomically restore the previous binary,
/// restart it, and only then clean up (ZK-21).
pub async fn run_self_update_watchdog(
    rollback: &Path,
    target: &Path,
    port: u16,
    expect_version: &str,
    marker: &Path,
) -> Result<(), String> {
    let own_exe = std::env::current_exe().unwrap_or_default();
    tokio::time::sleep(Duration::from_secs(8)).await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("watchdog_client:{e}"))?;
    let url = format!("http://127.0.0.1:{port}/api/health");

    if wait_self_health(&client, &url, expect_version, 15).await {
        if let Err(e) = remove_file_durable(rollback, "rollback_failed").await {
            log("WARN", format!("Commit self-update: rollback не удалён: {e}"));
        }
        if let Err(e) = remove_file_durable(marker, "backup_failed").await {
            log("WARN", format!("Commit self-update: маркер не удалён: {e}"));
        }
        record_self_update_outcome(None);
        let _ = fs::remove_file(&own_exe).await;
        return Ok(());
    }

    log("WARN", "Новая панель не подтвердила версию — откат self-update".into());
    if rollback.exists() {
        fs::rename(rollback, target)
            .await
            .map_err(|e| format!("rollback_failed:{e}"))?;
        sync_parent_dir(target, "rollback_failed").await?;
        fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| format!("chmod_failed:{e}"))?;
    } else {
        return Err("rollback_missing".into());
    }
    let restarted = Command::new(S99ZKEEN_UI)
        .arg("restart")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    if !restarted {
        // Keep the marker so the next boot reports the unfinished rollback.
        return Err("self_update_rollback:restart".into());
    }
    if !wait_self_health(&client, &url, "", 15).await {
        return Err("self_update_rollback:unhealthy".into());
    }
    if let Err(e) = remove_file_durable(marker, "backup_failed").await {
        log("WARN", format!("Откат self-update: маркер не удалён: {e}"));
    }
    record_self_update_outcome(Some("self_update_rollback"));
    let _ = fs::remove_file(&own_exe).await;
    Ok(())
}

/// Stage the watchdog from the verified NEW binary and spawn it before the running
/// process is replaced; returns the child so the caller can kill it on abort.
async fn spawn_self_update_watchdog(
    source: &Path,
    port: u16,
    expect_version: &str,
) -> Result<(tokio::process::Child, PathBuf), String> {
    let staged_len = std::fs::metadata(source).map(|m| m.len()).unwrap_or(0);
    ensure_free_space(&[OPT_TMP], staged_len.saturating_add(UPDATE_WORK_RESERVE))?;
    let copy = PathBuf::from(format!("{OPT_TMP}/{SELF_WATCHDOG_PREFIX}{}", std::process::id()));
    let src = source.to_path_buf();
    let dst = copy.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        std::fs::copy(&src, &dst)?;
        std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755))?;
        std::fs::File::open(&dst)?.sync_all()
    })
    .await
    .map_err(|e| format!("watchdog_spawn_failed:{e}"))?
    .map_err(|e| write_error(e, "watchdog_spawn_failed"))?;

    match Command::new(&copy)
        .arg("self-update-watchdog")
        .arg("--rollback")
        .arg(format!("{OPT_SBIN}/zkeen-ui.zkeen-rollback"))
        .arg("--target")
        .arg(format!("{OPT_SBIN}/zkeen-ui"))
        .arg("--port")
        .arg(port.to_string())
        .arg("--expect-version")
        .arg(expect_version)
        .arg("--marker")
        .arg(update_marker_path("zkeen-ui"))
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

/// Finish incomplete core updates left after power loss / crash (marker + rollback).
pub async fn recover_interrupted_core_updates() {
    for core in ["mihomo", "xray"] {
        let marker = PathBuf::from(update_marker_path(core));
        if !marker.exists() {
            continue;
        }
        let rollback = PathBuf::from(format!("{OPT_SBIN}/{core}.zkeen-rollback"));
        let target = PathBuf::from(format!("{OPT_SBIN}/{core}"));
        let state = std::fs::read_to_string(&marker).unwrap_or_default();
        let state = state.trim();

        if state == "commit" {
            if let Err(e) = remove_file_durable(&rollback, "rollback_failed").await {
                log("ERROR", format!("Cleanup rollback {core} после commit: {e}"));
                continue;
            }
            match clear_update_marker(core).await {
                Ok(()) => log("INFO", format!("Cleanup незавершённого обновления {core} выполнен")),
                Err(e) => log("ERROR", format!("Cleanup маркера обновления {core}: {e}")),
            }
            continue;
        }

        log(
            "WARN",
            format!("Обнаружено незавершённое обновление {core} — восстанавливаю предыдущую версию"),
        );
        if rollback.exists() {
            let rollback_s = rollback.to_string_lossy().into_owned();
            let target_s = target.to_string_lossy().into_owned();
            match restore_core_rollback(&rollback_s, &target_s, core, false).await {
                Ok(()) => log("INFO", format!("Откат {core} после сбоя обновления выполнен")),
                Err(e) => log("ERROR", format!("Откат {core} после сбоя обновления: {e}")),
            }
        } else if target.exists() {
            // Marker without rollback: clear only after the installed binary proves it runs;
            // a corrupted marker must not silently bless a broken core (ZK-21).
            match verify_core_binary(core).await {
                Ok(()) => match clear_update_marker(core).await {
                    Ok(()) => log("WARN", format!("Маркер {core} относился к подготовке обновления и очищен")),
                    Err(e) => log("ERROR", format!("Не удалось очистить маркер {core}: {e}")),
                },
                Err(e) => log(
                    "ERROR",
                    format!("Маркер {core} без rollback, бинарник не проходит проверку ({e}) — восстановление отложено"),
                ),
            }
        } else {
            log(
                "ERROR",
                format!("Маркер обновления {core} без rollback и рабочего бинарника — восстановление отложено"),
            );
        }
    }
}

/// Confirm the installed binary at least runs and prints a version line.
async fn verify_core_binary(core: &str) -> Result<(), String> {
    let bin = format!("{OPT_SBIN}/{core}");
    let mut cmd = Command::new(&bin);
    if core == "mihomo" {
        cmd.arg("-v");
    } else {
        cmd.arg("version");
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = match tokio::time::timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("verify_failed:{e}")),
        Err(_) => return Err("verify_failed:timeout".into()),
    };
    if !out.status.success() {
        return Err(format!(
            "verify_failed:exit:{}",
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
        ));
    }
    if out.stdout.is_empty() && out.stderr.is_empty() {
        return Err("verify_failed:empty".into());
    }
    Ok(())
}

/// Run `mihomo -t` against the live config when present (catches wrong arch/config beyond `-v`).
async fn verify_core_config(core: &str) -> Result<(), String> {
    if core != "mihomo" {
        return Ok(());
    }
    let cfg = Path::new(crate::types::MIHOMO_CONF_DIR).join("config.yaml");
    if !cfg.exists() {
        return Ok(());
    }
    let bin = format!("{OPT_SBIN}/{core}");
    let mut cmd = Command::new(&bin);
    cmd.args(["-t", "-f"]).arg(&cfg);
    cmd.env("CLASH_HOME_DIR", crate::types::MIHOMO_CONF_DIR);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = match tokio::time::timeout(Duration::from_secs(20), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("verify_failed:config:{e}")),
        Err(_) => return Err("verify_failed:config:timeout".into()),
    };
    if !out.status.success() {
        return Err("verify_failed:config".into());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MihomoController {
    Tcp { port: u16, secret: String },
    Unix { path: PathBuf, secret: String },
}

fn parse_yaml_scalar(raw: &str) -> String {
    let mut value = raw.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        let quote = bytes[0] as char;
        if (quote == '\'' || quote == '"') && bytes[value.len() - 1] as char == quote {
            value = &value[1..value.len() - 1];
            return if quote == '\'' {
                value.replace("''", "'")
            } else {
                value.replace("\\\"", "\"").replace("\\\\", "\\")
            };
        }
    }
    let mut out = String::new();
    for (idx, ch) in value.char_indices() {
        if ch == '#' && idx > 0 && value[..idx].ends_with(char::is_whitespace) {
            break;
        }
        out.push(ch);
    }
    let out = out.trim();
    if out == "null" || out == "~" { String::new() } else { out.to_string() }
}

fn yaml_top_level_scalar(content: &str, key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let trimmed = line.trim_start();
        if line.len() != trimmed.len() || trimmed.starts_with('#') {
            return None;
        }
        trimmed
            .strip_prefix(key)
            .and_then(|rest| rest.strip_prefix(':'))
            .map(parse_yaml_scalar)
            .filter(|value| !value.is_empty())
    })
}

pub(crate) fn read_mihomo_controller() -> Result<Option<MihomoController>, String> {
    let cfg = Path::new(crate::types::MIHOMO_CONF_DIR).join("config.yaml");
    let content = match std::fs::read_to_string(&cfg) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("verify_failed:config:{e}")),
    };
    parse_mihomo_controller(&content, Path::new(crate::types::MIHOMO_CONF_DIR))
}

fn parse_mihomo_controller(content: &str, conf_dir: &Path) -> Result<Option<MihomoController>, String> {
    let secret = yaml_top_level_scalar(content, "secret").unwrap_or_default();
    if secret.contains('\r') || secret.contains('\n') {
        return Err("verify_failed:secret".into());
    }

    if let Some(unix) = yaml_top_level_scalar(content, "external-controller-unix") {
        let path = PathBuf::from(&unix);
        let path = if path.is_absolute() { path } else { conf_dir.join(path) };
        return Ok(Some(MihomoController::Unix { path, secret }));
    }
    if let Some(addr) = yaml_top_level_scalar(content, "external-controller") {
        let Some((_, port)) = addr.rsplit_once(':') else {
            return Err("verify_failed:controller".into());
        };
        let port = port
            .trim()
            .parse::<u16>()
            .map_err(|_| "verify_failed:controller".to_string())?;
        return Ok(Some(MihomoController::Tcp { port, secret }));
    }
    Ok(None)
}

async fn verify_unix_controller(path: &Path, secret: &str) -> Result<(), String> {
    let mut stream = tokio::net::UnixStream::connect(path)
        .await
        .map_err(|e| format!("verify_failed:api:{e}"))?;
    let auth = if secret.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {secret}\r\n")
    };
    let request = format!(
        "GET /version HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{auth}\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("verify_failed:api:{e}"))?;
    let mut response = Vec::with_capacity(4096);
    stream
        .take(16 * 1024)
        .read_to_end(&mut response)
        .await
        .map_err(|e| format!("verify_failed:api:{e}"))?;
    let head = String::from_utf8_lossy(&response);
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(0);
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(format!("verify_failed:api:{status}"))
    }
}

async fn verify_mihomo_controller(client: &reqwest::Client, controller: &MihomoController) -> Result<(), String> {
    match controller {
        MihomoController::Tcp { port, secret } => {
            let url = format!("http://127.0.0.1:{port}/version");
            let mut request = client.get(&url).timeout(Duration::from_secs(2));
            if !secret.is_empty() {
                request = request.bearer_auth(secret);
            }
            match request.send().await {
                Ok(r) if r.status().is_success() => Ok(()),
                Ok(r) => Err(format!("verify_failed:api:{}", r.status())),
                Err(e) => Err(format!("verify_failed:api:{e}")),
            }
        }
        MihomoController::Unix { path, secret } => {
            tokio::time::timeout(
                Duration::from_secs(2),
                verify_unix_controller(path, secret),
            )
            .await
            .map_err(|_| "verify_failed:api:timeout".to_string())?
        }
    }
}

/// Result of asking the running Mihomo to reload a config file (ZK-08).
pub(crate) enum ReloadOutcome {
    /// The core parsed and accepted the new file (2xx on PUT /configs).
    Applied,
    /// The core answered but rejected the config — the old config is still active.
    Rejected(String),
    /// The controller did not answer at all; the caller may restart the core instead.
    Unreachable(String),
}

/// Ask the running core to reload `file`. Mihomo parses the config during reload and
/// answers with an error status for an invalid file, so 2xx proves the NEW config is
/// active — a stale process cannot confirm an apply it never performed (ZK-08).
pub(crate) async fn mihomo_reload_config(client: &reqwest::Client, file: &str) -> ReloadOutcome {
    let controller = match read_mihomo_controller() {
        Ok(Some(c)) => c,
        Ok(None) => return ReloadOutcome::Unreachable("no_controller".into()),
        Err(e) => return ReloadOutcome::Unreachable(e),
    };
    let body = json!({ "path": file, "payload": "" }).to_string();
    match controller {
        MihomoController::Tcp { port, secret } => {
            let url = format!("http://127.0.0.1:{port}/configs?reload=true");
            let mut request = client
                .put(&url)
                .timeout(Duration::from_secs(15))
                .header("Content-Type", "application/json")
                .body(body);
            if !secret.is_empty() {
                request = request.bearer_auth(secret);
            }
            match request.send().await {
                Ok(r) if r.status().is_success() => ReloadOutcome::Applied,
                Ok(r) => ReloadOutcome::Rejected(format!("http:{}", r.status())),
                Err(e) => ReloadOutcome::Unreachable(format!("{e}")),
            }
        }
        MihomoController::Unix { path, secret } => {
            let auth = if secret.is_empty() {
                String::new()
            } else {
                format!("Authorization: Bearer {secret}\r\n")
            };
            let request = format!(
                "PUT /configs?reload=true HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{auth}\r\n{body}",
                body.len()
            );
            let exchange = async {
                let mut stream = tokio::net::UnixStream::connect(&path)
                    .await
                    .map_err(|e| format!("{e}"))?;
                stream
                    .write_all(request.as_bytes())
                    .await
                    .map_err(|e| format!("{e}"))?;
                let mut response = Vec::with_capacity(4096);
                stream
                    .take(16 * 1024)
                    .read_to_end(&mut response)
                    .await
                    .map_err(|e| format!("{e}"))?;
                let head = String::from_utf8_lossy(&response);
                Ok::<u16, String>(
                    head.split_whitespace()
                        .nth(1)
                        .and_then(|v| v.parse::<u16>().ok())
                        .unwrap_or(0),
                )
            };
            match tokio::time::timeout(Duration::from_secs(15), exchange).await {
                Err(_) => ReloadOutcome::Unreachable("timeout".into()),
                Ok(Err(e)) => ReloadOutcome::Unreachable(e),
                Ok(Ok(status)) if (200..300).contains(&status) => ReloadOutcome::Applied,
                Ok(Ok(status)) => ReloadOutcome::Rejected(format!("http:{status}")),
            }
        }
    }
}

/// After restart, confirm Clash API answers through the configured TCP or Unix controller.
pub(crate) async fn verify_mihomo_api(client: &reqwest::Client) -> Result<(), String> {
    let Some(controller) = read_mihomo_controller()? else {
        log("WARN", "Mihomo external-controller не настроен — API health неприменим".into());
        return Ok(());
    };
    for _ in 0..12 {
        match verify_mihomo_controller(client, &controller).await {
            Ok(()) => return Ok(()),
            Err(_) => tokio::time::sleep(Duration::from_millis(400)).await,
        }
    }
    Err("verify_failed:api".into())
}

async fn verify_installed_core(core: &str) -> Result<(), String> {
    verify_core_binary(core).await?;
    verify_core_config(core).await
}

async fn install_jq() -> Result<(), String> {
    log("INFO", "Установка jq через opkg...".into());
    set_stage("dependency", "jq");
    let update = Command::new("opkg")
        .arg("update")
        .status()
        .await
        .map_err(|e| format!("opkg update: {}", e))?;
    if !update.success() {
        return Err("opkg_update_failed".into());
    }
    let install = Command::new("opkg")
        .args(["install", "jq"])
        .status()
        .await
        .map_err(|e| format!("opkg install jq: {}", e))?;
    if !install.success() {
        return Err("jq_install_failed".into());
    }
    log("INFO", "Пакет jq установлен".into());
    Ok(())
}

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    let Some(_guard) = UpdateGuard::acquire() else {
        log("WARN", "Обновление уже выполняется — повторный запрос отклонён".into());
        return response_with(StatusCode::CONFLICT, false, Some("update_in_progress".into()));
    };
    let op_id = uuid::Uuid::new_v4().simple().to_string();
    begin_op(op_id.clone(), &req.core, &req.version);
    let op_dir = Path::new(OPT_TMP).join(format!("{OP_DIR_PREFIX}{op_id}"));
    if let Err(e) = fs::create_dir_all(&op_dir).await {
        log("ERROR", format!("Не удалось создать {}: {}", op_dir.display(), e));
        finish_op(Some("save_failed".into()));
        return response(false, Some("save_failed".into()));
    }
    sweep_stale_leftovers(&op_dir).await;
    let res = run_update(&state, req, &op_dir).await;
    {
        let (_, _, Json(body)) = &res;
        let ok = body.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
        let err = body
            .get("error")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        finish_op(if ok { None } else { err.or(Some("update_failed".into())) });
    }
    remove_op_dir(&op_dir).await;
    res
}

async fn run_update(state: &AppState, req: UpdateReq, tmp_dir: &Path) -> (StatusCode, HeaderMap, Json<Value>) {
    let Some(repo) = get_repo(&req.core) else {
        return response(false, Some("unknown_core".into()));
    };
    let ver = if req.version.starts_with(|c: char| c.is_ascii_digit()) {
        format!("v{}", req.version)
    } else {
        req.version.clone()
    };
    let mut core_cap = req.core.clone();
    if let Some(r) = core_cap.get_mut(0..1) {
        r.make_ascii_uppercase();
    }

    log(
        "INFO",
        format!(
            "Запущено обновление {} до {}",
            if req.core == "self" { "zKeen UI" } else { &core_cap },
            ver
        ),
    );

    let proxies = state.settings.read().unwrap().updater.github_proxy.clone();
    let arch = std::env::consts::ARCH;

    if req.core == "self" {
        let arch_suffix = match arch {
            "aarch64" => "arm64-v8a",
            "mips" if cfg!(target_endian = "little") => "mips32le",
            "mips" => "mips32",
            _ => return response(false, Some("arch_unsupported".into())),
        };

        log("INFO", "Загрузка исполняемого файла...".into());
        set_stage("downloading", "zkeen-ui");
        let bin_url = format!("{GITHUB_RELEASE}/{repo}/releases/download/{ver}/zkeen-ui-{arch_suffix}");
        let bin_d = match download(
            &state.http_client,
            &bin_url,
            &proxies,
            &tmp_dir.join("bin.tmp"),
        )
        .await {
            Ok(d) => d,
            Err(e) => return response(false, Some(e)),
        };

        log("INFO", "Установка обновления...".into());
        set_stage("installing", "zkeen-ui");

        let source = tmp_dir.join(format!("zkeen-ui_{}", ver));
        if let Err(e) = save(bin_d, source.clone()).await {
            return response(false, Some(e));
        }

        let integrity_check = tokio::task::spawn_blocking({
            let source = source.clone();
            move || -> Result<(), String> {
                let meta = std::fs::metadata(&source)
                    .map_err(|e| format!("verify_file: {}", e))?;
                if meta.len() < 1024 * 1024 {
                    return Err("artifact_too_small".into());
                }
                let mut f = std::fs::File::open(&source)
                    .map_err(|e| format!("open_file: {}", e))?;
                let mut magic = [0u8; 4];
                f.read_exact(&mut magic)
                    .map_err(|e| format!("read_file: {}", e))?;
                if magic != [0x7F, b'E', b'L', b'F'] {
                    return Err("artifact_not_elf".into());
                }
                Ok(())
            }
        })
        .await
        .map_err(|e| format!("verify: {}", e))
        .and_then(|r| r);

        if let Err(e) = integrity_check {
            _ = std::fs::remove_file(&source);
            return response(false, Some(e));
        }

        let target = PathBuf::from("/opt/sbin/zkeen-ui");
        let rollback = PathBuf::from("/opt/sbin/zkeen-ui.zkeen-rollback");
        let rollback_s = rollback.to_string_lossy().into_owned();
        let target_s = target.to_string_lossy().into_owned();
        let self_core = "zkeen-ui";

        // Transactional self-update (ZK-21): durable marker + rollback + external watchdog
        // that commits or restores the previous binary after the restart.
        if let Err(e) = write_update_marker(self_core, "prepared").await {
            log("ERROR", format!("Не удалось записать маркер обновления: {e}"));
            return response(false, Some(e));
        }
        if target.exists() {
            if let Err(e) = publish_rollback(&target, &rollback).await {
                log("ERROR", format!("Не удалось подготовить rollback: {e}"));
                if rollback.exists() {
                    let _ = restore_core_rollback(&rollback_s, &target_s, self_core, false).await;
                } else {
                    let _ = clear_update_marker(self_core).await;
                }
                return response(false, Some(e));
            }
            if let Err(e) = write_update_marker(self_core, "rollback").await {
                log("ERROR", format!("Не удалось подтвердить маркер rollback: {e}"));
                let _ = restore_core_rollback(&rollback_s, &target_s, self_core, false).await;
                return response(false, Some(e));
            }
        }

        // The watchdog is staged from the NEW binary (the running one may lack the
        // command) and must be alive BEFORE this process is replaced/restarted.
        let (mut watchdog, watchdog_exe) =
            match spawn_self_update_watchdog(&source, state.listen_port, &ver).await {
                Ok(v) => v,
                Err(e) => {
                    log("ERROR", format!("Watchdog self-update не запущен: {e}"));
                    if rollback.exists() {
                        let _ = restore_core_rollback(&rollback_s, &target_s, self_core, false).await;
                    } else {
                        let _ = clear_update_marker(self_core).await;
                    }
                    return response(false, Some(e));
                }
            };

        let installed = async {
            fs::rename(&source, &target)
                .await
                .map_err(|e| format!("install_failed:{e}"))?;
            sync_parent_dir(&target, "install_failed").await?;
            fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                .await
                .map_err(|e| format!("chmod_failed:{e}"))
        }
        .await;
        if let Err(e) = installed {
            log("ERROR", format!("Установка self-update не завершена: {e}"));
            let _ = watchdog.kill().await;
            let _ = fs::remove_file(&watchdog_exe).await;
            if rollback.exists() {
                let _ = restore_core_rollback(&rollback_s, &target_s, self_core, false).await;
            } else {
                let _ = fs::remove_file(&target).await;
                let _ = clear_update_marker(self_core).await;
            }
            return response(false, Some(e));
        }

        // Short CLI: /opt/sbin/zkeen → zkeen-ui
        _ = fs::remove_file("/opt/sbin/zkeen").await;
        #[cfg(unix)]
        {
            _ = std::os::unix::fs::symlink("zkeen-ui", "/opt/sbin/zkeen");
        }
        _ = tokio::task::spawn_blocking(rustix::fs::sync).await;

        // The restart below may stop this process before post_update cleans up.
        remove_op_dir(tmp_dir).await;
        log("INFO", format!("Обновление zKeen UI до {} завершено", ver));

        if Path::new(S99ZKEEN_UI).exists() {
            log("INFO", "Перезапуск...".into());
            if let Err(e) = Command::new(S99ZKEEN_UI)
                .arg("restart")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                log("ERROR", format!("Не удалось запустить restart панели: {e}"));
                let _ = watchdog.kill().await;
                let _ = fs::remove_file(&watchdog_exe).await;
                if rollback.exists() {
                    let _ = restore_core_rollback(&rollback_s, &target_s, self_core, false).await;
                } else {
                    let _ = clear_update_marker(self_core).await;
                }
                return response(false, Some(format!("restart_failed:panel:{e}")));
            }
        } else {
            log(
                "WARN",
                "Init скрипт панели не найден, требуется ручной перезапуск".into(),
            );
        }
        return response(true, None);
    }
    let (asset, url) = match req.core.as_str() {
        "xray" => {
            let x = match arch {
                "aarch64" => "Xray-linux-arm64-v8a.zip",
                "mips" if cfg!(target_endian = "little") => "Xray-linux-mips32le.zip",
                "mips" => "Xray-linux-mips32.zip",
                _ => return response(false, Some("arch_unsupported".into())),
            };
            (x.into(), format!("{GITHUB_RELEASE}/{repo}/releases/download/{ver}/{x}"))
        }
        "mihomo" => {
            let m = match arch {
                "aarch64" => "arm64",
                "mips" if cfg!(target_endian = "little") => "mipsle-softfloat",
                "mips" => "mips-softfloat",
                _ => return response(false, Some("arch_unsupported".into())),
            };
            if ver == "Prerelease-Alpha" {
                let arch_suffix = format!("mihomo-linux-{}", m);
                let found = req
                    .assets
                    .into_iter()
                    .find(|a| a.contains(&arch_suffix) && a.ends_with(".gz"));

                match found {
                    Some(name) => (
                        name.clone(),
                        format!("{}/{}/releases/download/{}/{}", GITHUB_RELEASE, repo, ver, name),
                    ),
                    None => {
                        return response(false, Some("asset_not_found".into()));
                    }
                }
            } else {
                let n = format!("mihomo-linux-{}-{}.gz", m, ver);
                (
                    n.clone(),
                    format!("{}/{}/releases/download/{}/{}", GITHUB_RELEASE, repo, ver, n),
                )
            }
        }
        _ => return response(false, Some("unknown_core".into())),
    };

    match req.core.as_str() {
        "xray" if !Path::new("/opt/bin/jq").exists() => {
            log("WARN", "Пакет jq не найден".into());
            if let Err(e) = install_jq().await {
                return response(false, Some(e));
            }
        }
        // yq is not used by the Mihomo update path (gz unpack is done in-process).
        // Installing it here previously masked download failures as a generic mihomo update error.
        _ => {}
    }

    log("INFO", format!("Загрузка: {}", url));
    set_stage("downloading", &asset);
    let dl_res = match download(
        &state.http_client,
        &url,
        &proxies,
        &tmp_dir.join("download.tmp"),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return response(false, Some(e)),
    };

    log("INFO", "Установка обновления...".into());
    set_stage("unpacking", &asset);
    let (core_name, is_zip) = (req.core.clone(), asset.ends_with(".zip"));

    fn unpack<R: Read + Seek>(rdr: R, out_path: &Path, core: &str, is_zip: bool) -> std::io::Result<()> {
        let mut out = File::create(out_path)?;
        if is_zip {
            let mut z = zip::ZipArchive::new(rdr)?;
            let mut entry = z.by_name(core)?;
            copy_limited(&mut entry, &mut out, MAX_UNPACKED_BYTES)?;
        } else {
            let mut gz = flate2::read::GzDecoder::new(rdr);
            copy_limited(&mut gz, &mut out, MAX_UNPACKED_BYTES)?;
        }
        out.sync_data()?;
        Ok(())
    }

    let bin = tmp_dir.join(format!("{}_{}", core_name, ver));
    let unpack = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        match dl_res {
            DownloadResult::RAM(d) => unpack(Cursor::new(d), &bin, &core_name, is_zip)?,
            DownloadResult::Disk(p) => {
                unpack(File::open(&p)?, &bin, &core_name, is_zip)?;
                _ = std::fs::remove_file(p);
            }
        };
        Ok(())
    })
    .await;

    match unpack {
        Ok(Ok(())) => {}
        Ok(Err(e)) if e.to_string().contains("unpack_too_large") => {
            return response(false, Some("unpack_too_large".into()));
        }
        Ok(Err(e)) if is_no_space(&e) => {
            return response(false, Some("no_space".into()));
        }
        Ok(Err(e)) => {
            return response(false, Some(format!("unpack_failed:{e}")));
        }
        Err(e) => {
            return response(false, Some(format!("unpack_failed:{e}")));
        }
    }

    set_stage("installing", &req.core);
    let target = PathBuf::from(format!("{OPT_SBIN}/{}", req.core));
    // Single rollback file for this operation (REC-01). Deleted only after verified health.
    let rollback = PathBuf::from(format!("{OPT_SBIN}/{}.zkeen-rollback", req.core));
    let source = tmp_dir.join(format!("{}_{}", req.core, ver));
    let was_running = !crate::controller::get_pid(&req.core).is_empty();
    let marker = update_marker_path(&req.core);
    let rollback_s = rollback.to_string_lossy().into_owned();
    let target_s = target.to_string_lossy().into_owned();

    if Path::new(&marker).exists() {
        return response(false, Some("update_in_progress".into()));
    }
    if let Err(e) = write_update_marker(&req.core, "prepared").await {
        log("ERROR", format!("Не удалось записать маркер обновления: {e}"));
        return response(false, Some(e));
    }

    if target.exists() {
        if let Err(e) = publish_rollback(&target, &rollback).await {
            log("ERROR", format!("Не удалось подготовить rollback: {e}"));
            // rename(target, rollback) may already have succeeded while the fsync failed;
            // restore it instead of orphaning the rollback with no marker.
            if rollback.exists() {
                if let Err(re) =
                    restore_core_rollback(&rollback_s, &target_s, &req.core, false).await
                {
                    log("ERROR", format!("Откат после ошибки backup: {re}"));
                }
            } else {
                let _ = clear_update_marker(&req.core).await;
            }
            return response(false, Some(e));
        }
        log("INFO", format!("Rollback-копия: {}", rollback.display()));
        // Permanent core-backup/… is never created (REC-01 / ZK-23): only this transactional rollback.
        if let Err(e) = write_update_marker(&req.core, "rollback").await {
            log("ERROR", format!("Не удалось подтвердить маркер rollback: {e}"));
            if let Err(re) = restore_core_rollback(&rollback_s, &target_s, &req.core, false).await {
                log("ERROR", format!("Откат после ошибки маркера: {re}"));
            }
            return response(false, Some(e));
        }
    }

    let installed = match fs::rename(&source, &target).await {
        Ok(()) => {
            let install = async {
                sync_parent_dir(&target, "install_failed").await?;
                fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                    .await
                    .map_err(|e| format!("chmod_failed:{e}"))
            }
            .await;
            match install {
                Ok(()) => Ok(()),
                Err(e) => {
                    log("ERROR", format!("Установка после rename не завершена: {e}"));
                    if rollback.exists() {
                        let _ = restore_core_rollback(&rollback_s, &target_s, &req.core, false).await;
                    } else {
                        let _ = fs::remove_file(&target).await;
                        let _ = clear_update_marker(&req.core).await;
                    }
                    Err(e)
                }
            }
        }
        Err(_) => {
            log("WARN", "Атомарная замена не удалась, фолбек на копирование...".into());
            if was_running {
                log("INFO", "Остановка XKeen...".into());
                if let Err(e) = crate::controller::run_init_command(state, &["stop"]).await {
                    log("ERROR", format!("Остановка перед установкой не удалась: {e}"));
                    if rollback.exists() {
                        if let Err(re) =
                            restore_core_rollback(&rollback_s, &target_s, &req.core, false).await
                        {
                            log("ERROR", format!("Восстановление после отказа stop: {re}"));
                            return response(false, Some(format!("{e};{re}")));
                        }
                    } else if let Err(re) = clear_update_marker(&req.core).await {
                        return response(false, Some(format!("{e};{re}")));
                    }
                    return response(false, Some(e));
                }
            }
            let copied = async {
                fs::copy(&source, &target)
                    .await
                    .map_err(|e| write_error(e, "install_failed"))?;
                sync_file(&target, "install_failed").await?;
                sync_parent_dir(&target, "install_failed").await?;
                fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                    .await
                    .map_err(|e| format!("chmod_failed:{e}"))
            }
            .await;
            match copied {
                Ok(()) => {
                    let _ = fs::remove_file(&source).await;
                    Ok(())
                }
                Err(e) => {
                    log("ERROR", format!("Не удалось установить бинарник: {e}"));
                    if rollback.exists() {
                        if let Err(re) =
                            restore_core_rollback(&rollback_s, &target_s, &req.core, was_running).await
                        {
                            log("ERROR", format!("Откат после install_failed: {re}"));
                            return response(false, Some(format!("{e};{re}")));
                        }
                    } else {
                        let _ = fs::remove_file(&target).await;
                        let _ = clear_update_marker(&req.core).await;
                    }
                    Err(e)
                }
            }
        }
    };

    if let Err(e) = installed {
        return response(false, Some(e));
    }

    // Always verify binary (+ config test) before dropping rollback (covers was_running=false).
    set_stage("verifying", &req.core);
    if let Err(e) = verify_installed_core(&req.core).await {
        log("ERROR", format!("Проверка нового бинарника не прошла: {e}"));
        match restore_core_rollback(&rollback_s, &target_s, &req.core, was_running).await {
            Ok(()) => return response(false, Some(e)),
            Err(re) => return response(false, Some(format!("{e};{re}"))),
        }
    }

    if was_running {
        log("INFO", format!("Перезапуск {}...", core_cap));
        set_stage("restarting", &req.core);
        let restart_ok = match crate::controller::soft_restart(&req.core).await {
            Ok(()) => true,
            Err(e) => {
                log("WARN", format!("soft_restart не удался ({}), пробуем init start", e));
                match crate::controller::run_init_command(state, &["start", "on"]).await {
                    Ok(()) => crate::controller::wait_core_running(&req.core, 20, 250)
                        .await
                        .is_ok(),
                    Err(e2) => {
                        log("ERROR", format!("init start после обновления: {}", e2));
                        false
                    }
                }
            }
        };
        if !restart_ok {
            match restore_core_rollback(&rollback_s, &target_s, &req.core, true).await {
                Ok(()) => return response(false, Some("restart_failed".into())),
                Err(re) => return response(false, Some(format!("restart_failed:{re}"))),
            }
        }
        if req.core == "mihomo" {
            if let Err(e) = verify_mihomo_api(&state.http_client).await {
                log("ERROR", format!("Clash API после обновления недоступен: {e}"));
                match restore_core_rollback(&rollback_s, &target_s, &req.core, true).await {
                    Ok(()) => return response(false, Some(e)),
                    Err(re) => return response(false, Some(format!("{e};{re}"))),
                }
            }
        }
    }

    // Health confirmed — commit: marker first, then remove the rollback file.
    // If the commit state cannot be persisted, keep BOTH the marker ("rollback") and the
    // rollback file so boot recovery can still restore the last working version (ZK-21).
    if let Err(e) = write_update_marker(&req.core, "commit").await {
        log("ERROR", format!("Не удалось записать commit-маркер: {e}"));
        return response(false, Some(e));
    }
    if let Err(e) = clear_update_marker(&req.core).await {
        // Recovery finishes cleanup from the "commit" state on next boot.
        log("WARN", format!("Не удалось очистить маркер обновления: {e}"));
    }
    if rollback.exists() {
        match remove_file_durable(&rollback, "rollback_failed").await {
            Ok(()) => log("INFO", format!("Rollback-файл удалён: {}", rollback.display())),
            // A stale rollback without a marker is harmless; recover() will not touch it.
            Err(e) => log("WARN", format!("Не удалось удалить {}: {}", rollback.display(), e)),
        }
    }
    cleanup_legacy_core_backups(&req.core).await;

    log("INFO", format!("Обновление {} до {} завершено", core_cap, ver));
    {
        let mut c = state.update_checker.core_outdated.write().unwrap();
        *c = false;
    }
    {
        let mut c = state.update_checker.last_core_check.write().unwrap();
        *c = None;
    }
    *state.update_checker.last_core_toast.write().unwrap() = None;

    response(true, None)
}

#[cfg(test)]
mod audit_regression_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn copy_limited_accepts_limit_and_rejects_larger_input() {
        let mut exact = Cursor::new(vec![7u8; 1024]);
        let mut exact_out = Vec::new();
        assert_eq!(copy_limited(&mut exact, &mut exact_out, 1024).unwrap(), 1024);
        assert_eq!(exact_out.len(), 1024);

        let mut oversized = Cursor::new(vec![9u8; 1025]);
        let mut oversized_out = Vec::new();
        let error = copy_limited(&mut oversized, &mut oversized_out, 1024).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), "unpack_too_large");
    }

    #[tokio::test]
    async fn rollback_rename_restores_previous_binary() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("audit-test-rollback");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("mihomo");
        let rollback = root.join("mihomo.zkeen-rollback");
        std::fs::write(&target, b"new-binary").unwrap();
        std::fs::write(&rollback, b"old-binary").unwrap();

        restore_core_rollback(
            rollback.to_str().unwrap(),
            target.to_str().unwrap(),
            "mihomo",
            false,
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"old-binary");
        assert!(!rollback.exists());
        assert!(!root.join("mihomo.zkeen-bad").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn inner_restore_keeps_rollback_until_wrapper_cleanup() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("audit-test-rollback-inner");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("xray");
        let rollback = root.join("xray.zkeen-rollback");
        std::fs::write(&target, b"broken-binary").unwrap();
        std::fs::write(&rollback, b"good-binary").unwrap();

        restore_core_rollback_inner(
            rollback.to_str().unwrap(),
            target.to_str().unwrap(),
            "xray",
            false,
        )
        .await
        .unwrap();

        // The rollback file must survive the restore itself so a crash between
        // restore and cleanup can still recover (ZK-21).
        assert_eq!(std::fs::read(&target).unwrap(), b"good-binary");
        assert_eq!(std::fs::read(&rollback).unwrap(), b"good-binary");
        assert!(!root.join("xray.zkeen-bad").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn controller_parser_tcp_with_secret() {
        let content = "mixed-port: 1080\nexternal-controller: 0.0.0.0:9090 # api\nsecret: \"tok#en\"\n";
        let parsed = parse_mihomo_controller(content, Path::new("/opt/etc/mihomo"))
            .unwrap()
            .expect("tcp controller");
        assert_eq!(
            parsed,
            MihomoController::Tcp {
                port: 9090,
                secret: "tok#en".into(),
            }
        );
    }

    #[test]
    fn controller_parser_unix_relative_path() {
        let content = "external-controller-unix: 'run/mihomo.sock'\nsecret: 's#t'\n";
        let parsed = parse_mihomo_controller(content, Path::new("/opt/etc/mihomo"))
            .unwrap()
            .expect("unix controller");
        assert_eq!(
            parsed,
            MihomoController::Unix {
                path: PathBuf::from("/opt/etc/mihomo/run/mihomo.sock"),
                secret: "s#t".into(),
            }
        );
    }

    #[test]
    fn controller_parser_absent() {
        let parsed = parse_mihomo_controller("mixed-port: 1080\n", Path::new("/opt/etc/mihomo")).unwrap();
        assert_eq!(parsed, None);
    }

    #[tokio::test]
    async fn unix_controller_verify_sends_secret() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("audit-test-unix-sock");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let sock = root.join("ctrl.sock");
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();

        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 1024];
            while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = conn.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
                if req.len() > 4096 {
                    break;
                }
            }
            let req = String::from_utf8_lossy(&req).into_owned();
            assert!(req.starts_with("GET /version HTTP/1.1"), "request: {req}");
            assert!(req.contains("Authorization: Bearer s3cr3t\r\n"), "request: {req}");
            conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap();
            drop(conn);
            req
        });

        let controller = MihomoController::Unix {
            path: sock.clone(),
            secret: "s3cr3t".into(),
        };
        let client = reqwest::Client::new();
        verify_mihomo_controller(&client, &controller).await.unwrap();
        server.await.unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    // ZK-34: the persisted status must round-trip and tolerate older files
    // without the newer fields (serde default).
    #[test]
    fn op_status_serde_roundtrip_and_legacy_default() {
        let s = OpStatus {
            id: "op1".into(),
            core: "mihomo".into(),
            version: "v1.2.3".into(),
            stage: "done".into(),
            detail: String::new(),
            error: None,
            running: false,
            updated_at: 42,
        };
        let body = serde_json::to_string(&s).unwrap();
        let back: OpStatus = serde_json::from_str(&body).unwrap();
        assert_eq!(back.id, "op1");
        assert_eq!(back.updated_at, 42);

        let legacy: OpStatus = serde_json::from_str(
            r#"{"id":"op2","core":"self","version":"v0.1.9-beta.1","stage":"downloading","detail":"","error":null,"running":true}"#,
        )
        .unwrap();
        assert!(legacy.running);
        assert_eq!(legacy.updated_at, 0);
    }

    // ZK-34: local disk write failures are server faults (500), not upstream 502.
    #[test]
    fn write_failure_is_not_bad_gateway() {
        assert_eq!(
            http_for_error("download_write_failed"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            http_for_error("download_write_failed:No space left on device"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(http_for_error("no_space"), StatusCode::INSUFFICIENT_STORAGE);
        assert_eq!(http_for_error("download_budget"), StatusCode::BAD_GATEWAY);
    }
}
