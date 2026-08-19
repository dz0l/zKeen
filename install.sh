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
XKEEN_ORIGIN_TAR="https://github.com/${XKEEN_ORIGIN_REPO}/releases/latest/download/xkeen.tar"
XKEEN_ORIGIN_INSTALL="https://raw.githubusercontent.com/${XKEEN_ORIGIN_REPO}/main/install.sh"
MIHOMO_REPO="MetaCubeX/mihomo"
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

# --- Mode ---
MODE="install"
INSTALL_XKEEN=""
SKIP_XKEEN_CHECK=0
for arg in "$@"; do
    case "$arg" in
        --update) MODE="update" ;;
        --uninstall) MODE="uninstall" ;;
        --install-xkeen) INSTALL_XKEEN=1 ;;
        --skip-xkeen-check) SKIP_XKEEN_CHECK=1 ;;
    esac
done

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

    RELEASE_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 15 \
        ${CURL_CA_BUNDLE:+--cacert "$CURL_CA_BUNDLE"} \
        "${GITHUB_API}/releases/latest" 2>/dev/null || echo "000")

    case "$RELEASE_CODE" in
        200) log_info "Release available" ;;
        404) die "No published releases yet (tag v*.*.* required)" ;;
        403) die "GitHub API rate limit. Retry in a few minutes" ;;
        000) die "Cannot reach GitHub. Check internet/DNS" ;;
        *)   die "GitHub returned HTTP ${RELEASE_CODE} for release check" ;;
    esac
}

get_latest_version() {
    RELEASE_JSON=$(curl -s --connect-timeout 10 --max-time 15 \
        ${CURL_CA_BUNDLE:+--cacert "$CURL_CA_BUNDLE"} \
        "${GITHUB_API}/releases/latest" 2>/dev/null) \
        || die "Failed to fetch release info"

    LATEST_TAG=$(printf '%s' "$RELEASE_JSON" | \
        grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    if [ -z "$LATEST_TAG" ]; then
        die "Cannot determine latest version"
    fi
    log_info "Latest version: ${LATEST_TAG}"
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

install_xkeen_origin() {
    log_step "Installing XKeen from ${XKEEN_ORIGIN_REPO}..."

    if ! command -v tar >/dev/null 2>&1; then
        if command -v opkg >/dev/null 2>&1; then
            opkg update >/dev/null 2>&1 || true
            opkg install tar >/dev/null 2>&1 || die "Failed to install tar (required for XKeen)"
        else
            die "tar not found (required for XKeen)"
        fi
    fi

    _xkeen_tar="/opt/tmp/xkeen.tar.$$"
    mkdir -p /opt/tmp
    if ! curl_fetch "$XKEEN_ORIGIN_TAR" "$_xkeen_tar"; then
        rm -f "$_xkeen_tar"
        die "Failed to download XKeen from ${XKEEN_ORIGIN_TAR}"
    fi

    if ! tar -xf "$_xkeen_tar" -C /opt/sbin --overwrite >/dev/null 2>&1; then
        rm -f "$_xkeen_tar"
        die "Failed to extract XKeen archive"
    fi
    rm -f "$_xkeen_tar"

    if ! has_xkeen_binary; then
        die "XKeen install failed: /opt/sbin/xkeen not found after extract"
    fi
    chmod 755 /opt/sbin/xkeen 2>/dev/null || true
    log_info "XKeen binary installed (/opt/sbin/xkeen)"
}

run_xkeen_setup() {
    if ! has_xkeen_binary; then
        return 1
    fi
    if has_xkeen_init && has_mihomo_binary; then
        return 0
    fi

    log_warn "XKeen needs interactive setup: init scripts and proxy core (Mihomo)"
    log_warn "Run: xkeen -i   (choose Mihomo as proxy core)"
    log_warn "Docs: https://github.com/${XKEEN_ORIGIN_REPO}"

    if [ -t 0 ] && prompt_yes "Run xkeen -i now?" "y"; then
        log_step "Starting xkeen -i (interactive)..."
        xkeen -i || log_warn "xkeen -i exited with an error — finish setup manually"
    fi
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
        log_warn "Original XKeen: ${XKEEN_ORIGIN_INSTALL}"
        log_warn "Mihomo core: https://github.com/${MIHOMO_REPO} (installed by XKeen)"
        if prompt_yes "Install XKeen from ${XKEEN_ORIGIN_REPO} now?" "y"; then
            install_xkeen_origin
            _need_xkeen=0
            _need_setup=1
            _need_mihomo=1
        else
            log_warn "zKeen UI needs XKeen to start/stop Mihomo. Install later, then run: xkeen -i"
        fi
    fi

    if [ "$_need_xkeen" -eq 0 ] && { [ "$_need_setup" -eq 1 ] || [ "$_need_mihomo" -eq 1 ]; }; then
        run_xkeen_setup
    fi

    if has_xkeen_init && has_mihomo_binary; then
        log_info "Proxy stack ready (XKeen + Mihomo)"
    elif has_xkeen_binary; then
        log_warn "Finish XKeen setup before using Proxy tab: xkeen -i"
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
    if [ -f "$MIHOMO_CONFIG" ]; then
        log_info "Mihomo config exists: ${MIHOMO_CONFIG}"
        return 0
    fi

    log_step "Installing default Mihomo config..."
    mkdir -p "${MIHOMO_DIR}/proxy-providers" "${MIHOMO_DIR}/adblock"

    if ! curl_fetch "$DEFAULT_CONFIG_URL" "$MIHOMO_CONFIG"; then
        log_warn "Could not download default config from GitHub"
        return 1
    fi

    if [ ! -s "$MIHOMO_CONFIG" ]; then
        rm -f "$MIHOMO_CONFIG"
        log_warn "Downloaded config template is empty"
        return 1
    fi

    log_info "Default config installed: ${MIHOMO_CONFIG}"
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
    log_info "Binary removed"

    printf "${YELLOW}Remove config ${CONF_DIR}/${BINARY_NAME}.json? [y/N] ${NC}"
    read -r answer
    case "$answer" in
        [yY]*) rm -f "${CONF_DIR}/${BINARY_NAME}.json"; log_info "Config removed" ;;
        *) log_info "Config kept" ;;
    esac

    log_info "Uninstall complete"
    exit 0
}

# ============================================================
#  Main
# ============================================================

main() {
    case "$MODE" in
        update)    _title="update" ;;
        uninstall) _title="uninstall" ;;
        *)           _title="install" ;;
    esac

    printf "\n${BOLD}  zKeen UI — %s${NC}\n\n" "$_title"

    check_root

    if [ "$MODE" = "uninstall" ]; then
        do_uninstall
    fi

    check_entware
    check_curl
    check_proxy_stack
    detect_arch
    check_free_space
    check_repo_available
    get_latest_version

    if [ "$MODE" = "update" ]; then
        get_installed_version
        if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" = "$LATEST_TAG" ]; then
            log_info "Already up to date: ${INSTALLED_VERSION}"
            exit 0
        fi
        if [ -n "$INSTALLED_VERSION" ]; then
            log_info "Updating: ${INSTALLED_VERSION} -> ${LATEST_TAG}"
        fi
    fi

    download_binary
    install_binary
    create_conf_dir
    install_mihomo_config || log_warn "Mihomo config not installed — add ${MIHOMO_CONFIG} manually"

    if [ "$MODE" = "update" ]; then
        restart_service
    else
        create_init_script
        start_service
    fi

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
}

main
