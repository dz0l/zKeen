use crate::types::MIHOMO_CONF_DIR;
use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Json};
use futures_util::StreamExt;
use serde::Deserialize;
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
use tokio::io::AsyncWriteExt;
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
/// When Content-Length is unknown, assume a modest artifact (not the hard 96+128 caps).
const UNKNOWN_DOWNLOAD_ASSUME: u64 = 32 * 1024 * 1024;

static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Default)]
struct OpStatus {
    id: String,
    core: String,
    version: String,
    stage: String,
    detail: String,
    error: Option<String>,
    running: bool,
}

static OP_STATUS: LazyLock<Mutex<OpStatus>> = LazyLock::new(|| Mutex::new(OpStatus::default()));

fn set_stage(stage: &str, detail: &str) {
    if let Ok(mut s) = OP_STATUS.lock() {
        s.stage = stage.to_string();
        s.detail = detail.to_string();
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
        };
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

/// Latest release of the requested channel: `(version, tag)`.
/// Errors: `no_beta_release` (beta channel, GitHub reachable, no pre-release) or `github_unreachable`.
pub async fn fetch_latest_version(
    client: &reqwest::Client, core: &str, proxies: &[String], current_ver: Option<&str>,
) -> Result<(String, String), &'static str> {
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
            match fetch_latest_from_api(&c, repo, mirrors, mihomo_alpha, prefer_prerelease).await {
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
                Lookup::Failed => {}
            }
            if !prefer_prerelease {
                if let Some(v) = fetch_latest_from_redirect(&c, repo, mirrors).await {
                    if via_mihomo {
                        log("INFO", "Версия получена через Mihomo mixed-port (redirect)".into());
                    }
                    return Ok(v);
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
    Found((String, String)),
    /// The release list was read, but it has no pre-release.
    NoBeta,
    Failed,
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
    proxies: &[String],
    mihomo_alpha: bool,
    prefer_prerelease: bool,
) -> Lookup {
    if !prefer_prerelease {
        let latest_url = format!("{}/{}/releases/latest", GITHUB_API, repo);
        for u in github_url_candidates(&latest_url, proxies) {
            if let Some(v) = parse_single_release_json(client, &u).await {
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
                for asset in &r.assets {
                    if let Some(idx) = asset.name.find("alpha-") {
                        let hash = asset.name[idx..].trim_end_matches(".gz").trim_end_matches(".zip");
                        return Lookup::Found((hash.to_string(), "Prerelease-Alpha".into()));
                    }
                }
            }
        }

        if prefer_prerelease {
            return match rels.iter().find(|r| r.prerelease && !r.tag_name.is_empty()) {
                Some(r) => {
                    let tag = r.tag_name.clone();
                    Lookup::Found((tag.trim_start_matches('v').to_string(), tag))
                }
                None => Lookup::NoBeta,
            };
        }

        if let Some(r) = rels.into_iter().find(|r| !r.prerelease && !r.tag_name.is_empty()) {
            let tag = r.tag_name.clone();
            return Lookup::Found((tag.trim_start_matches('v').to_string(), tag));
        }
    }
    Lookup::Failed
}

async fn parse_single_release_json(client: &reqwest::Client, url: &str) -> Option<(String, String)> {
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
    let tag = r.tag_name;
    Some((tag.trim_start_matches('v').to_string(), tag))
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
        | "download_write_failed"
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

fn current_core_bytes(core: &str) -> u64 {
    std::fs::metadata(format!("{OPT_SBIN}/{core}"))
        .map(|m| m.len())
        .unwrap_or(0)
}

/// Peak disk need: download + estimated unpack + rollback copy of the current core (ZK-23).
fn peak_update_need(download_bytes: u64, core_bytes: u64) -> u64 {
    let dl = download_bytes.min(MAX_DOWNLOAD_BYTES).max(1);
    // gzip often expands; stay within the unpack hard cap.
    let unpack_est = dl.saturating_mul(2).min(MAX_UNPACKED_BYTES).max(dl);
    dl.saturating_add(unpack_est).saturating_add(core_bytes)
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
    core_bytes: u64,
) -> Result<DownloadResult, String> {
    ensure_free_space(
        &[OPT_TMP, OPT_SBIN],
        peak_update_need(UNKNOWN_DOWNLOAD_ASSUME, core_bytes),
    )?;

    async fn load(
        r: reqwest::Response, path: &Path, source: &str, core_bytes: u64,
    ) -> Result<DownloadResult, String> {
        if let Some(cl) = r.content_length() {
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
            ensure_free_space(&[OPT_TMP, OPT_SBIN], peak_update_need(cl, core_bytes))?;
        }

        let declared = r.content_length().unwrap_or(0) as usize;
        let mut use_disk = declared == 0 || declared > MAX_RAM_DOWNLOAD;
        let mut stream = r.bytes_stream();
        let mut file = if use_disk {
            Some(fs::File::create(path).await.map_err(|_| "download_write_failed".to_string())?)
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
                            return Err("download_write_failed".into());
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
                            .map_err(|_| "download_write_failed".to_string())?;
                        f.write_all(&buf)
                            .await
                            .map_err(|_| "download_write_failed".to_string())?;
                        f.write_all(&chunk)
                            .await
                            .map_err(|_| "download_write_failed".to_string())?;
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
            if budget.elapsed() > Duration::from_secs(DOWNLOAD_BUDGET_SECS) {
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

            match http.get(u).send().await {
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
                    match load(r, tmp_path, &source, core_bytes).await {
                        Ok(res) => return Ok(res),
                        Err(e) => {
                            last_err = e.clone();
                            // Disk / size errors will not improve on the next mirror.
                            if matches!(
                                e.as_str(),
                                "download_write_failed" | "download_too_large" | "no_space"
                            ) {
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
async fn save(dl: DownloadResult, out_path: PathBuf) -> std::io::Result<()> {
    tokio::task::spawn_blocking(move || {
        let mut out = File::create(&out_path)?;
        match dl {
            DownloadResult::RAM(d) => out.write_all(&d)?,
            DownloadResult::Disk(p) => {
                std::io::copy(&mut File::open(&p)?, &mut out)?;
                _ = std::fs::remove_file(p);
            }
        }
        out.sync_data()
    })
    .await
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?
}

/// Names this updater itself leaves behind: operation dirs and the fixed staging
fn is_own_leftover(name: &str) -> bool {
    if name.starts_with(OP_DIR_PREFIX) {
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

async fn clear_update_marker(core: &str) {
    let _ = fs::remove_file(update_marker_path(core)).await;
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

/// Publish rollback via temp + fsync + rename so a power loss mid-copy cannot leave a half file.
async fn publish_rollback_copy(target: &str, rollback: &str) -> Result<(), String> {
    let tmp = format!("{rollback}.tmp");
    let _ = fs::remove_file(&tmp).await;
    fs::copy(target, &tmp)
        .await
        .map_err(|e| format!("backup_failed:{e}"))?;
    let tmp_path = tmp.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let f = std::fs::File::open(&tmp_path)?;
        f.sync_all()?;
        Ok(())
    })
    .await
    .map_err(|e| format!("backup_failed:{e}"))?
    .map_err(|e| format!("backup_failed:{e}"))?;
    fs::rename(&tmp, rollback)
        .await
        .map_err(|e| format!("backup_failed:{e}"))?;
    // Best-effort directory fsync so the rename itself survives power loss (ZK-21).
    let _ = tokio::task::spawn_blocking(|| {
        let dir = std::fs::File::open(OPT_SBIN)?;
        dir.sync_all()
    })
    .await;
    Ok(())
}

/// Restore `/opt/sbin/<core>` from the single rollback file and optionally restart.
async fn restore_core_rollback(rollback: &str, target: &str, core: &str, was_running: bool) -> Result<(), String> {
    match restore_core_rollback_inner(rollback, target, core, was_running).await {
        Ok(()) => {
            clear_update_marker(core).await;
            Ok(())
        }
        // Keep `.zkeen-updating` so the next boot can retry recovery (ZK-21).
        Err(e) => Err(e),
    }
}

async fn restore_core_rollback_inner(
    rollback: &str, target: &str, core: &str, was_running: bool,
) -> Result<(), String> {
    if !Path::new(rollback).exists() {
        return Err("rollback_missing".into());
    }
    log("WARN", format!("Откат {} из {}", target, rollback));
    let broken = format!("{target}.zkeen-bad");
    let _ = fs::rename(target, &broken).await;
    let restored = if fs::rename(rollback, target).await.is_ok() {
        true
    } else {
        match fs::copy(rollback, target).await {
            Ok(_) => {
                let _ = fs::remove_file(rollback).await;
                true
            }
            Err(e) => {
                log("ERROR", format!("Откат не удался: {e}"));
                let _ = fs::rename(&broken, target).await;
                return Err(format!("rollback_failed:{e}"));
            }
        }
    };
    if restored {
        // Keep .zkeen-bad until the restored binary is chmod'd / optionally restarted.
        fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| format!("chmod_failed:{e}"))?;
        if was_running {
            crate::controller::soft_restart(core)
                .await
                .map_err(|e| format!("rollback_restart_failed:{e}"))?;
        }
        let _ = fs::remove_file(&broken).await;
    }
    Ok(())
}

/// Finish incomplete core updates left after power loss / crash (marker + rollback).
pub async fn recover_interrupted_core_updates() {
    for core in ["mihomo", "xray"] {
        let marker = update_marker_path(core);
        if !Path::new(&marker).exists() {
            continue;
        }
        let rollback = format!("{OPT_SBIN}/{core}.zkeen-rollback");
        let target = format!("{OPT_SBIN}/{core}");
        log(
            "WARN",
            format!("Обнаружено незавершённое обновление {core} — восстанавливаю предыдущую версию"),
        );
        if Path::new(&rollback).exists() {
            match restore_core_rollback(&rollback, &target, core, false).await {
                Ok(()) => log("INFO", format!("Откат {core} после сбоя обновления выполнен")),
                Err(e) => log("ERROR", format!("Откат {core} после сбоя обновления: {e}")),
            }
        } else {
            log(
                "WARN",
                format!("Маркер обновления {core} без rollback — удаляю маркер"),
            );
            clear_update_marker(core).await;
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

fn read_mihomo_controller_port() -> Option<u16> {
    let cfg = Path::new(crate::types::MIHOMO_CONF_DIR).join("config.yaml");
    let content = std::fs::read_to_string(cfg).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("external-controller:") else {
            continue;
        };
        let addr = rest.trim().trim_matches('"').trim_matches('\'');
        let port = addr.rsplit_once(':')?.1.trim().parse().ok()?;
        return Some(port);
    }
    None
}

/// After restart, confirm Clash API answers on the configured external-controller port.
async fn verify_mihomo_api(client: &reqwest::Client) -> Result<(), String> {
    let Some(port) = read_mihomo_controller_port() else {
        return Ok(());
    };
    let url = format!("http://127.0.0.1:{port}/version");
    for _ in 0..12 {
        match client.get(&url).timeout(Duration::from_secs(2)).send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            _ => tokio::time::sleep(Duration::from_millis(400)).await,
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
            0,
        )
        .await {
            Ok(d) => d,
            Err(e) => return response(false, Some(e)),
        };

        log("INFO", "Установка обновления...".into());
        set_stage("installing", "zkeen-ui");

        let source = tmp_dir.join(format!("zkeen-ui_{}", ver));
        if let Err(_e) = save(bin_d, source.clone()).await {
            return response(false, Some("save_failed".to_string()));
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

        let target = "/opt/sbin/zkeen-ui";
        if let Err(_e) = fs::rename(&source, target).await {
            return response(false, Some("install_failed".to_string()));
        }

        _ = fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).await;
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
            _ = Command::new(S99ZKEEN_UI)
                .arg("restart")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
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

    let core_bytes = current_core_bytes(&req.core);
    log("INFO", format!("Загрузка: {}", url));
    set_stage("downloading", &asset);
    let dl_res = match download(
        &state.http_client,
        &url,
        &proxies,
        &tmp_dir.join("download.tmp"),
        core_bytes,
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

    let downloaded = match &dl_res {
        DownloadResult::RAM(b) => b.len() as u64,
        DownloadResult::Disk(p) => std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
    };
    if let Err(e) = ensure_free_space(&[OPT_TMP, OPT_SBIN], peak_update_need(downloaded.max(1), core_bytes))
    {
        return response(false, Some(e));
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
        Ok(Err(_)) | Err(_) => {
            return response(false, Some("unpack_failed".to_string()));
        }
    }

    set_stage("installing", &req.core);
    let target = format!("{OPT_SBIN}/{}", req.core);
    // Single rollback file for this operation (REC-01). Deleted only after verified health.
    let rollback = format!("{OPT_SBIN}/{}.zkeen-rollback", req.core);
    let source = tmp_dir.join(format!("{}_{}", req.core, ver));
    let was_running = !crate::controller::get_pid(&req.core).is_empty();
    let marker = update_marker_path(&req.core);

    if Path::new(&target).exists() {
        if let Err(e) = publish_rollback_copy(&target, &rollback).await {
            log("ERROR", format!("Не удалось создать rollback-копию: {}", e));
            return response(false, Some("backup_failed".into()));
        }
        log("INFO", format!("Rollback-копия: {}", rollback));
        // Permanent core-backup/… is never created (REC-01 / ZK-23): only this transactional rollback.
    }

    if let Err(e) = fs::write(&marker, b"1").await {
        log("ERROR", format!("Не удалось записать маркер обновления: {e}"));
        let _ = fs::remove_file(&rollback).await;
        return response(false, Some("backup_failed".into()));
    }
    let marker_path = marker.clone();
    let _ = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let f = std::fs::File::open(&marker_path)?;
        f.sync_all()?;
        let dir = std::fs::File::open(OPT_SBIN)?;
        dir.sync_all()?;
        Ok(())
    })
    .await;

    let installed = if fs::rename(&source, &target).await.is_ok() {
        if let Err(e) = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await {
            log("ERROR", format!("chmod после rename не удался: {e}"));
            let _ = restore_core_rollback(&rollback, &target, &req.core, false).await;
            Err("chmod_failed".to_string())
        } else {
            Ok(())
        }
    } else {
        log("WARN", "Атомарная замена не удалась, фолбек на копирование...".into());
        if was_running {
            log("INFO", "Остановка XKeen...".into());
            if let Err(e) = crate::controller::run_init_command(state, &["stop"]).await {
                log("ERROR", format!("Остановка перед установкой не удалась: {}", e));
                clear_update_marker(&req.core).await;
                let _ = fs::remove_file(&rollback).await;
                return response(false, Some(e));
            }
        }
        match fs::copy(&source, &target).await {
            Ok(_) => {
                _ = fs::remove_file(&source).await;
                if let Err(e) = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await {
                    log("ERROR", format!("chmod после copy не удался: {e}"));
                    let _ = restore_core_rollback(&rollback, &target, &req.core, was_running).await;
                    Err("chmod_failed".to_string())
                } else {
                    Ok(())
                }
            }
            Err(e) => {
                log("ERROR", format!("Не удалось скопировать бинарник: {}", e));
                if let Err(re) = restore_core_rollback(&rollback, &target, &req.core, was_running).await {
                    log("ERROR", format!("Откат после install_failed: {}", re));
                }
                Err("install_failed".to_string())
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
        match restore_core_rollback(&rollback, &target, &req.core, was_running).await {
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
            match restore_core_rollback(&rollback, &target, &req.core, true).await {
                Ok(()) => return response(false, Some("restart_failed".into())),
                Err(re) => return response(false, Some(format!("restart_failed:{re}"))),
            }
        }
        if req.core == "mihomo" {
            if let Err(e) = verify_mihomo_api(&state.http_client).await {
                log("ERROR", format!("Clash API после обновления недоступен: {e}"));
                match restore_core_rollback(&rollback, &target, &req.core, true).await {
                    Ok(()) => return response(false, Some(e)),
                    Err(re) => return response(false, Some(format!("{e};{re}"))),
                }
            }
        }
    }

    // Health confirmed — drop the rollback file, update marker, and any legacy permanent backups.
    if Path::new(&rollback).exists() {
        match fs::remove_file(&rollback).await {
            Ok(()) => log("INFO", format!("Rollback-файл удалён: {}", rollback)),
            Err(e) => log("WARN", format!("Не удалось удалить {}: {}", rollback, e)),
        }
    }
    clear_update_marker(&req.core).await;
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
}
