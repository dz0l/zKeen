#!/bin/sh
set -e

# ============================================================
#  zKeen UI — install / update for Keenetic + Entware
# ============================================================

REPO_OWNER="dz0l"
REPO_NAME="zKeen"
BINARY_NAME="zkeen-ui"
INSTALL_DIR="/opt/sbin"
INIT_DIR="/opt/etc/init.d"
INIT_SCRIPT="S99zkeen-ui"
CONF_DIR="/opt/etc/xkeen"
MIHOMO_DIR="/opt/etc/mihomo"
MIHOMO_CONFIG="${MIHOMO_DIR}/config.yaml"
DEFAULT_CONFIG_URL="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install/mihomo-config.default.yaml"
XKEEN_ORIGIN_REPO="Skrill0/XKeen"
XKEEN_FORK_REPO="jameszeroX/XKeen"
XKEEN_ORIGIN_TAR="https://github.com/${XKEEN_ORIGIN_REPO}/releases/latest/download/xkeen.tar"
XKEEN_FORK_TAR="https://github.com/${XKEEN_FORK_REPO}/releases/latest/download/xkeen.tar.gz"
XKEEN_ORIGIN_INSTALL="https://raw.githubusercontent.com/${XKEEN_ORIGIN_REPO}/main/install.sh"
XKEEN_FORK_INSTALL="https://raw.githubusercontent.com/${XKEEN_FORK_REPO}/main/install.sh"
MIHOMO_REPO="MetaCubeX/mihomo"
MIHOMO_API="https://api.github.com/repos/${MIHOMO_REPO}/releases/latest"
PORT="7220"
MIN_FREE_MB=15
MIN_BINARY_BYTES=1048576
GITHUB_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { printf "${GREEN}[OK]${NC} %s\n" "$1"; }
log_warn()  { printf "${YELLOW}[!!]${NC} %s\n" "$1"; }
log_error() { printf "${RED}[ERR]${NC} %s\n" "$1"; }
log_step()  { printf "${CYAN}>>${NC} ${BOLD}%s${NC}\n" "$1"; }

die() { log_error "$1"; exit 1; }

# --- Mode / release channel ---
# Channel is remembered in CHANNEL_FILE so later --update keeps beta testers on beta.
MODE="install"
CHANNEL="stable"
CHANNEL_EXPLICIT=0
CHANNEL_FILE="${CONF_DIR}/${BINARY_NAME}.channel"
INSTALL_XKEEN=""
SKIP_XKEEN_CHECK=0
NO_INSTALL_XKEEN=0
for arg in "$@"; do
    case "$arg" in
        --update) MODE="update" ;;
        --uninstall) MODE="uninstall" ;;
        beta|--beta) CHANNEL="beta"; CHANNEL_EXPLICIT=1 ;;
        stable|--stable) CHANNEL="stable"; CHANNEL_EXPLICIT=1 ;;
        --install-xkeen) INSTALL_XKEEN=1 ;;
        --skip-xkeen-check) SKIP_XKEEN_CHECK=1 ;;
        --no-install-xkeen) NO_INSTALL_XKEEN=1 ;;
    esac
done

load_saved_channel() {
    if [ "$CHANNEL_EXPLICIT" -eq 1 ]; then
        return 0
    fi
    if [ -f "$CHANNEL_FILE" ]; then
        _saved=$(tr -d ' \t\r\n' < "$CHANNEL_FILE" 2>/dev/null || true)
        case "$_saved" in
            beta|stable) CHANNEL="$_saved" ;;
        esac
    fi
}

save_channel() {
    mkdir -p "$CONF_DIR" 2>/dev/null || true
    printf '%s\n' "$CHANNEL" > "$CHANNEL_FILE" 2>/dev/null || true
}

# Re-fetch and re-exec with /dev/tty so XKeen interactive menus work over SSH.
if [ -z "${ZKEEN_INSTALL_REEXEC:-}" ] && [ ! -t 0 ]; then
    if [ -c /dev/tty ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
        _reexec_dir="/opt/tmp"
        mkdir -p "$_reexec_dir" 2>/dev/null || _reexec_dir="/tmp"
        _reexec_script="${_reexec_dir}/zkeen-ui-install.$$.sh"
        if command -v curl >/dev/null 2>&1; then
            if curl -fsSL --connect-timeout 15 --max-time 60 \
                "https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh" \
                -o "$_reexec_script" 2>/dev/null \
                || curl -fsSLk --connect-timeout 15 --max-time 60 \
                "https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh" \
                -o "$_reexec_script" 2>/dev/null; then
                if [ -s "$_reexec_script" ]; then
                    chmod +x "$_reexec_script"
                    export ZKEEN_INSTALL_REEXEC=1
                    # shellcheck disable=SC2094
                    exec sh "$_reexec_script" "$@" </dev/tty
                fi
            fi
        fi
    fi
fi

# --- curl wrapper with CA bundle (Entware) ---
setup_curl_cacert() {
    CURL_CA_BUNDLE=""
    for _cert in \
        /opt/etc/ssl/certs/ca-certificates.crt \
        /opt/etc/ssl/cert.pem \
        /etc/ssl/cert.pem \
        /etc/ssl/certs/ca-certificates.crt; do
        if [ -f "$_cert" ]; then
            CURL_CA_BUNDLE="$_cert"
            export CURL_CA_BUNDLE
            return 0
        fi
    done
    log_warn "CA certificates not found. Install: opkg install curl ca-certificates"
    return 1
}

curl_fetch() {
    _url="$1"
    _out="$2"
    _extra="${3:-}"

    if [ -n "$CURL_CA_BUNDLE" ]; then
        _cacert="--cacert $CURL_CA_BUNDLE"
    else
        _cacert=""
    fi

    # shellcheck disable=SC2086
    if [ -n "$_out" ]; then
        curl -fSL $_cacert --connect-timeout 15 --max-time 300 \
            --retry 3 --retry-delay 5 $_extra -o "$_out" "$_url"
    else
        curl -fSL $_cacert --connect-timeout 15 --max-time 30 \
            --retry 3 --retry-delay 5 $_extra "$_url"
    fi
}

# ELF magic: 0x7f 'E' 'L' 'F' — works on BusyBox ash without od quirks
is_elf_binary() {
    _file="$1"
    _sig=$(dd if="$_file" bs=1 count=4 2>/dev/null) || return 1
    _elf=$(printf '\177ELF')
    [ "$_sig" = "$_elf" ]
}

file_head_is_text() {
    _file="$1"
    _first=$(dd if="$_file" bs=1 count=1 2>/dev/null) || return 1
    case "$_first" in
        '<'|'{'|'['|' ') return 0 ;;
    esac
    return 1
}

