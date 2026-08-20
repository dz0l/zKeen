use crate::types::MIHOMO_CONF_DIR;
use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Json};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const GITHUB_API: &str = "https://api.github.com/repos";
const GITHUB_RELEASE: &str = "https://github.com";

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

pub async fn fetch_latest_version(
    client: &reqwest::Client, core: &str, proxies: &[String], current_ver: Option<&str>,
) -> Option<(String, String)> {
    let repo = get_repo(core)?;
    let is_alpha = current_ver.map_or(false, |v| v.contains("alpha"));
    let mihomo_alpha = is_alpha && core == "mihomo";
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
            if let Some(v) = fetch_latest_from_api(&c, repo, mirrors, mihomo_alpha).await {
                if via_mihomo {
                    log("INFO", "Версия получена через Mihomo mixed-port".into());
                }
                return Some(v);
            }
            if let Some(v) = fetch_latest_from_redirect(&c, repo, mirrors).await {
                if via_mihomo {
                    log("INFO", "Версия получена через Mihomo mixed-port (redirect)".into());
                }
                return Some(v);
            }
        }
    }
    None
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
    client: &reqwest::Client, repo: &str, proxies: &[String], mihomo_alpha: bool,
) -> Option<(String, String)> {
    let latest_url = format!("{}/{}/releases/latest", GITHUB_API, repo);
    for u in github_url_candidates(&latest_url, proxies) {
        if let Some(v) = parse_single_release_json(client, &u).await {
            return Some(v);
        }
    }

    let list_url = format!("{}/{}/releases?per_page=10", GITHUB_API, repo);
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
                        return Some((hash.to_string(), "Prerelease-Alpha".into()));
                    }
                }
            }
        }

        if let Some(r) = rels.into_iter().find(|r| !r.prerelease && !r.tag_name.is_empty()) {
            let tag = r.tag_name.clone();
            return Some((tag.trim_start_matches('v').to_string(), tag));
        }
    }
    None
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

fn response(success: bool, error: Option<String>) -> (HeaderMap, Json<Value>) {
    let mut h = HeaderMap::new();
    h.insert(header::CONNECTION, "close".parse().unwrap());
    (h, Json(json!({ "success": success, "error": error })))
}

async fn download(
    client: &reqwest::Client, url: &str, proxies: &[String], tmp_path: &Path,
) -> Result<DownloadResult, String> {
    async fn load(r: reqwest::Response, path: &Path, source: &str) -> Option<DownloadResult> {
        let size = r.content_length().unwrap_or(0) as usize;
        let (mut stream, is_disk) = (r.bytes_stream(), size > 50 * 1024 * 1024);
        let mut file = if is_disk {
            Some(fs::File::create(path).await.ok()?)
        } else {
            None
        };
        let mut buf = if is_disk {
            Vec::new()
        } else {
            Vec::with_capacity(if size > 0 { size } else { 5 * 1024 * 1024 })
        };

        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    if let Some(f) = &mut file {
                        if f.write_all(&chunk).await.is_err() {
                            log("WARN", format!("Ошибка записи на диск ({})", source));
                            _ = fs::remove_file(path);
                            return None;
                        }
                    } else {
                        buf.extend_from_slice(&chunk);
                    }
                }
                Ok(None) => {
                    if !is_disk && buf.is_empty() {
                        log("WARN", format!("Загрузка вернула 0 байт ({})", source));
                        return None;
                    }
                    log(
                        "INFO",
                        format!(
                            "Файл загружен {} ({:.1} МБ)",
                            if is_disk { "на диск" } else { "в ОЗУ" },
                            (if is_disk { size } else { buf.len() }) as f64 / 1048576.0
                        ),
                    );
                    return Some(if is_disk {
                        DownloadResult::Disk(path.to_path_buf())
                    } else {
                        DownloadResult::RAM(buf)
                    });
                }
                Ok(Some(Err(e))) => {
                    log("WARN", format!("Соединение оборвалось ({}): {}", source, e));
                    break;
                }
                Err(_) => {
                    log("WARN", format!("Таймаут загрузки ({})", source));
                    break;
                }
            }
        }
        if is_disk {
            _ = fs::remove_file(path).await;
        }
        None
    }

    let urls: Vec<String> = std::iter::once(url.to_string())
        .chain(proxies.iter().map(|p| format!("{}/{}", p, url)))
        .collect();
    let clients = github_http_clients(client);
    let mihomo_first = clients.len() > 1;
    for (ci, http) in clients.iter().enumerate() {
        let via_mihomo = mihomo_first && ci == 0;
        let via_label = if via_mihomo { "mihomo" } else { "direct" };
        for (i, u) in urls.iter().enumerate() {
            let (source, is_cdn) = if i == 0 {
                (format!("напрямую/{via_label}"), false)
            } else {
                (format!("CDN/{via_label}"), true)
            };
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
                        continue;
                    }
                    if let Some(res) = load(r, tmp_path, &source).await {
                        return Ok(res);
                    }
                }
                Ok(r) => log("WARN", format!("Ошибка загрузки: {}", r.status())),
                Err(e) => log("WARN", format!("Ошибка загрузки: {}", e)),
            }
        }
    }
    log("ERROR", "Не удалось выполнить обновление".into());
    Err("update_failed".into())
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

