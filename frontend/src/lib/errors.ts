import { useCallback } from "react";
import { ApiError } from "./api";
import { useI18n, type Locale } from "./i18n";

const CYRILLIC = /[А-Яа-яЁё]/;

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Stable API error codes → i18n keys */
const CODE_KEYS: Record<string, string> = {
  invalid_password: "api.invalidPassword",
  too_many_attempts: "api.tooManyAttempts",
  no_password_set: "api.noPasswordSet",
  password_already_set: "api.passwordAlreadySet",
  github_unreachable: "settings.checkErrorGithub",
  update_failed: "api.updateFailed",
  opkg_update_failed: "api.opkgUpdateFailed",
  jq_install_failed: "api.jqInstallFailed",
  arch_unsupported: "api.archUnsupported",
  unknown_core: "api.unknownCore",
  save_failed: "api.saveFailed",
  artifact_too_small: "api.artifactTooSmall",
  artifact_not_elf: "api.artifactNotElf",
  install_failed: "api.installFailed",
  asset_not_found: "api.assetNotFound",
  unpack_failed: "api.unpackFailed",
  xkeen_init_missing: "api.xkeenInitMissing",
  restart_failed: "api.restartFailed",
  missing_core_config: "api.missingCoreConfig",
  start_failed: "api.startFailed",
  unix_socket_missing: "api.unixSocketMissing",
  clash_connection_missing: "api.clashConnectionMissing",
  invalid_timezone: "api.invalidTimezone",
  ping_url_empty: "api.pingUrlEmpty",
  ping_timeout_invalid: "api.pingTimeoutInvalid",
};

/** Legacy Russian backend strings → codes (compat during rollout) */
const LEGACY_RU: Record<string, string> = {
  "Неверный пароль": "invalid_password",
  "Не удалось выполнить обновление": "update_failed",
  "Ошибка обновления opkg кеша": "opkg_update_failed",
  "Ошибка установки jq": "jq_install_failed",
  "Архитектура не поддерживается для yq": "arch_unsupported",
  "Архитектура не поддерживается": "arch_unsupported",
  "Неизвестное ядро": "unknown_core",
  "Файл меньше 1МБ — повреждённый артефакт": "artifact_too_small",
  "Файл не является ELF-бинарём — отменено": "artifact_not_elf",
  "Ассет не найден — обновите страницу и повторите": "asset_not_found",
  "Не найден init файл XKeen": "xkeen_init_missing",
  "Не найдены конфигурационные файлы. Настройте их в /opt/etc/xray/configs перед запуском":
    "missing_core_config",
  "Unix сокет не найден на диске": "unix_socket_missing",
  "Фронт не передал данные для подключения": "clash_connection_missing",
  "Неверный часовой пояс": "invalid_timezone",
  "URL пинг-теста не может быть пустым": "ping_url_empty",
  "Таймаут пинг-теста должен быть больше 0": "ping_timeout_invalid",
};

function resolveCode(raw: string): { code: string; params?: Record<string, string | number> } {
  const legacy = LEGACY_RU[raw];
  if (legacy) return { code: legacy };

  const withSec = raw.match(/^too_many_attempts:(\d+)$/);
  if (withSec) return { code: "too_many_attempts", params: { sec: withSec[1] } };

  const withPrefix = raw.match(
    /^(restart_failed|start_failed|save_failed|install_failed|unpack_failed)(?::|$)/,
  );
  if (withPrefix) return { code: withPrefix[1] };

  if (/^Слишком много попыток/.test(raw)) {
    const sec = raw.match(/(\d+)/)?.[1] || "60";
    return { code: "too_many_attempts", params: { sec } };
  }
  if (/^Не удалось перезапустить/.test(raw)) return { code: "restart_failed" };
  if (/^Не удалось запустить/.test(raw)) return { code: "start_failed" };
  if (/^Ошибка сохранения/.test(raw)) return { code: "save_failed" };
  if (/^Ошибка установки/.test(raw)) return { code: "install_failed" };
  if (/^Ошибка распаковки/.test(raw)) return { code: "unpack_failed" };

  return { code: raw };
}

/**
 * Resolve API/UI errors for the current locale.
 * On English: never returns Cyrillic (falls back to i18n key).
 * On Russian: Latin technical messages are allowed as-is.
 */
export function displayApiError(
  err: unknown,
  t: Translate,
  fallbackKey: string,
  locale: Locale,
): string {
  let raw = "";
  if (err instanceof ApiError) raw = err.message.trim();
  else if (err instanceof Error) raw = err.message.trim();
  else if (typeof err === "string") raw = err.trim();

  if (!raw) return t(fallbackKey);

  const { code, params } = resolveCode(raw);
  const i18nKey = CODE_KEYS[code];
  if (i18nKey) return t(i18nKey, params);

  if (locale === "en" && CYRILLIC.test(raw)) return t(fallbackKey);
  return raw;
}

export function useApiError() {
  const { t, locale } = useI18n();
  return useCallback(
    (err: unknown, fallbackKey: string) => displayApiError(err, t, fallbackKey, locale),
    [t, locale],
  );
}