# ============================================================
#  Environment checks
# ============================================================

check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "Run as root"
    fi
}

check_entware() {
    if [ ! -d "/opt/etc" ]; then
        die "Entware not found. See https://github.com/Entware/Entware/wiki"
    fi
    log_info "Entware detected"
}

check_curl() {
    if ! command -v curl >/dev/null 2>&1; then
        log_warn "curl not found, installing..."
        if command -v opkg >/dev/null 2>&1; then
            opkg update >/dev/null 2>&1
            opkg install curl ca-certificates >/dev/null 2>&1 \
                || opkg install curl >/dev/null 2>&1 \
                || die "Failed to install curl"
            log_info "curl installed"
        else
            die "curl not found and opkg is unavailable"
        fi
    fi
    setup_curl_cacert || true
}

detect_arch() {
    ARCH=$(uname -m)
    case "$ARCH" in
        aarch64)
            ASSET_NAME="${BINARY_NAME}-arm64-v8a"
            ;;
        mips|mipsel)
            if [ "$(echo -n I | od -to2 | head -c 20 | awk '{print $2}')" = "00000" ]; then
                ASSET_NAME="${BINARY_NAME}-mips32"
            else
                ASSET_NAME="${BINARY_NAME}-mips32le"
            fi
            ;;
        *)
            die "Unsupported architecture: ${ARCH} (supported: aarch64, mipsle)"
            ;;
    esac
    log_info "Architecture: ${ARCH} (${ASSET_NAME})"
}

check_free_space() {
    MOUNT_POINT="/opt"
    if [ ! -d "$MOUNT_POINT" ]; then
        MOUNT_POINT="/"
    fi

    FREE_KB=$(df -k "$MOUNT_POINT" 2>/dev/null | tail -1 | awk '{print $4}')
    if [ -z "$FREE_KB" ]; then
        log_warn "Cannot determine free space, continuing..."
        return
    fi

    FREE_MB=$((FREE_KB / 1024))
    if [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
        die "Not enough space: ${FREE_MB} MB free, need at least ${MIN_FREE_MB} MB"
    fi
    log_info "Free space: ${FREE_MB} MB (min ${MIN_FREE_MB} MB)"
}

check_repo_available() {
    log_step "Checking repository..."

    REPO_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 15 \
        ${CURL_CA_BUNDLE:+--cacert "$CURL_CA_BUNDLE"} \
        "${GITHUB_API}" 2>/dev/null || echo "000")

    case "$REPO_CODE" in
        200) log_info "Repository found: ${REPO_OWNER}/${REPO_NAME}" ;;
        404) die "Repository not found: ${REPO_OWNER}/${REPO_NAME}" ;;
        403) die "GitHub API rate limit. Retry in a few minutes" ;;
        000) die "Cannot reach GitHub. Check internet/DNS" ;;
        *)   die "GitHub returned HTTP ${REPO_CODE} for repository check" ;;
    esac

    if [ "$CHANNEL" = "beta" ]; then
        RELEASE_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 15 \
            ${CURL_CA_BUNDLE:+--cacert "$CURL_CA_BUNDLE"} \
            "${GITHUB_API}/releases?per_page=1" 2>/dev/null || echo "000")
    else
        RELEASE_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 15 \
            ${CURL_CA_BUNDLE:+--cacert "$CURL_CA_BUNDLE"} \
            "${GITHUB_API}/releases/latest" 2>/dev/null || echo "000")
    fi

    case "$RELEASE_CODE" in
        200) log_info "Release API available (channel: ${CHANNEL})" ;;
        404) die "No published releases yet (tag v*.*.* required)" ;;
        403) die "GitHub API rate limit. Retry in a few minutes" ;;
        000) die "Cannot reach GitHub. Check internet/DNS" ;;
        *)   die "GitHub returned HTTP ${RELEASE_CODE} for release check" ;;
    esac
}

