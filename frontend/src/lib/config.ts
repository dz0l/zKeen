import { ApiError, apiJson, clashJson, parseClashFromYaml, saveClashConnection, type ApiResponse, type ClashConnection } from "./api";
import { withSelectionSnapshots } from "./opJournal";
import { editSubscriptionProvider, readSubscriptionProvider, readTopLevelScalar } from "./mihomoYaml";

export interface ControlInfo {
  cores: string[];
  currentCore: string;
  running: boolean;
  mihomoRunning?: boolean;
  xrayRunning?: boolean;
  xkeenRunning?: boolean;
}

export interface ConfigItem {
  file: string;
  content: string;
}

/** @deprecated Was browser-local; onboarding is gated by empty subscription URL in YAML. */
export const ONBOARDING_KEY = "zkeen-onboarding-v1";
/** Session-only dismiss for "Skip" while subscription URL is still empty. */
export const ONBOARDING_SKIP_KEY = "zkeen-onboarding-skip-session";
export const DEFAULT_PROVIDER = "subscription";
export const DEFAULT_SUBSCRIPTION_USER_AGENT = "zkeen";
export const DEFAULT_CONFIG_PATH = "/opt/etc/mihomo/config.yaml";

export function isOnboardingSkippedThisSession(): boolean {
  try {
    return sessionStorage.getItem(ONBOARDING_SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function skipOnboardingThisSession() {
  try {
    sessionStorage.setItem(ONBOARDING_SKIP_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearOnboardingSessionSkip() {
  try {
    sessionStorage.removeItem(ONBOARDING_SKIP_KEY);
  } catch {
    /* ignore */
  }
}

/** Drop legacy localStorage flag so old browsers do not hide an empty-URL setup. */
export function clearLegacyOnboardingFlag() {
  try {
    localStorage.removeItem(ONBOARDING_KEY);
  } catch {
    /* ignore */
  }
}

export function pickMainConfig(configs: ConfigItem[]): ConfigItem | null {
  if (!configs.length) return null;
  const exact = configs.find((c) => c.file === DEFAULT_CONFIG_PATH);
  if (exact) return exact;
  const named = configs.find((c) => /(^|\/)config\.ya?ml$/i.test(c.file));
  return named ?? configs[0];
}

export function isZkeenReadyConfig(yaml: string): boolean {
  return yaml.includes("external-controller:") && yaml.includes("proxy-groups:");
}

/** Replace XKeen stub config with the full zKeen template (preserves subscription URL/hwid). */
export async function ensureZkeenMihomoConfig(force = false): Promise<boolean> {
  const res = await apiJson<ApiResponse<{ bootstrapped: boolean; file: string }>>(
    "/api/configs/bootstrap",
    {
      method: "POST",
      body: JSON.stringify({ file: DEFAULT_CONFIG_PATH, force }),
    },
  );
  return Boolean(res.data?.bootstrapped);
}

export function getTopLevelScalar(yaml: string, key: string): string {
  return readTopLevelScalar(yaml, key) ?? "";
}

export function setTopLevelScalar(yaml: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:\\s*.+$`, "m");
  if (re.test(yaml)) return yaml.replace(re, line);
  return `${line}\n${yaml}`;
}

export async function fetchMihomoConfig(): Promise<{ path: string; content: string } | null> {
  const res = await apiJson<{ configs: ConfigItem[] }>("/api/configs?core=mihomo");
  const item = pickMainConfig(res.configs ?? []);
  if (!item) return null;
  return { path: item.file, content: item.content };
}

/**
 * Atomic save of exactly `path` as returned by the server (server keeps one `<file>.zkeen.bak`);
 * `validate` runs `mihomo -t` on this exact content first.
 */
export async function saveMihomoConfig(
  path: string,
  content: string,
  validate = false,
): Promise<{ backup?: string }> {
  const query = validate ? "?validate=mihomo" : "";
  const res = await apiJson<{ backup?: string }>(`/api/configs${query}`, {
    method: "PUT",
    body: JSON.stringify({ file: path, content }),
  });
  return { backup: res.backup };
}

/** Read-only check with the core: the working file is not touched. */
export async function validateMihomoConfig(path: string, content: string): Promise<void> {
  await apiJson("/api/configs/validate?core=mihomo", {
    method: "POST",
    body: JSON.stringify({ file: path, content }),
  });
}

/** Apply failed after the new file was written; `rolledBack` tells whether `previous` is on disk and applied again. */
export class ConfigApplyError extends Error {
  readonly applyError: unknown;
  readonly rolledBack: boolean;
  readonly rollbackError?: unknown;

  constructor(applyError: unknown, rolledBack: boolean, rollbackError?: unknown) {
    super(applyError instanceof Error ? applyError.message : String(applyError));
    this.name = "ConfigApplyError";
    this.applyError = applyError;
    this.rolledBack = rolledBack;
    this.rollbackError = rollbackError;
  }
}

/**
 * Save `content`, apply it, and when apply fails write `previous` back and apply it again,
 * so a config the core rejected does not stay as the working file.
 */
export async function commitMihomoConfig(
  clash: ClashConnection,
  opts: {
    path: string;
    content: string;
    previous: string;
    validate: boolean;
    hardRestart?: boolean;
  },
): Promise<{ clash: ClashConnection; backup?: string }> {
  const { backup } = await saveMihomoConfig(opts.path, opts.content, opts.validate);
  try {
    return { clash: await applyMihomoConfigChanges(clash, { hardRestart: opts.hardRestart }), backup };
  } catch (applyErr) {
    if (opts.previous === opts.content) throw new ConfigApplyError(applyErr, false);
    try {
      await saveMihomoConfig(opts.path, opts.previous, false);
      await applyMihomoConfigChanges(clash, { hardRestart: opts.hardRestart });
    } catch (rollbackErr) {
      throw new ConfigApplyError(applyErr, false, rollbackErr);
    }
    throw new ConfigApplyError(applyErr, true);
  }
}

async function resolveClashConnection(clash: ClashConnection): Promise<ClashConnection> {
  const loaded = await fetchMihomoConfig();
  if (!loaded) return clash;
  // The config is the source of truth: an absent secret/unix clears the stored value.
  const parsed = parseClashFromYaml(loaded.content);
  if (!parsed) return clash;
  saveClashConnection(parsed);
  return parsed;
}

export async function waitForClashApi(
  clash: ClashConnection,
  attempts = 40,
  delayMs = 500,
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await clashJson<{ version?: string }>("version", clash);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const where = clash.unix
    ? `unix:${clash.unix}`
    : `127.0.0.1:${clash.port || "9090"}`;
  throw lastError instanceof ApiError
    ? lastError
    : new ApiError(502, `Mihomo API not reachable (${where})`);
}

/** Switch to mihomo and wait until Clash API responds (the UI talks to a running core). */
export async function ensureMihomoRunning(clash: ClashConnection): Promise<ClashConnection> {
  const conn = await resolveClashConnection(clash);
  const control = await apiJson<ControlInfo & { success: boolean }>("/api/control");

  if (control.currentCore !== "mihomo") {
    await apiJson("/api/control", {
      method: "POST",
      body: JSON.stringify({ action: "switchCore", core: "mihomo" }),
    });
  } else {
    try {
      await clashJson("version", conn);
      return conn;
    } catch {
      await apiJson("/api/control", {
        method: "POST",
        body: JSON.stringify({ action: "start" }),
      });
    }
  }

  await waitForClashApi(conn);
  return conn;
}

export function isClashConnectionError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("error sending request") ||
    msg.includes("connection refused") ||
    msg.includes("not reachable") ||
    msg.includes("connect timeout") ||
    msg.includes("clash api timeout") ||
    err.status === 408 ||
    err.status === 502
  );
}

async function reloadMihomoCore(): Promise<void> {
  try {
    await apiJson("/api/control", {
      method: "POST",
      body: JSON.stringify({ action: "softRestart", core: "mihomo" }),
    });
  } catch {
    /* core may be stopped */
  }
}

export async function reloadClashConfig(clash: ClashConnection): Promise<void> {
  await clashJson("configs?reload=true", clash, {
    method: "PUT",
    body: JSON.stringify({ path: "", payload: "" }),
  });
}

async function hardRestartMihomo(conn: ClashConnection): Promise<void> {
  await apiJson("/api/control", {
    method: "POST",
    body: JSON.stringify({ action: "hardRestart", core: "mihomo" }),
  });
  await waitForClashApi(conn, 60, 500);
}

export async function applyMihomoConfigChanges(
  clash: ClashConnection,
  opts?: { hardRestart?: boolean },
): Promise<ClashConnection> {
  return withSelectionSnapshots(
    opts?.hardRestart ? "apply-config-restart" : "apply-config",
    clash,
    () => applyConfigToCore(clash, opts),
    (conn) => conn,
  );
}

async function applyConfigToCore(
  clash: ClashConnection,
  opts?: { hardRestart?: boolean },
): Promise<ClashConnection> {
  const conn = await resolveClashConnection(clash);
  if (opts?.hardRestart) {
    await hardRestartMihomo(conn);
  } else {
    try {
      const running = await ensureMihomoRunning(clash);
      try {
        await reloadClashConfig(running);
      } catch {
        await reloadMihomoCore();
        await waitForClashApi(running, 40, 500);
      }
    } catch (err) {
      if (!isClashConnectionError(err)) throw err;
      // Soft path failed (API down mid-reload) — hard restart and wait longer.
      await hardRestartMihomo(conn);
    }
  }
  await refreshProxyProvider(DEFAULT_PROVIDER, conn).catch(() => {
    /* empty subscription URL or provider not ready — core may still be fine */
  });
  return conn;
}

export async function refreshProxyProvider(
  providerName: string,
  clash: ClashConnection,
): Promise<void> {
  await clashJson(`providers/proxies/${encodeURIComponent(providerName)}`, clash, {
    method: "PUT",
  });
}

/** Run health-check for all nodes in a proxy-provider (updates delay history). */
export async function healthCheckProxyProvider(
  providerName: string,
  clash: ClashConnection,
  timeoutMs = 300000,
): Promise<void> {
  await clashJson(
    `providers/proxies/${encodeURIComponent(providerName)}/healthcheck`,
    clash,
    undefined,
    timeoutMs,
  );
}

/** Trigger Mihomo GEO database download (`POST /configs/geo`, fallback `/upgrade/geo`). */
export async function updateGeoDatabases(clash: ClashConnection): Promise<void> {
  try {
    await clashJson("configs/geo", clash, { method: "POST" }, 180000);
  } catch {
    await clashJson("upgrade/geo", clash, { method: "POST" }, 180000);
  }
}

function escapeYamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeSubscriptionUrlInput(raw: string): string {
  let url = raw.trim();
  if (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1).trim();
  }
  return url;
}

function buildProviderBlock(
  provider: string,
  url: string,
  hwid: string,
  userAgent: string,
): string {
  const ua = escapeYamlDoubleQuoted(userAgent.trim() || DEFAULT_SUBSCRIPTION_USER_AGENT);
  const safeUrl = escapeYamlDoubleQuoted(url);
  const hwidSection = hwid
    ? `\n      x-hwid:\n        - "${escapeYamlDoubleQuoted(hwid)}"`
    : "";
  return `  ${provider}:
    type: http
    url: "${safeUrl}"
    path: ./proxy-providers/${provider}.yaml
    interval: 0
    header:
      User-Agent:
        - "${ua}"${hwidSection}
    health-check:
      enable: true
      url: http://www.msftncsi.com/ncsi.txt
      interval: 3000
`;
}

/** Provider's own `url` (not health-check.url), read regardless of key order. */
export function getSubscriptionUrl(yaml: string, provider = DEFAULT_PROVIDER): string {
  return readSubscriptionProvider(yaml, provider)?.url ?? "";
}

export function getSubscriptionHwid(yaml: string, provider = DEFAULT_PROVIDER): string {
  return readSubscriptionProvider(yaml, provider)?.hwid ?? "";
}

export function getSubscriptionUserAgent(yaml: string, provider = DEFAULT_PROVIDER): string {
  return readSubscriptionProvider(yaml, provider)?.userAgent || DEFAULT_SUBSCRIPTION_USER_AGENT;
}

/**
 * Edit url / User-Agent / x-hwid in place; all other provider settings are kept.
 * A missing provider is created from the default block.
 */
export function updateSubscriptionProvider(
  yaml: string,
  patch: { url?: string; hwid?: string; userAgent?: string },
  provider = DEFAULT_PROVIDER,
): string {
  const fields = {
    // Empty URL is allowed in YAML (user is typing / clearing the field).
    url: patch.url !== undefined ? normalizeSubscriptionUrlInput(patch.url) : undefined,
    hwid: patch.hwid !== undefined ? patch.hwid.trim() : undefined,
    userAgent:
      patch.userAgent !== undefined
        ? patch.userAgent.trim() || DEFAULT_SUBSCRIPTION_USER_AGENT
        : undefined,
  };
  const edited = editSubscriptionProvider(yaml, provider, fields);
  if (edited !== null) return edited;

  const block = buildProviderBlock(
    provider,
    fields.url ?? "",
    fields.hwid ?? "",
    fields.userAgent ?? DEFAULT_SUBSCRIPTION_USER_AGENT,
  );
  const cleaned = yaml;
  const lines = cleaned.split("\n");
  const blockLines = block.replace(/\n$/, "").split("\n");

  const idx = lines.findIndex((l) => {
    const raw = l.replace(/\r$/, "").trim();
    return raw === "proxy-providers:" || /^proxy-providers:\s*(#.*)?$/.test(raw);
  });
  if (idx >= 0) {
    // Insert right after the section header (keep a blank line after the block).
    lines.splice(idx + 1, 0, ...blockLines, "");
    return lines.join("\n");
  }

  const insert = `\nproxy-providers:\n${block}\n`;
  const anchor = cleaned.match(/\n(proxies|proxy-groups|rules):/);
  if (anchor?.index !== undefined) {
    return cleaned.slice(0, anchor.index) + insert + cleaned.slice(anchor.index);
  }
  return `${cleaned.trimEnd()}${insert}`;
}

export function setSubscriptionUrl(
  yaml: string,
  url: string,
  provider = DEFAULT_PROVIDER,
): string {
  return updateSubscriptionProvider(yaml, { url }, provider);
}

export function setSubscriptionHwid(
  yaml: string,
  hwid: string,
  provider = DEFAULT_PROVIDER,
): string {
  return updateSubscriptionProvider(yaml, { hwid }, provider);
}

export function setSubscriptionUserAgent(
  yaml: string,
  userAgent: string,
  provider = DEFAULT_PROVIDER,
): string {
  return updateSubscriptionProvider(yaml, { userAgent }, provider);
}

export async function applySubscriptionUrl(
  url: string,
  clash: ClashConnection,
  hwid = "",
  userAgent = DEFAULT_SUBSCRIPTION_USER_AGENT,
): Promise<{ path: string; clash: ClashConnection }> {
  const bootstrapped = await ensureZkeenMihomoConfig();
  const loaded = await fetchMihomoConfig();
  if (!loaded) {
    throw new Error(
      `Mihomo config missing (${DEFAULT_CONFIG_PATH}). Re-run install or bootstrap default config.`,
    );
  }
  const updated = updateSubscriptionProvider(loaded.content, { url, hwid, userAgent });
  const res = await commitMihomoConfig(clash, {
    path: loaded.path,
    content: updated,
    previous: loaded.content,
    validate: true,
    hardRestart: bootstrapped,
  });
  return { path: loaded.path, clash: res.clash };
}
