#!/bin/sh
set -e

# ============================================================
#  zKeen UI — установка / обновление для Keenetic + Entware
# ============================================================

REPO_OWNER="dz0l"
REPO_NAME="zKeen"
BINARY_NAME="zkeen-ui"
INSTALL_DIR="/opt/sbin"
INIT_DIR="/opt/etc/init.d"
INIT_SCRIPT="S99zkeen-ui"
CONF_DIR="/opt/etc/xkeen"
PORT="7220"
MIN_FREE_MB=15
GITHUB_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"
GITHUB_RAW="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
log_warn()  { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
log_error() { printf "${RED}[✗]${NC} %s\n" "$1"; }
log_step()  { printf "${CYAN}[→]${NC} ${BOLD}%s${NC}\n" "$1"; }

die() { log_error "$1"; exit 1; }

# --- Определение режима ---
MODE="install"
for arg in "$@"; do
    case "$arg" in
        --update) MODE="update" ;;
        --uninstall) MODE="uninstall" ;;
    esac
done

# ============================================================
#  Проверки окружения
# ============================================================

check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "Скрипт должен быть запущен от root (sudo)"
    fi
}

check_entware() {
    if [ ! -d "/opt/etc" ]; then
        die "Entware не обнаружен. Установите Entware: https://github.com/Entware/Entware/wiki"
    fi
    log_info "Entware обнаружен"
}

check_curl() {
    if ! command -v curl >/dev/null 2>&1; then
        log_warn "curl не найден, устанавливаю..."
        if command -v opkg >/dev/null 2>&1; then
            opkg update >/dev/null 2>&1
            opkg install curl >/dev/null 2>&1 || die "Не удалось установить curl"
            log_info "curl установлен"
        else
            die "curl не найден и opkg недоступен"
        fi
    fi
}

detect_arch() {
    ARCH=$(uname -m)
    case "$ARCH" in
        aarch64)
            ARCH_SUFFIX="aarch64-unknown-linux-musl"
            ASSET_NAME="${BINARY_NAME}-arm64-v8a"
            ;;
        mips|mipsel)
            if [ "$(echo -n I | od -to2 | head -c 20 | awk '{print $2}')" = "00000" ]; then
                ARCH_SUFFIX="mips-unknown-linux-musl"
                ASSET_NAME="${BINARY_NAME}-mips32"
            else
                ARCH_SUFFIX="mipsel-unknown-linux-musl"
                ASSET_NAME="${BINARY_NAME}-mips32le"
            fi
            ;;
        *)
            die "Архитектура ${ARCH} не поддерживается. Поддерживаются: aarch64, mipsle"
            ;;
    esac
    log_info "Архитектура: ${ARCH} (${ASSET_NAME})"
}

check_free_space() {
    MOUNT_POINT="/opt"
    if [ ! -d "$MOUNT_POINT" ]; then
        MOUNT_POINT="/"
    fi

    FREE_KB=$(df -k "$MOUNT_POINT" 2>/dev/null | tail -1 | awk '{print $4}')
    if [ -z "$FREE_KB" ]; then
        log_warn "Не удалось определить свободное место, продолжаю..."
        return
    fi

    FREE_MB=$((FREE_KB / 1024))
    if [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
        die "Недостаточно места: ${FREE_MB} МБ свободно, требуется минимум ${MIN_FREE_MB} МБ"
    fi
    log_info "Свободное место: ${FREE_MB} МБ (мин. ${MIN_FREE_MB} МБ)"
}

check_repo_available() {
    log_step "Проверка доступности репозитория..."

    REPO_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 15 \
        "${GITHUB_API}" 2>/dev/null || echo "000")

    case "$REPO_CODE" in
        200) log_info "Репозиторий найден: ${REPO_OWNER}/${REPO_NAME}" ;;
        404) die "Репозиторий не найден: ${REPO_OWNER}/${REPO_NAME}" ;;
        403) die "Доступ к GitHub API ограничен (rate limit). Повторите через несколько минут" ;;
        000) die "Нет подключения к GitHub. Проверьте интернет или DNS" ;;
        *)   die "GitHub вернул HTTP ${REPO_CODE} при проверке репозитория" ;;
    esac

    RELEASE_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 15 \
        "${GITHUB_API}/releases/latest" 2>/dev/null || echo "000")

    case "$RELEASE_CODE" in
        200) log_info "Release доступен" ;;
        404) die "Нет опубликованных релизов. Дождитесь первого release (тег v*.*.*) в ${REPO_OWNER}/${REPO_NAME}" ;;
        403) die "Доступ к GitHub API ограничен (rate limit). Повторите через несколько минут" ;;
        000) die "Нет подключения к GitHub. Проверьте интернет или DNS" ;;
        *)   die "GitHub вернул HTTP ${RELEASE_CODE} при проверке release" ;;
    esac
}