# Pick newest GitHub pre-release (BusyBox-safe: no jq, no awk multi-char RS).
# Prefer "prerelease": true; fallback: tag name contains -beta / -rc / -alpha.
pick_beta_tag_from_list() {
    _list="$1"
    LATEST_TAG=""

    # Split objects on '{' — works on BusyBox ash/awk/sed.
    # Pass 1: official prerelease flag
    LATEST_TAG=$(printf '%s' "$_list" | tr '{' '\n' | while IFS= read -r _block; do
        [ -n "$_block" ] || continue
        printf '%s' "$_block" | grep -q '"prerelease"[[:space:]]*:[[:space:]]*true' || continue
        _tag=$(printf '%s' "$_block" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
        if [ -n "$_tag" ]; then
            printf '%s\n' "$_tag"
            break
        fi
    done)

    if [ -n "$LATEST_TAG" ]; then
        return 0
    fi

    # Pass 2: tag-name heuristic (CI marks -beta/-rc/-alpha as Pre-release)
    LATEST_TAG=$(printf '%s' "$_list" | tr '{' '\n' | \
        sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | \
        grep -E '\-(beta|rc|alpha)' | head -1)
}

get_latest_version() {
    if [ "$CHANNEL" = "beta" ]; then
        log_step "Resolving beta (pre-release) version..."
        _list_tmp="/opt/tmp/zkeen-releases.$$.json"
        mkdir -p /opt/tmp
        if [ -n "$CURL_CA_BUNDLE" ]; then
            _cacert="--cacert $CURL_CA_BUNDLE"
        else
            _cacert=""
        fi
        # shellcheck disable=SC2086
        if ! curl -fSL $_cacert --connect-timeout 15 --max-time 60 \
            --retry 3 --retry-delay 3 \
            -H "Accept: application/vnd.github+json" \
            -o "$_list_tmp" "${GITHUB_API}/releases?per_page=30" 2>/dev/null; then
            # Retry without Accept header (some environments)
            # shellcheck disable=SC2086
            if ! curl -fSL $_cacert --connect-timeout 15 --max-time 60 \
                --retry 2 --retry-delay 3 \
                -o "$_list_tmp" "${GITHUB_API}/releases?per_page=30" 2>/dev/null; then
                rm -f "$_list_tmp"
                die "Failed to fetch releases list"
            fi
        fi
        if [ ! -s "$_list_tmp" ]; then
            rm -f "$_list_tmp"
            die "Failed to fetch releases list (empty response)"
        fi
        RELEASE_LIST=$(cat "$_list_tmp")
        rm -f "$_list_tmp"

        pick_beta_tag_from_list "$RELEASE_LIST"
        if [ -z "$LATEST_TAG" ]; then
            die "No beta/pre-release found. Publish a Pre-release tag (e.g. v0.0.24-beta.1)"
        fi

        # shellcheck disable=SC2086
        RELEASE_JSON=$(curl -sSL $_cacert --connect-timeout 10 --max-time 30 \
            -H "Accept: application/vnd.github+json" \
            "${GITHUB_API}/releases/tags/${LATEST_TAG}" 2>/dev/null) || true
        if [ -z "$RELEASE_JSON" ] || ! printf '%s' "$RELEASE_JSON" | grep -q '"tag_name"'; then
            RELEASE_JSON="{\"tag_name\":\"${LATEST_TAG}\"}"
            log_warn "Release JSON incomplete; using direct download for ${LATEST_TAG}"
        fi
        log_info "Beta version: ${LATEST_TAG}"
        return 0
    fi

    RELEASE_JSON=$(curl -s --connect-timeout 10 --max-time 15 \
        ${CURL_CA_BUNDLE:+--cacert "$CURL_CA_BUNDLE"} \
        "${GITHUB_API}/releases/latest" 2>/dev/null) \
        || die "Failed to fetch release info"

    LATEST_TAG=$(printf '%s' "$RELEASE_JSON" | \
        grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    if [ -z "$LATEST_TAG" ]; then
        die "Cannot determine latest version"
    fi
    log_info "Latest stable version: ${LATEST_TAG}"
}

resolve_download_url() {
    DOWNLOAD_URL=$(printf '%s' "$RELEASE_JSON" | tr ',' '\n' | \
        grep 'browser_download_url' | grep "/${ASSET_NAME}\"" | head -1 | \
        sed 's/^[[:space:]]*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    if [ -z "$DOWNLOAD_URL" ]; then
        DOWNLOAD_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${LATEST_TAG}/${ASSET_NAME}"
        log_warn "Asset URL not found in API response, using fallback URL"
    fi
}

get_installed_version() {
    INSTALLED_VERSION=""
    if [ -x "${INSTALL_DIR}/${BINARY_NAME}" ]; then
        INSTALLED_VERSION=$("${INSTALL_DIR}/${BINARY_NAME}" -v 2>/dev/null | head -1 | awk '{print $NF}' || true)
    fi
}

# ============================================================
#  XKeen / proxy core checks
# ============================================================

has_xkeen_binary() {
    [ -x /opt/sbin/xkeen ] || [ -d /opt/sbin/.xkeen ]
}

has_xkeen_init() {
    for _init in /opt/etc/init.d/S05xkeen /opt/etc/init.d/S99xkeen /opt/etc/init.d/S24xray; do
        if [ -f "$_init" ]; then
            return 0
        fi
    done
    return 1
}

has_mihomo_binary() {
    [ -x /opt/sbin/mihomo ]
}

has_xray_binary() {
    [ -x /opt/sbin/xray ]
}

ensure_opkg_package() {
    _pkg="$1"
    if command -v "$_pkg" >/dev/null 2>&1; then
        return 0
    fi
    if ! command -v opkg >/dev/null 2>&1; then
        return 1
    fi
    opkg update >/dev/null 2>&1 || true
    opkg install "$_pkg" >/dev/null 2>&1
}

mihomo_asset_suffix() {
    case "$ARCH" in
        aarch64) printf '%s' "arm64" ;;
        mips|mipsel)
            if [ "$(echo -n I | od -to2 | head -c 20 | awk '{print $2}')" = "00000" ]; then
                printf '%s' "mips-softfloat"
            else
                printf '%s' "mipsle-softfloat"
            fi
            ;;
        *) return 1 ;;
    esac
}

