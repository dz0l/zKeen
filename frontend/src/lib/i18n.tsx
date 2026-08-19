import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type Locale = "ru" | "en";

type Dict = Record<string, string>;
type Translations = Record<Locale, Dict>;

const translations: Translations = {
  ru: {
    // Nav
    "nav.status": "Статус",
    "nav.connections": "Подключения",
    "nav.connectionsShort": "Подк.",
    "nav.proxies": "Proxy",
    "nav.config": "Config",
    "nav.groups": "Группы",
    "nav.policies": "Политики IP",
    "nav.settings": "Настройки",
    "nav.more": "Ещё",
    "nav.sections": "Разделы",
    "nav.navigation": "Навигация",
    "nav.workMode": "Режим работы",

    // Status
    "status.title": "Статус",
    "status.subtitle": "Состояние сервиса и ядра Mihomo",
    "status.core": "Ядро прокси · Clash API",
    "status.running": "Работает",
    "status.stopped": "Остановлен",
    "status.uptime": "Аптайм",
    "status.connections": "Соединения",
    "status.active": "активных",
    "status.memory": "Память",
    "status.version": "Версия",
    "status.restart": "Перезапуск",
    "status.stop": "Стоп",
    "status.safeRestart": "Safe: перезапуск с подтверждением",
    "status.xkeen": "Сервис на роутере",
    "status.panel": "Панель управления",
    "status.statusLabel": "Статус",
    "status.coreLabel": "Ядро",
    "status.clashApi": "Clash API",
    "status.versionLabel": "Версия",
    "status.modeLabel": "Режим",
    "status.portLabel": "Порт",

    // Connections
    "conn.title": "Подключения",
    "conn.subtitle": "Активные и закрытые соединения через Mihomo",
    "conn.tabActive": "Активные",
    "conn.tabClosed": "Закрытые",
    "conn.total": "Соединений",
    "conn.ofTotal": "из {total}",
    "conn.uniqueIps": "Уникальных IP",
    "conn.upload": "Upload",
    "conn.download": "Download",
    "conn.filterTitle": "Фильтры",
    "conn.filterSub": "Выбор IP из списка, поиск по хосту",
    "conn.filterIp": "IP источника",
    "conn.filterHost": "Хост / домен",
    "conn.allIps": "Все IP",
    "conn.searchIp": "Поиск IP…",
    "conn.noIpFound": "IP не найден",
    "conn.clearFilter": "Сбросить фильтр",
    "conn.listActive": "Активные подключения",
    "conn.listClosed": "Закрытые подключения",
    "conn.listSub": "{count} записей",
    "conn.closeAll": "Завершить все ({count})",
    "conn.closeForIp": "Завершить для {ip} ({count})",
    "conn.confirmCloseAll": "Завершить все активные соединения ({count})?",
    "conn.confirmCloseIp": "Завершить соединения для {ip} ({count})?",
    "conn.safeCloseHint": "Safe: подтверждение перед завершением",
    "conn.colIp": "IP",
    "conn.colHost": "Хост",
    "conn.colNetwork": "Сеть",
    "conn.colRule": "Правило",
    "conn.colChain": "Цепочка",
    "conn.colUp": "↑ Up",
    "conn.colDown": "↓ Down",
    "conn.colTime": "Время",
    "conn.colClosed": "Закрыто",
    "conn.noResults": "Нет подключений по фильтру",

    // Proxies
    "proxies.title": "Proxy",
    "proxies.subtitle": "{count} групп",
    "proxies.search": "Поиск групп…",
    "proxies.testAll": "Тест всех",
    "proxies.noResults": "Группы не найдены",
    "proxies.quickSelect": "Быстрый выбор",
    "proxies.quickSelectSub": "Установить сервер для всех групп сразу",
    "proxies.serverForAll": "Сервер для всех групп",
    "proxies.resetAll": "Сброс в DIRECT",

    // Config
    "config.title": "Config",
    "config.subtitle": "Редактор и настройки config.yaml",
    "config.tabEditor": "📝 Редактор",
    "config.tabQuick": "⚡ Быстрые настройки",
    "config.safeBanner": "Сохранение только после успешной проверки. Автобэкап перед apply.",
    "config.validate": "Проверить",
    "config.save": "Сохранить",
    "config.format": "Форматировать",
    "config.validateFirst": "Сначала проверьте конфиг",
    "config.valid": "✓ Valid",
    "config.error": "✗ Error",
    "config.qCore": "Общие настройки ядра",
    "config.qCoreSub": "mode, порты, ipv6, allow-lan",
    "config.qMode": "Режим работы (mode)",
    "config.qLogLevel": "Уровень логов (log-level)",
    "config.export": "↓ Экспорт",
    "config.import": "↑ Импорт",
    "config.qExtUI": "External Controller",
    "config.qExtUISub": "Clash API подключение",
    "config.qSniffer": "Сниффер",
    "config.qSnifferSub": "Перехват трафика (HTTP, TLS, QUIC)",
    "config.qProviders": "Провайдеры прокси",
    "config.qProvidersSub": "Подписки, health-check, заголовки",
    "config.qProvidersRefresh": "Обновить подписку",
    "config.qSubUrl": "URL подписки",
    "config.qHwid": "x-hwid",
    "config.qHwidHint": "Некоторые провайдеры требуют x-hwid для авторизации",
    "config.qHealthUrl": "Health-check URL",
    "config.qHealthInterval": "Интервал проверки (сек)",
    "config.qDNS": "DNS",
    "config.qDNSSub": "Резолвер, fake-ip, кэш",
    "config.qGeo": "GEO-данные",
    "config.qGeoSub": "Автообновление, источники geo баз",
    "config.qGeoHint": "Интервал в часах",
    "config.qGeoSiteUrl": "GeoSite URL",
    "config.qGeoSiteHint": "Источник domain-list (geosite)",
    "config.qGeoIpUrl": "GeoIP URL",
    "config.qGeoIpHint": "Источник IP-баз (geoip)",
    "config.qApply": "Применить изменения",
    "config.qReset": "Сбросить",

    // Groups
    "groups.title": "Группы",
    "groups.subtitle": "Управление proxy-группами в config.yaml",
    "groups.newGroup": "Новая группа",
    "groups.newGroupSub": "Появится в Proxy с типом select",
    "groups.name": "Имя группы",
    "groups.namePlaceholder": "MY-GROUP",
    "groups.nameHint": "Появится во вкладке Proxy для выбора сервера",
    "groups.add": "Добавить",
    "groups.existingTitle": "Существующие группы",
    "groups.existingCount": "{count} групп",
    "groups.delete": "Удалить",
    "groups.confirmDelete": "Подтвердить",
    "groups.preview": "Предпросмотр",
    "groups.previewSub": "Фрагмент config.yaml",

    // Policies
    "policies.title": "Политики IP",
    "policies.subtitle": "Per-IP правила в mihomo rules · только IP",
    "policies.newPolicy": "Новая политика",
    "policies.newPolicySub": "Добавляет rule в config.yaml",
    "policies.ip": "IP-адрес устройства",
    "policies.ipPlaceholder": "192.168.1.50",
    "policies.ipHint": "Только IP, без имён устройств",
    "policies.policyType": "Тип политики",
    "policies.typeGroup": "Proxy-группа — IP-CIDR → GROUP",
    "policies.typeRule": "Правило — IP-CIDR → custom target",
    "policies.proxyGroup": "Proxy-группа",
    "policies.ruleTarget": "Цель правила",
    "policies.add": "Добавить политику",
    "policies.activeTitle": "Активные политики",
    "policies.rules": "{count} правил",
    "policies.group": "группа",
    "policies.rule": "rule",

    // Settings
    "settings.title": "Настройки",
    "settings.subtitle": "Режим, безопасность, обновления",
    "settings.modeTitle": "Режим работы",
    "settings.modeSafe": "Проверка config перед сохранением, автобэкап, подтверждение опасных действий.",
    "settings.modeExpert": "Прямое редактирование без блокировок. Рекомендуется опытным пользователям.",
    "settings.auth": "Авторизация",
    "settings.login": "Логин",
    "settings.password": "Новый пароль",
    "settings.changePassword": "Изменить пароль",
    "settings.updates": "Обновления",
    "settings.updatesSub": "xkeen, mihomo, zkeen-ui",
    "settings.downloadMethod": "Способ загрузки",
    "settings.direct": "Direct — напрямую с GitHub",
    "settings.proxy": "Proxy — через прокси",
    "settings.installed": "Установлена",
    "settings.latest": "Актуальная",
    "settings.update": "Обновить",
    "settings.upToDate": "Актуально",
    "settings.updateAvailable": "Доступно обновление",
    "settings.clashApi": "Clash API",
    "settings.clashApiSub": "Подключение к Mihomo",
    "settings.language": "Язык / Language",

    // Mock banner
    "mock.banner": "UI-прототип · данные демонстрационные · функционал не подключён",

    // App
    "app.loading": "Загрузка…",

    // Auth
    "auth.loginTitle": "Вход",
    "auth.loginSub": "Введите пароль панели",
    "auth.setupTitle": "Первоначальная настройка",
    "auth.setupSub": "Задайте пароль для доступа к панели",
    "auth.password": "Пароль",
    "auth.confirmPassword": "Подтверждение",
    "auth.loginAction": "Войти",
    "auth.setupAction": "Сохранить",
    "auth.logout": "Выйти",
    "auth.passwordShort": "Минимум 4 символа",
    "auth.passwordMismatch": "Пароли не совпадают",
    "auth.failed": "Ошибка авторизации",

    // Proxies API
    "proxies.loadError": "Не удалось загрузить proxy-группы",
    "proxies.switchError": "Не удалось переключить узел",

    // Status API
    "status.actionError": "Не удалось выполнить действие",

    // Settings
    "settings.saveClash": "Сохранить Clash API",
    "settings.saved": "Сохранено",
    "settings.unixHint": "Имя файла сокета в каталоге Mihomo (вместо TCP-порта)",
    "settings.subscription": "Подписка VPS",
    "settings.subscriptionSub": "URL proxy-provider для загрузки списка серверов",
    "settings.saveSubscription": "Сохранить и обновить",

    // Onboarding
    "onboarding.title": "Добро пожаловать в zKeen UI",
    "onboarding.subtitle": "Первоначальная настройка",
    "onboarding.hint": "Вставьте ссылку на подписку, чтобы загрузить список VPS в Mihomo. Можно пропустить и добавить позже в Config.",
    "onboarding.subUrl": "URL подписки",
    "onboarding.subHint": "Будет записано в proxy-providers.subscription",
    "onboarding.skip": "Пропустить",
    "onboarding.continue": "Продолжить",
    "onboarding.failed": "Не удалось применить подписку",

    // Config API
    "config.reload": "Перезагрузить",
    "config.notFound": "config.yaml не найден в /opt/etc/mihomo/. Переустановите zKeen UI или скопируйте шаблон вручную.",
    "config.validateError": "Ошибка проверки конфига",
    "config.saveError": "Ошибка сохранения конфига",
    "config.refreshError": "Не удалось обновить провайдер",
    "config.quickMockNote": "Остальные быстрые настройки — скоро. Пока используйте YAML-редактор (Expert).",
  },

  en: {
    // Nav
    "nav.status": "Status",
    "nav.connections": "Connections",
    "nav.connectionsShort": "Conn",
    "nav.proxies": "Proxy",
    "nav.config": "Config",
    "nav.groups": "Groups",
    "nav.policies": "IP Policies",
    "nav.settings": "Settings",
    "nav.more": "More",
    "nav.sections": "Sections",
    "nav.navigation": "Navigation",
    "nav.workMode": "Work mode",

    // Status
    "status.title": "Status",
    "status.subtitle": "Service and Mihomo core state",
    "status.core": "Proxy core · Clash API",
    "status.running": "Running",
    "status.stopped": "Stopped",
    "status.uptime": "Uptime",
    "status.connections": "Connections",
    "status.active": "active",
    "status.memory": "Memory",
    "status.version": "Version",
    "status.restart": "Restart",
    "status.stop": "Stop",
    "status.safeRestart": "Safe: restart with confirmation",
    "status.xkeen": "Router service",
    "status.panel": "Control panel",
    "status.statusLabel": "Status",
    "status.coreLabel": "Core",
    "status.clashApi": "Clash API",
    "status.versionLabel": "Version",
    "status.modeLabel": "Mode",
    "status.portLabel": "Port",

    // Connections
    "conn.title": "Connections",
    "conn.subtitle": "Active and closed connections through Mihomo",
    "conn.tabActive": "Active",
    "conn.tabClosed": "Closed",
    "conn.total": "Connections",
    "conn.ofTotal": "of {total}",
    "conn.uniqueIps": "Unique IPs",
    "conn.upload": "Upload",
    "conn.download": "Download",
    "conn.filterTitle": "Filters",
    "conn.filterSub": "Select IP from list, search by host",
    "conn.filterIp": "Source IP",
    "conn.filterHost": "Host / domain",
    "conn.allIps": "All IPs",
    "conn.searchIp": "Search IP…",
    "conn.noIpFound": "No IP found",
    "conn.clearFilter": "Clear filter",
    "conn.listActive": "Active connections",
    "conn.listClosed": "Closed connections",
    "conn.listSub": "{count} entries",
    "conn.closeAll": "Close all ({count})",
    "conn.closeForIp": "Close for {ip} ({count})",
    "conn.confirmCloseAll": "Close all active connections ({count})?",
    "conn.confirmCloseIp": "Close connections for {ip} ({count})?",
    "conn.safeCloseHint": "Safe: confirmation before closing",
    "conn.colIp": "IP",
    "conn.colHost": "Host",
    "conn.colNetwork": "Network",
    "conn.colRule": "Rule",
    "conn.colChain": "Chain",
    "conn.colUp": "↑ Up",
    "conn.colDown": "↓ Down",
    "conn.colTime": "Time",
    "conn.colClosed": "Closed",
    "conn.noResults": "No connections match filter",

    // Proxies
    "proxies.title": "Proxy",
    "proxies.subtitle": "{count} groups",
    "proxies.search": "Search groups…",
    "proxies.testAll": "Test all",
    "proxies.noResults": "No groups found",
    "proxies.quickSelect": "Quick select",
    "proxies.quickSelectSub": "Set server for all groups at once",
    "proxies.serverForAll": "Server for all groups",
    "proxies.resetAll": "Reset to DIRECT",

    // Config
    "config.title": "Config",
    "config.subtitle": "config.yaml editor & settings",
    "config.tabEditor": "📝 Editor",
    "config.tabQuick": "⚡ Quick settings",
    "config.safeBanner": "Save only after successful validation. Auto-backup before apply.",
    "config.validate": "Validate",
    "config.save": "Save",
    "config.format": "Format",
    "config.validateFirst": "Validate config first",
    "config.valid": "✓ Valid",
    "config.error": "✗ Error",
    "config.qCore": "Core settings",
    "config.qCoreSub": "mode, ports, ipv6, allow-lan",
    "config.qMode": "Work mode (mode)",
    "config.qLogLevel": "Log level (log-level)",
    "config.export": "↓ Export",
    "config.import": "↑ Import",
    "config.qExtUI": "External Controller",
    "config.qExtUISub": "Clash API connection",
    "config.qSniffer": "Sniffer",
    "config.qSnifferSub": "Traffic interception (HTTP, TLS, QUIC)",
    "config.qProviders": "Proxy providers",
    "config.qProvidersSub": "Subscriptions, health-check, headers",
    "config.qProvidersRefresh": "Refresh subscription",
    "config.qSubUrl": "Subscription URL",
    "config.qHwid": "x-hwid",
    "config.qHwidHint": "Some providers require x-hwid for authorization",
    "config.qHealthUrl": "Health-check URL",
    "config.qHealthInterval": "Check interval (sec)",
    "config.qDNS": "DNS",
    "config.qDNSSub": "Resolver, fake-ip, cache",
    "config.qGeo": "GEO data",
    "config.qGeoSub": "Auto-update, geo database sources",
    "config.qGeoHint": "Interval in hours",
    "config.qGeoSiteUrl": "GeoSite URL",
    "config.qGeoSiteHint": "Domain list source (geosite)",
    "config.qGeoIpUrl": "GeoIP URL",
    "config.qGeoIpHint": "IP database source (geoip)",
    "config.qApply": "Apply changes",
    "config.qReset": "Reset",

    // Groups
    "groups.title": "Groups",
    "groups.subtitle": "Manage proxy-groups in config.yaml",
    "groups.newGroup": "New group",
    "groups.newGroupSub": "Appears in Proxy tab as select type",
    "groups.name": "Group name",
    "groups.namePlaceholder": "MY-GROUP",
    "groups.nameHint": "Will appear in Proxy tab for server selection",
    "groups.add": "Add",
    "groups.existingTitle": "Existing groups",
    "groups.existingCount": "{count} groups",
    "groups.delete": "Delete",
    "groups.confirmDelete": "Confirm",
    "groups.preview": "Preview",
    "groups.previewSub": "config.yaml fragment",

    // Policies
    "policies.title": "IP Policies",
    "policies.subtitle": "Per-IP rules in mihomo rules · IP only",
    "policies.newPolicy": "New policy",
    "policies.newPolicySub": "Adds rule to config.yaml",
    "policies.ip": "Device IP address",
    "policies.ipPlaceholder": "192.168.1.50",
    "policies.ipHint": "IP only, no device names",
    "policies.policyType": "Policy type",
    "policies.typeGroup": "Proxy group — IP-CIDR → GROUP",
    "policies.typeRule": "Rule — IP-CIDR → custom target",
    "policies.proxyGroup": "Proxy group",
    "policies.ruleTarget": "Rule target",
    "policies.add": "Add policy",
    "policies.activeTitle": "Active policies",
    "policies.rules": "{count} rules",
    "policies.group": "group",
    "policies.rule": "rule",

    // Settings
    "settings.title": "Settings",
    "settings.subtitle": "Mode, security, updates",
    "settings.modeTitle": "Work mode",
    "settings.modeSafe": "Config validation before save, auto-backup, dangerous action confirmation.",
    "settings.modeExpert": "Direct editing without restrictions. Recommended for experienced users.",
    "settings.auth": "Authorization",
    "settings.login": "Login",
    "settings.password": "New password",
    "settings.changePassword": "Change password",
    "settings.updates": "Updates",
    "settings.updatesSub": "xkeen, mihomo, zkeen-ui",
    "settings.downloadMethod": "Download method",
    "settings.direct": "Direct — from GitHub",
    "settings.proxy": "Proxy — through proxy",
    "settings.installed": "Installed",
    "settings.latest": "Latest",
    "settings.update": "Update",
    "settings.upToDate": "Up to date",
    "settings.updateAvailable": "Update available",
    "settings.clashApi": "Clash API",
    "settings.clashApiSub": "Connect to Mihomo",
    "settings.language": "Language / Язык",

    // Mock banner
    "mock.banner": "UI prototype · demo data · functionality not connected",

    "app.loading": "Loading…",
    "auth.loginTitle": "Sign in",
    "auth.loginSub": "Enter panel password",
    "auth.setupTitle": "Initial setup",
    "auth.setupSub": "Set a password for panel access",
    "auth.password": "Password",
    "auth.confirmPassword": "Confirm password",
    "auth.loginAction": "Sign in",
    "auth.setupAction": "Save",
    "auth.logout": "Sign out",
    "auth.passwordShort": "At least 4 characters",
    "auth.passwordMismatch": "Passwords do not match",
    "auth.failed": "Authentication failed",
    "proxies.loadError": "Failed to load proxy groups",
    "proxies.switchError": "Failed to switch node",
    "status.actionError": "Action failed",
    "settings.saveClash": "Save Clash API",
    "settings.saved": "Saved",
    "settings.unixHint": "Socket filename in Mihomo dir (instead of TCP port)",
    "settings.subscription": "VPS subscription",
    "settings.subscriptionSub": "Proxy-provider URL to fetch server list",
    "settings.saveSubscription": "Save and refresh",

    "onboarding.title": "Welcome to zKeen UI",
    "onboarding.subtitle": "Initial setup",
    "onboarding.hint": "Paste your subscription URL to load VPS nodes into Mihomo. You can skip and add it later in Config.",
    "onboarding.subUrl": "Subscription URL",
    "onboarding.subHint": "Written to proxy-providers.subscription",
    "onboarding.skip": "Skip",
    "onboarding.continue": "Continue",
    "onboarding.failed": "Failed to apply subscription",

    "config.reload": "Reload",
    "config.notFound": "config.yaml not found in /opt/etc/mihomo/. Re-run install or copy the default template.",
    "config.validateError": "Config validation failed",
    "config.saveError": "Failed to save config",
    "config.refreshError": "Failed to refresh provider",
    "config.quickMockNote": "Other quick settings coming soon. Use YAML editor (Expert) for now.",
  },
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getSavedLocale(): Locale {
  try {
    const saved = localStorage.getItem("zkeen-locale");
    if (saved === "en" || saved === "ru") return saved;
  } catch { /* noop */ }
  return "ru";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleRaw] = useState<Locale>(getSavedLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleRaw(l);
    try { localStorage.setItem("zkeen-locale", l); } catch { /* noop */ }
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    let str = translations[locale]?.[key] ?? translations.ru[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, String(v));
      }
    }
    return str;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  return ctx;
}

export function useT() {
  return useI18n().t;
}

export const AVAILABLE_LOCALES: { value: Locale; label: string }[] = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
];