/// Remove known install/update leftovers under `/opt/tmp` (and archive copies in `/opt/sbin`).
/// Does not wipe the whole tmp dir — other tools may store files there.
async fn cleanup_opt_tmp() {
    let prefixes = [
        "xkeen.tar",
        "mihomo.gz",
        "zkeen-ui",
        "bin.tmp",
        "download.tmp",
        "yq.tmp",
        "yq.bin",
        "mihomo-config.default",
        "mihomo_v",
        "mihomo_",
        "xray_v",
        "xray_",
        "zkeen-ui_",
        "convert_",
    ];
    if let Ok(mut entries) = fs::read_dir("/opt/tmp").await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let remove = prefixes.iter().any(|p| name.starts_with(p))
                || name.ends_with(".tmp")
                || name.contains(".tmp.");
            if remove {
                let path = entry.path();
                if path.is_dir() {
                    _ = fs::remove_dir_all(&path).await;
                } else {
                    _ = fs::remove_file(&path).await;
                }
            }
        }
    }
    _ = fs::remove_file("/opt/sbin/xkeen.tar.gz").await;
    log("INFO", "Временные файлы обновления очищены".into());
}

async fn install_jq() -> Result<(), String> {
    log("INFO", "Установка jq через opkg...".into());
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

async fn install_yq(client: &reqwest::Client, proxies: &[String], tmp_dir: &Path) -> Result<(), String> {
    let arch = std::env::consts::ARCH;
    let url = match arch {
        "aarch64" => format!(
            "{}/mikefarah/yq/releases/latest/download/yq_linux_arm64",
            GITHUB_RELEASE
        ),
        "mips" if cfg!(target_endian = "little") => format!(
            "{}/mikefarah/yq/releases/download/v4.52.2/yq_linux_mipsle",
            GITHUB_RELEASE
        ),
        "mips" => format!(
            "{}/mikefarah/yq/releases/download/v4.52.2/yq_linux_mips",
            GITHUB_RELEASE
        ),
        _ => return Err("arch_unsupported".into()),
    };

    log("INFO", format!("Загрузка yq: {}", url));
    let dl_res = download(client, &url, proxies, &tmp_dir.join("yq.tmp")).await?;
    let target = "/opt/sbin/yq";
    if let Err(e) = save(dl_res, tmp_dir.join("yq.bin")).await {
        return Err("save_failed".to_string());
    }

    log("INFO", "Установка yq...".into());
    let src = tmp_dir.join("yq.bin");
    if fs::rename(&src, target).await.is_err() {
        fs::copy(&src, target)
            .await
            .map_err(|e| "install_failed".to_string())?;
        _ = fs::remove_file(&src).await;
    }
    _ = fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).await;
    log("INFO", "Пакет yq установлен".into());
    Ok(())
}

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
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

    let tmp_dir = Path::new("/opt/tmp");
    _ = fs::create_dir_all(tmp_dir).await;
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
        let bin_url = format!("{GITHUB_RELEASE}/{repo}/releases/download/{ver}/zkeen-ui-{arch_suffix}");
        let bin_d = match download(&state.http_client, &bin_url, &proxies, &tmp_dir.join("bin.tmp")).await {
            Ok(d) => d,
            Err(e) => return response(false, Some(e)),
        };

        log("INFO", "Установка обновления...".into());

        let source = tmp_dir.join(format!("zkeen-ui_{}", ver));
        if let Err(e) = save(bin_d, source.clone()).await {
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
            _ = fs::remove_file(tmp_dir.join("bin.tmp")).await;
            cleanup_opt_tmp().await;
            return response(false, Some(e));
        }

        let target = "/opt/sbin/zkeen-ui";
        if let Err(e) = fs::rename(&source, target).await {
            return response(false, Some("install_failed".to_string()));
        }

        _ = fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).await;
        _ = tokio::task::spawn_blocking(rustix::fs::sync).await;

        cleanup_opt_tmp().await;
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
        "mihomo" if !Path::new("/opt/sbin/yq").exists() => {
            log("WARN", "Пакет yq не найден".into());
            if let Err(e) = install_yq(&state.http_client, &proxies, tmp_dir).await {
                return response(false, Some(e));
            }
        }
        _ => {}
    }

    log("INFO", format!("Загрузка: {}", url));
    let dl_res = match download(&state.http_client, &url, &proxies, &tmp_dir.join("download.tmp")).await {
        Ok(r) => r,
        Err(e) => return response(false, Some(e)),
    };

    log("INFO", "Установка обновления...".into());
    let (core_name, is_zip) = (req.core.clone(), asset.ends_with(".zip"));

    fn unpack<R: Read + Seek>(rdr: R, out_path: &Path, core: &str, is_zip: bool) -> std::io::Result<()> {
        let mut out = File::create(out_path)?;
        if is_zip {
            std::io::copy(&mut zip::ZipArchive::new(rdr)?.by_name(core)?, &mut out)?;
        } else {
            std::io::copy(&mut flate2::read::GzDecoder::new(rdr), &mut out)?;
        }
        out.sync_data()?;
        Ok(())
    }

    let tmp_name = format!("{}_{}", core_name, ver);
    let unpack = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let bin = tmp_dir.join(&tmp_name);
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

    if let Ok(Err(e)) | Err(e) = unpack.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) {
        return response(false, Some("unpack_failed".to_string()));
    }

    let target = format!("/opt/sbin/{}", req.core);
    if req.backup_core && Path::new(&target).exists() {
        let bk = format!(
            "/opt/sbin/core-backup/{}-{}",
            req.core,
            (chrono::Utc::now() + chrono::Duration::hours(state.settings.read().unwrap().log.timezone as i64))
                .format("%Y%m%d-%H%M%S")
        );
        _ = fs::create_dir_all("/opt/sbin/core-backup").await;
        log("INFO", format!("Создание бэкапа: {}", bk));
        _ = fs::copy(&target, &bk).await;
    }

    let (run, source) = (
        !crate::controller::get_pid(&req.core).is_empty(),
        tmp_dir.join(format!("{}_{}", req.core, ver)),
    );
    if fs::rename(&source, &target).await.is_ok() {
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if run {
            log("INFO", format!("Перезапуск {}...", core_cap));
            if let Err(e) = crate::controller::soft_restart(&req.core).await {
                log("ERROR", format!("{}", e));
                return response(false, Some(format!("{}", e)));
            }
        }
    } else {
        log("WARN", "Атомарная замена не удалась, фолбек на копирование...".into());
        if run {
            log("INFO", "Остановка XKeen...".into());
            _ = crate::controller::run_init_command(&state, &["stop"]).await;
        }
        if let Err(e) = fs::copy(&source, &target).await {
            return response(false, Some("install_failed".to_string()));
        }
        _ = fs::remove_file(&source).await;
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if run {
            log("INFO", "Запуск XKeen...".into());
            _ = crate::controller::run_init_command(&state, &["start", "on"]).await;
        }
    }

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

    cleanup_opt_tmp().await;
    response(true, None)
}