prompt_yes() {
    _prompt="$1"
    _default="${2:-n}"
    if [ -n "$INSTALL_XKEEN" ]; then
        return 0
    fi
    if [ ! -t 0 ]; then
        return 1
    fi
    if [ "$_default" = "y" ]; then
        printf "${YELLOW}[??]${NC} %s [Y/n] " "$_prompt"
    else
        printf "${YELLOW}[??]${NC} %s [y/N] " "$_prompt"
    fi
    read -r _answer
    case "$_answer" in
        [yY]|[yY][eE][sS]) return 0 ;;
        [nN]|[nN][oO]) return 1 ;;
        "")
            [ "$_default" = "y" ]
            ;;
        *) return 1 ;;
    esac
}

run_jameszerox_install() {
    log_step "Launching XKeen installer (${XKEEN_FORK_REPO})..."
    log_warn "In the menu choose Mihomo as proxy core, then follow prompts"
    log_warn "Installer must run from writable /opt/tmp (not ~ or /)"
    mkdir -p /opt/tmp
    if ( cd /opt/tmp && sh -c "$(curl -sSL "$XKEEN_FORK_INSTALL")" -- --stable ); then
        return 0
    fi
    return 1
}

install_xkeen_origin() {
    log_step "Installing XKeen from ${XKEEN_ORIGIN_REPO}..."

    ensure_opkg_package tar || die "tar not found (required for XKeen)"

    _xkeen_tar="/opt/tmp/xkeen.tar.$$"
    mkdir -p /opt/tmp
    if ! curl_fetch "$XKEEN_ORIGIN_TAR" "$_xkeen_tar"; then
        rm -f "$_xkeen_tar"
        return 1
    fi

    if ! tar -xf "$_xkeen_tar" -C /opt/sbin --overwrite >/dev/null 2>&1; then
        rm -f "$_xkeen_tar"
        return 1
    fi
    rm -f "$_xkeen_tar"

    if ! has_xkeen_binary; then
        return 1
    fi
    chmod 755 /opt/sbin/xkeen 2>/dev/null || true
    log_info "XKeen binary installed (/opt/sbin/xkeen)"
    return 0
}

install_xkeen_fork() {
    log_step "Installing XKeen (${XKEEN_FORK_REPO}, fork of ${XKEEN_ORIGIN_REPO})..."

    ensure_opkg_package tar || die "tar not found (required for XKeen)"
    ensure_opkg_package gzip || true

    _archive="/opt/tmp/xkeen.tar.gz.$$"
    mkdir -p /opt/tmp /opt/sbin
    if ! curl_fetch "$XKEEN_FORK_TAR" "$_archive"; then
        rm -f "$_archive"
        log_warn "Failed to download ${XKEEN_FORK_TAR}"
        install_xkeen_origin
        return $?
    fi

    _stage="/opt/sbin/.xkeen-install.$$"
    mkdir -p "$_stage"
    if ! tar -xzf "$_archive" -C "$_stage" \
        || [ ! -f "$_stage/xkeen" ] \
        || [ ! -d "$_stage/_xkeen" ]; then
        rm -rf "$_stage" "$_archive"
        log_warn "Failed to extract ${XKEEN_FORK_REPO} archive, trying ${XKEEN_ORIGIN_REPO}..."
        install_xkeen_origin
        return $?
    fi

    chmod 755 "$_stage/xkeen"
    mv "$_stage/xkeen" /opt/sbin/xkeen
    rm -rf /opt/sbin/.xkeen.old
    [ -d /opt/sbin/.xkeen ] && mv /opt/sbin/.xkeen /opt/sbin/.xkeen.old
    mv "$_stage/_xkeen" /opt/sbin/.xkeen
    rm -rf /opt/sbin/.xkeen.old "$_stage"
    # Do not keep the archive — Entware flash is limited
    rm -f "$_archive" /opt/sbin/xkeen.tar.gz
    chmod 755 /opt/sbin/xkeen

    if ! has_xkeen_binary; then
        return 1
    fi
    log_info "XKeen installed: /opt/sbin/xkeen"
    return 0
}