get_latest_version() {
    LATEST_TAG=$(curl -s --connect-timeout 10 --max-time 15 \
        "${GITHUB_API}/releases/latest" 2>/dev/null | \
        grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    if [ -z "$LATEST_TAG" ]; then
        die "Не удалось определить последнюю версию"
    fi
    log_info "Последняя версия: ${LATEST_TAG}"
}

get_installed_version() {
    INSTALLED_VERSION=""
    if [ -x "${INSTALL_DIR}/${BINARY_NAME}" ]; then
        INSTALLED_VERSION=$("${INSTALL_DIR}/${BINARY_NAME}" -v 2>/dev/null | head -1 | awk '{print $NF}' || true)
    fi
}

# ============================================================
#  Загрузка и установка
# ============================================================

download_binary() {
    DOWNLOAD_URL="${GITHUB_RAW}/download/${LATEST_TAG}/${ASSET_NAME}"
    TMP_FILE="/opt/tmp/${BINARY_NAME}.tmp.$$"

    mkdir -p /opt/tmp

    # Проверяем место ещё раз перед загрузкой
    check_free_space

    log_step "Загрузка ${ASSET_NAME} (${LATEST_TAG})..."
    if ! curl -fSL --connect-timeout 15 --max-time 300 \
         --retry 3 --retry-delay 5 \
         -o "$TMP_FILE" "$DOWNLOAD_URL" 2>/dev/null; then
        rm -f "$TMP_FILE"
        die "Ошибка загрузки: ${DOWNLOAD_URL}"
    fi

    # Проверка размера
    FILE_SIZE=$(wc -c < "$TMP_FILE" 2>/dev/null | tr -d ' ')
    if [ -z "$FILE_SIZE" ] || [ "$FILE_SIZE" -lt 1048576 ]; then
        rm -f "$TMP_FILE"
        die "Загруженный файл слишком мал (${FILE_SIZE:-0} байт). Возможно, артефакт повреждён"
    fi

    # Проверка ELF-заголовка
    FILE_MAGIC=$(od -A n -t x1 -N 4 "$TMP_FILE" 2>/dev/null | tr -d ' ')
    if [ "$FILE_MAGIC" != "7f454c46" ]; then
        rm -f "$TMP_FILE"
        die "Загруженный файл не является ELF-бинарём. Проверьте URL"
    fi

    log_info "Файл загружен: $(( FILE_SIZE / 1024 / 1024 )) МБ"
}

install_binary() {
    log_step "Установка ${BINARY_NAME}..."

    # Проверяем место для установки
    FREE_KB_NOW=$(df -k /opt 2>/dev/null | tail -1 | awk '{print $4}')
    FILE_SIZE_KB=$(( $(wc -c < "$TMP_FILE" | tr -d ' ') / 1024 ))
    if [ -n "$FREE_KB_NOW" ] && [ "$FREE_KB_NOW" -lt "$((FILE_SIZE_KB + 1024))" ]; then
        rm -f "$TMP_FILE"
        die "Недостаточно места для установки: ${FREE_KB_NOW} КБ свободно, нужно ~$((FILE_SIZE_KB + 1024)) КБ"
    fi

    mkdir -p "${INSTALL_DIR}"

    # Бэкап старого бинарника при обновлении
    if [ "$MODE" = "update" ] && [ -f "${INSTALL_DIR}/${BINARY_NAME}" ]; then
        cp -f "${INSTALL_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}.bak" 2>/dev/null || true
    fi

    if ! mv -f "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null; then
        cp -f "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}" || {
            rm -f "$TMP_FILE"
            die "Не удалось установить бинарник"
        }
        rm -f "$TMP_FILE"
    fi

    chmod 755 "${INSTALL_DIR}/${BINARY_NAME}"
    sync
    log_info "Бинарник установлен: ${INSTALL_DIR}/${BINARY_NAME}"
}

create_init_script() {
    if [ -f "${INIT_DIR}/${INIT_SCRIPT}" ]; then
        log_info "Init-скрипт уже существует"
        return
    fi

    log_step "Создание init-скрипта..."
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
    log_info "Init-скрипт создан: ${INIT_DIR}/${INIT_SCRIPT}"
}

create_conf_dir() {
    if [ ! -d "$CONF_DIR" ]; then
        mkdir -p "$CONF_DIR"
        log_info "Каталог конфигурации создан: ${CONF_DIR}"
    fi
}

start_service() {
    log_step "Запуск ${BINARY_NAME}..."
    if "${INIT_DIR}/${INIT_SCRIPT}" start >/dev/null 2>&1; then
        sleep 1
        if pgrep -x "${BINARY_NAME}" >/dev/null 2>&1; then
            log_info "Сервис запущен"
        else
            log_warn "Сервис запущен, но процесс не обнаружен. Проверьте лог: /opt/var/log/zkeen-ui.log"
        fi
    else
        log_warn "Не удалось запустить сервис автоматически"
    fi
}

restart_service() {
    log_step "Перезапуск ${BINARY_NAME}..."
    "${INIT_DIR}/${INIT_SCRIPT}" restart >/dev/null 2>&1 || true
    sleep 1
    if pgrep -x "${BINARY_NAME}" >/dev/null 2>&1; then
        log_info "Сервис перезапущен"
    else
        log_warn "Сервис не запустился после перезапуска"
    fi
}

# ============================================================
#  Удаление
# ============================================================

do_uninstall() {
    log_step "Удаление ${BINARY_NAME}..."

    if [ -f "${INIT_DIR}/${INIT_SCRIPT}" ]; then
        "${INIT_DIR}/${INIT_SCRIPT}" stop >/dev/null 2>&1 || true
        rm -f "${INIT_DIR}/${INIT_SCRIPT}"
        log_info "Init-скрипт удалён"
    fi

    rm -f "${INSTALL_DIR}/${BINARY_NAME}"
    rm -f "${INSTALL_DIR}/${BINARY_NAME}.bak"
    log_info "Бинарник удалён"

    printf "${YELLOW}Удалить конфигурацию ${CONF_DIR}/${BINARY_NAME}.json? [y/N] ${NC}"
    read -r answer
    case "$answer" in
        [yY]*) rm -f "${CONF_DIR}/${BINARY_NAME}.json"; log_info "Конфигурация удалена" ;;
        *) log_info "Конфигурация сохранена" ;;
    esac

    log_info "Удаление завершено"
    exit 0
}