install_mihomo_binary() {
    if has_mihomo_binary; then
        return 0
    fi

    _suffix=$(mihomo_asset_suffix) || {
        log_warn "Unsupported architecture for Mihomo: ${ARCH}"
        return 1
    }

    log_step "Downloading Mihomo (${_suffix})..."
    ensure_opkg_package gzip || true

    _release_json=$(curl -s --connect-timeout 10 --max-time 20 \
        ${CURL_CA_BUNDLE:+--cacert "$CURL_CA_BUNDLE"} \
        "$MIHOMO_API" 2>/dev/null) || {
        log_warn "Failed to fetch Mihomo release info"
        return 1
    }

    _asset_prefix="mihomo-linux-${_suffix}-"
    _asset_name=$(printf '%s' "$_release_json" | tr ',' '\n' | \
        grep 'browser_download_url' | grep "$_asset_prefix" | grep '\.gz"' | head -1 | \
        sed 's/.*\/\([^/"]*\)".*/\1/')

    if [ -z "$_asset_name" ]; then
        log_warn "Mihomo asset not found for ${_suffix}"
        return 1
    fi

    _tag=$(printf '%s' "$_release_json" | \
        grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    _download_url="https://github.com/${MIHOMO_REPO}/releases/download/${_tag}/${_asset_name}"

    _gz="/opt/tmp/mihomo.gz.$$"
    _tmp="/opt/sbin/mihomo.new.$$"
    mkdir -p /opt/tmp

    if ! curl_fetch "$_download_url" "$_gz"; then
        rm -f "$_gz"
        log_warn "Failed to download Mihomo: ${_download_url}"
        return 1
    fi

    if ! gunzip -c "$_gz" > "$_tmp" 2>/dev/null; then
        rm -f "$_gz" "$_tmp"
        log_warn "Failed to unpack Mihomo archive"
        return 1
    fi
    rm -f "$_gz"

    if ! is_elf_binary "$_tmp"; then
        rm -f "$_tmp"
        log_warn "Downloaded Mihomo file is not a valid binary"
        return 1
    fi

    chmod 755 "$_tmp"
    if ! "$_tmp" -v >/dev/null 2>&1; then
        rm -f "$_tmp"
        log_warn "Mihomo binary failed validation on this CPU"
        return 1
    fi

    mv -f "$_tmp" /opt/sbin/mihomo
    log_info "Mihomo installed: /opt/sbin/mihomo (${_tag})"
    return 0
}

run_xkeen_setup() {
    if ! has_xkeen_binary; then
        return 1
    fi
    if has_xkeen_init && has_mihomo_binary; then
        return 0
    fi

    _xkeen="/opt/sbin/xkeen"

    if ! has_mihomo_binary; then
        install_mihomo_binary || true
    fi

    log_step "Configuring XKeen (Mihomo core)..."

    _configured=0

    # Prefer interactive console (works after curl|sh re-exec with /dev/tty).
    if [ -t 0 ]; then
        log_step "Starting xkeen -i (interactive)..."
        log_warn "Internal storage warning → choose 1 (continue)"
        log_warn "Proxy core → choose Mihomo"
        if "$_xkeen" -i; then
            _configured=1
        else
            log_warn "xkeen -i exited with an error"
        fi
    fi

    # Offline/auto setup when Mihomo binary is already present.
    if [ "$_configured" -eq 0 ] && [ -d /opt/sbin/.xkeen ] && has_mihomo_binary; then
        log_step "Trying XKeen auto setup (xkeen -io)..."
        if ( cd /opt/sbin && "$_xkeen" -io ); then
            _configured=1
        fi
    fi

    if [ "$_configured" -eq 0 ] && { ! has_xkeen_init || ! has_mihomo_binary; }; then
        log_step "Non-interactive XKeen setup (auto answers)..."
        if printf '1\ny\n2\n1\ny\n1\n' | "$_xkeen" -i; then
            _configured=1
        fi
    fi

    if has_xkeen_init && has_mihomo_binary; then
        "$_xkeen" -mihomo 2>/dev/null || true
        log_info "XKeen configured (init scripts + Mihomo)"
        return 0
    fi

    log_warn "XKeen setup incomplete — finish manually:"
    log_warn "  /opt/sbin/xkeen -i   (choose Mihomo as proxy core)"
    log_warn "Docs: https://github.com/${XKEEN_FORK_REPO}"
    return 1
}

check_proxy_stack() {
    if [ "$SKIP_XKEEN_CHECK" -eq 1 ]; then
        log_warn "Skipping XKeen / Mihomo dependency check"
        return 0
    fi

    log_step "Checking XKeen and proxy cores..."

    _need_xkeen=0
    _need_setup=0
    _need_mihomo=0

    if ! has_xkeen_binary; then
        _need_xkeen=1
        log_warn "XKeen not found (required to manage Mihomo/Xray on the router)"
    else
        log_info "XKeen binary found"
    fi

    if ! has_xkeen_init; then
        _need_setup=1
        log_warn "XKeen init script not found (/opt/etc/init.d/S99xkeen or S24xray)"
    else
        log_info "XKeen init script found"
    fi

    if has_mihomo_binary; then
        log_info "Mihomo binary found (/opt/sbin/mihomo)"
    else
        _need_mihomo=1
        log_warn "Mihomo not found (/opt/sbin/mihomo) — install via xkeen -i"
    fi

    if has_xray_binary; then
        log_info "Xray binary found (/opt/sbin/xray)"
    fi

    if [ "$_need_xkeen" -eq 1 ]; then
        log_warn "XKeen fork: ${XKEEN_FORK_INSTALL}"
        log_warn "Original XKeen: ${XKEEN_ORIGIN_INSTALL}"
        if [ "$NO_INSTALL_XKEEN" -eq 1 ]; then
            log_warn "Auto-install skipped (--no-install-xkeen). zKeen UI needs XKeen to manage Mihomo."
        else
            log_step "Installing missing XKeen (required for Mihomo on the router)..."
            if install_xkeen_fork; then
                _need_xkeen=0
                _need_setup=1
                _need_mihomo=1
            else
                log_warn "XKeen install failed. Install manually from /opt/tmp:"
                log_warn "  cd /opt/tmp && sh -c \"\$(curl -sSL ${XKEEN_FORK_INSTALL})\" -- --stable"
            fi
        fi
    fi

    if [ "$_need_xkeen" -eq 0 ] && { [ "$_need_setup" -eq 1 ] || [ "$_need_mihomo" -eq 1 ]; }; then
        run_xkeen_setup
    fi

    if has_xkeen_init && has_mihomo_binary; then
        log_info "Proxy stack ready (XKeen + Mihomo)"
    elif has_xkeen_binary; then
        log_warn "Finish XKeen setup before using Proxy tab: /opt/sbin/xkeen -i"
        log_warn "Note: use /opt/sbin/xkeen (Entware shell may not have /opt/sbin in PATH)"
    fi
}

# ============================================================
#  Download and install
# ============================================================

download_binary() {
    resolve_download_url
    TMP_FILE="/opt/tmp/${BINARY_NAME}.tmp.$$"

    mkdir -p /opt/tmp
    check_free_space

    log_step "Downloading ${ASSET_NAME} (${LATEST_TAG})..."
    if ! curl_fetch "$DOWNLOAD_URL" "$TMP_FILE" 2>/dev/null; then
        rm -f "$TMP_FILE"
        die "Download failed: ${DOWNLOAD_URL}"
    fi

    FILE_SIZE=$(wc -c < "$TMP_FILE" 2>/dev/null | tr -d ' ')
    if [ -z "$FILE_SIZE" ] || [ "$FILE_SIZE" -lt "$MIN_BINARY_BYTES" ]; then
        rm -f "$TMP_FILE"
        die "Downloaded file too small (${FILE_SIZE:-0} bytes). Check release assets"
    fi

    if file_head_is_text "$TMP_FILE"; then
        rm -f "$TMP_FILE"
        die "Downloaded file looks like HTML/JSON, not a binary. Run: opkg install curl ca-certificates"
    fi

    if ! is_elf_binary "$TMP_FILE"; then
        _hex=$(od -An -tx1 -N4 "$TMP_FILE" 2>/dev/null | tr -dc '0-9a-fA-F' || true)
        rm -f "$TMP_FILE"
        die "Not an ELF binary (magic: ${_hex:-unknown}, size: ${FILE_SIZE} bytes). URL: ${DOWNLOAD_URL}"
    fi

    log_info "Downloaded: $(( FILE_SIZE / 1024 / 1024 )) MB"
}

install_binary() {
    log_step "Installing ${BINARY_NAME}..."

    FREE_KB_NOW=$(df -k /opt 2>/dev/null | tail -1 | awk '{print $4}')
    FILE_SIZE_KB=$(( $(wc -c < "$TMP_FILE" | tr -d ' ') / 1024 ))
    if [ -n "$FREE_KB_NOW" ] && [ "$FREE_KB_NOW" -lt "$((FILE_SIZE_KB + 1024))" ]; then
        rm -f "$TMP_FILE"
        die "Not enough space to install: ${FREE_KB_NOW} KB free, need ~$((FILE_SIZE_KB + 1024)) KB"
    fi

    mkdir -p "${INSTALL_DIR}"

    if [ "$MODE" = "update" ] && [ -f "${INSTALL_DIR}/${BINARY_NAME}" ]; then
        cp -f "${INSTALL_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}.bak" 2>/dev/null || true
    fi

    if ! mv -f "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null; then
        cp -f "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}" || {
            rm -f "$TMP_FILE"
            die "Failed to install binary"
        }
        rm -f "$TMP_FILE"
    fi

    chmod 755 "${INSTALL_DIR}/${BINARY_NAME}"
    sync
    # Short CLI alias: `zkeen status` → same binary as zkeen-ui
    ln -sfn "${BINARY_NAME}" "${INSTALL_DIR}/zkeen" 2>/dev/null \
        || ln -sf "${INSTALL_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/zkeen" 2>/dev/null \
        || true
    if [ -x "${INSTALL_DIR}/zkeen" ] || [ -L "${INSTALL_DIR}/zkeen" ]; then
        log_info "CLI alias: ${INSTALL_DIR}/zkeen → ${BINARY_NAME}"
    fi
    log_info "Binary installed: ${INSTALL_DIR}/${BINARY_NAME}"
}

create_init_script() {
    if [ -f "${INIT_DIR}/${INIT_SCRIPT}" ]; then
        log_info "Init script already exists"
        return
    fi

    log_step "Creating init script..."
    mkdir -p "${INIT_DIR}"

    cat > "${INIT_DIR}/${INIT_SCRIPT}" <<'INITEOF'
#!/bin/sh

ENABLED=yes
PROCS=zkeen-ui
ARGS="-p 7220"
PREARGS=""
DESC="$PROCS"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
INITEOF

    chmod 755 "${INIT_DIR}/${INIT_SCRIPT}"
    log_info "Init script created: ${INIT_DIR}/${INIT_SCRIPT}"
}

create_conf_dir() {
    if [ ! -d "$CONF_DIR" ]; then
        mkdir -p "$CONF_DIR"
        log_info "Config directory created: ${CONF_DIR}"
    fi
}

install_mihomo_config() {
    mkdir -p "${MIHOMO_DIR}/proxy-providers" "${MIHOMO_DIR}/adblock"

    if [ -f "$MIHOMO_CONFIG" ] \
        && grep -q 'external-controller:' "$MIHOMO_CONFIG" \
        && grep -q 'proxy-groups:' "$MIHOMO_CONFIG"; then
        log_info "Mihomo config OK: ${MIHOMO_CONFIG}"
        # Refresh pristine template for Reset Config when missing/outdated.
        if [ ! -s "${MIHOMO_DIR}/mihomo-config.default.yaml" ]; then
            _tmp_cfg="/opt/tmp/mihomo-config.default.$$"
            if curl_fetch "$DEFAULT_CONFIG_URL" "$_tmp_cfg" && [ -s "$_tmp_cfg" ]; then
                cp -f "$_tmp_cfg" "${MIHOMO_DIR}/mihomo-config.default.yaml"
                log_info "Template saved: ${MIHOMO_DIR}/mihomo-config.default.yaml"
            fi
            rm -f "$_tmp_cfg"
        fi
        return 0
    fi

    _sub_url=""
    if [ -f "$MIHOMO_CONFIG" ]; then
        _bak="${MIHOMO_CONFIG}.bak.$(date +%Y%m%d%H%M%S 2>/dev/null || echo xkeen)"
        cp -f "$MIHOMO_CONFIG" "$_bak" 2>/dev/null && log_info "Backed up stub config: ${_bak}"
        _sub_url=$(awk '
            /^  subscription:/ { in_sub=1; next }
            in_sub && /^  [a-zA-Z]/ && !/^  subscription:/ { in_sub=0 }
            in_sub && /^[[:space:]]*url:/ {
                sub(/^.*url:[[:space:]]*["'\'']?/, "")
                gsub(/["'\'']?[[:space:]]*$/, "")
                print
                exit
            }
        ' "$MIHOMO_CONFIG" 2>/dev/null)
        log_step "Replacing XKeen stub config with zKeen default template..."
    else
        log_step "Installing default Mihomo config..."
    fi

    _tmp_cfg="/opt/tmp/mihomo-config.default.$$"
    if ! curl_fetch "$DEFAULT_CONFIG_URL" "$_tmp_cfg"; then
        rm -f "$_tmp_cfg"
        log_warn "Could not download default config from GitHub"
        return 1
    fi

    if [ ! -s "$_tmp_cfg" ]; then
        rm -f "$_tmp_cfg"
        log_warn "Downloaded config template is empty"
        return 1
    fi

    if [ -n "$_sub_url" ]; then
        awk -v url="$_sub_url" '
            !done && /^[[:space:]]*url: ""$/ {
                print "    url: \"" url "\""
                done=1
                next
            }
            { print }
        ' "$_tmp_cfg" > "${MIHOMO_CONFIG}.new.$$"
        mv -f "${MIHOMO_CONFIG}.new.$$" "$MIHOMO_CONFIG"
    else
        cp -f "$_tmp_cfg" "$MIHOMO_CONFIG"
    fi
    # Keep pristine template for panel «Reset Config».
    cp -f "$_tmp_cfg" "${MIHOMO_DIR}/mihomo-config.default.yaml"
    rm -f "$_tmp_cfg"

    log_info "Default config installed: ${MIHOMO_CONFIG}"
    log_info "Template saved: ${MIHOMO_DIR}/mihomo-config.default.yaml"
    return 0
}

start_service() {
    log_step "Starting ${BINARY_NAME}..."
    if "${INIT_DIR}/${INIT_SCRIPT}" start >/dev/null 2>&1; then
        sleep 1
        if pgrep -x "${BINARY_NAME}" >/dev/null 2>&1; then
            log_info "Service started"
        else
            log_warn "Service started but process not found. Check log: /opt/var/log/zkeen-ui.log"
        fi
    else
        log_warn "Failed to start service automatically"
    fi
}

# Remove install/update leftovers. Keeps unrelated files in /opt/tmp intact.
cleanup_tmp() {
    log_step "Cleaning temporary files..."
    # XKeen / Mihomo / zKeen UI download leftovers
    rm -f \
        /opt/tmp/xkeen.tar.gz \
        /opt/tmp/xkeen.tar \
        /opt/tmp/xkeen.tar.gz.* \
        /opt/tmp/xkeen.tar.* \
        /opt/tmp/mihomo.gz \
        /opt/tmp/mihomo.gz.* \
        /opt/tmp/zkeen-ui \
        /opt/tmp/zkeen-ui.* \
        /opt/tmp/zkeen-ui_* \
        /opt/tmp/bin.tmp \
        /opt/tmp/download.tmp \
        /opt/tmp/yq.tmp \
        /opt/tmp/yq.bin \
        /opt/tmp/mihomo-config.default.* \
        /opt/sbin/xkeen.tar.gz \
        /opt/sbin/mihomo.new.* \
        2>/dev/null || true
    # PID-suffixed temp binaries from this installer
    rm -f /opt/tmp/"${BINARY_NAME}".tmp.* 2>/dev/null || true
    # Stale stage dirs from interrupted XKeen install
    rm -rf /opt/sbin/.xkeen-install.* 2>/dev/null || true
    log_info "Temporary files cleaned"
}

restart_service() {
    log_step "Restarting ${BINARY_NAME}..."
    "${INIT_DIR}/${INIT_SCRIPT}" restart >/dev/null 2>&1 || true
    sleep 1
    if pgrep -x "${BINARY_NAME}" >/dev/null 2>&1; then
        log_info "Service restarted"
    else
        log_warn "Service did not start after restart"
    fi
}

# ============================================================
#  Uninstall
# ============================================================

do_uninstall() {
    log_step "Removing ${BINARY_NAME}..."

    if [ -f "${INIT_DIR}/${INIT_SCRIPT}" ]; then
        "${INIT_DIR}/${INIT_SCRIPT}" stop >/dev/null 2>&1 || true
        rm -f "${INIT_DIR}/${INIT_SCRIPT}"
        log_info "Init script removed"
    fi

    rm -f "${INSTALL_DIR}/${BINARY_NAME}"
    rm -f "${INSTALL_DIR}/${BINARY_NAME}.bak"
    rm -f "${INSTALL_DIR}/zkeen"
    log_info "Binary removed"

    printf "${YELLOW}Remove config ${CONF_DIR}/${BINARY_NAME}.json? [y/N] ${NC}"
    read -r answer
    case "$answer" in
        [yY]*)
            rm -f "${CONF_DIR}/${BINARY_NAME}.json"
            rm -f "$CHANNEL_FILE"
            log_info "Config removed"
            ;;
        *) log_info "Config kept" ;;
    esac
    # Channel file is small; drop it always on uninstall.
    rm -f "$CHANNEL_FILE" 2>/dev/null || true

    log_info "Uninstall complete"
    exit 0
}

# ============================================================
#  Main
# ============================================================

main() {
    load_saved_channel

    case "$MODE" in
        update)    _title="update (${CHANNEL})" ;;
        uninstall) _title="uninstall" ;;
        *)           _title="install (${CHANNEL})" ;;
    esac

    printf "\n${BOLD}  zKeen UI — %s${NC}\n\n" "$_title"

    check_root

    if [ "$MODE" = "uninstall" ]; then
        do_uninstall
    fi

    check_entware
    check_curl
    detect_arch
    check_proxy_stack
    # Drop XKeen/Mihomo installer leftovers before downloading the panel binary
    cleanup_tmp
    check_free_space
    check_repo_available
    get_latest_version

    if [ "$MODE" = "update" ]; then
        get_installed_version
        if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" = "$LATEST_TAG" ]; then
            log_info "Already up to date: ${INSTALLED_VERSION} (${CHANNEL})"
            save_channel
            cleanup_tmp
            exit 0
        fi
        if [ -n "$INSTALLED_VERSION" ]; then
            log_info "Updating: ${INSTALLED_VERSION} -> ${LATEST_TAG} (${CHANNEL})"
        fi
    fi

    download_binary
    install_binary
    create_conf_dir
    save_channel
    log_info "Update channel saved: ${CHANNEL} (${CHANNEL_FILE})"
    install_mihomo_config || log_warn "Mihomo config not installed — add ${MIHOMO_CONFIG} manually"

    # Always recreate/restart after replacing the binary.
    # Plain `start` is a no-op if an old zkeen-ui is already running — that left
    # users on 0.0.23 after `… -- beta` overwrote the file on disk.
    create_init_script
    if [ -f "${INIT_DIR}/${INIT_SCRIPT}" ]; then
        restart_service
    else
        start_service
    fi

    # Confirm the running process matches the just-installed tag when possible.
    get_installed_version
    if [ -n "$INSTALLED_VERSION" ]; then
        log_info "Running version: ${INSTALLED_VERSION}"
        case "$INSTALLED_VERSION" in
            *"${LATEST_TAG#v}"*|*"$LATEST_TAG"*) ;;
            *)
                log_warn "Installed tag was ${LATEST_TAG}, but process reports ${INSTALLED_VERSION}"
                log_warn "Try: /opt/etc/init.d/S99zkeen-ui restart"
                ;;
        esac
    fi

    # Try to start Mihomo via XKeen (panel needs Clash API on :9090).
    if [ -x /opt/sbin/xkeen ]; then
        log_step "Starting XKeen / Mihomo..."
        /opt/sbin/xkeen -start >/dev/null 2>&1 || true
        sleep 2
        if /opt/sbin/xkeen -status >/dev/null 2>&1; then
            log_info "XKeen proxy client is running"
        else
            log_warn "XKeen proxy is not running yet — set subscription URL in the panel,"
            log_warn "then run: /opt/sbin/xkeen -start"
        fi
    fi

    cleanup_tmp

    FINAL_FREE_KB=$(df -k /opt 2>/dev/null | tail -1 | awk '{print $4}')
    if [ -n "$FINAL_FREE_KB" ]; then
        FINAL_FREE_MB=$((FINAL_FREE_KB / 1024))
        if [ "$FINAL_FREE_MB" -lt 5 ]; then
            log_warn "Low disk space remaining (${FINAL_FREE_MB} MB)"
        fi
    fi

    IP_ADDR=$(ip -4 addr show br0 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $2}' || \
              ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}' || \
              echo "router-ip")

    printf "\n${GREEN}${BOLD}  Done!${NC}\n"
    printf "  Panel: ${CYAN}http://${IP_ADDR}:${PORT}${NC}\n\n"
    printf "\n"
}

main