# ============================================================
#  Основной процесс
# ============================================================

main() {
    printf "\n${BOLD}  zKeen UI — %s${NC}\n\n" \
        "$([ "$MODE" = "update" ] && echo "обновление" || \
           [ "$MODE" = "uninstall" ] && echo "удаление" || echo "установка")"

    check_root

    if [ "$MODE" = "uninstall" ]; then
        do_uninstall
    fi

    check_entware
    check_curl
    detect_arch
    check_free_space
    check_repo_available
    get_latest_version

    if [ "$MODE" = "update" ]; then
        get_installed_version
        if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" = "$LATEST_TAG" ]; then
            log_info "Уже установлена актуальная версия: ${INSTALLED_VERSION}"
            exit 0
        fi
        if [ -n "$INSTALLED_VERSION" ]; then
            log_info "Обновление: ${INSTALLED_VERSION} → ${LATEST_TAG}"
        fi
    fi

    download_binary
    install_binary
    create_conf_dir

    if [ "$MODE" = "update" ]; then
        restart_service
    else
        create_init_script
        start_service
    fi

    # Финальная проверка места
    FINAL_FREE_KB=$(df -k /opt 2>/dev/null | tail -1 | awk '{print $4}')
    if [ -n "$FINAL_FREE_KB" ]; then
        FINAL_FREE_MB=$((FINAL_FREE_KB / 1024))
        if [ "$FINAL_FREE_MB" -lt 5 ]; then
            log_warn "Внимание: осталось мало места (${FINAL_FREE_MB} МБ). Рекомендуется освободить место"
        fi
    fi

    IP_ADDR=$(ip -4 addr show br0 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $2}' || \
              ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}' || \
              echo "<IP роутера>")

    printf "\n${GREEN}${BOLD}  Готово!${NC}\n"
    printf "  Панель доступна: ${CYAN}http://${IP_ADDR}:${PORT}${NC}\n\n"
}

main
