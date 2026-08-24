import { ApiError, apiJson, clashJson, parseClashFromYaml, saveClashConnection, type ApiResponse, type ClashConnection } from "./api";

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
  return yaml.match(new RegExp(`^${key}:\\s*['"]?([^'"\n#]+)`, "m"))?.[1]?.trim() ?? "";
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

function normalizeMihomoConfigPath(path: string): string {
  if (/config\.ya?ml$/i.test(path)) {
    return DEFAULT_CONFIG_PATH;
  }
  return path;
}

export async function saveMihomoConfig(
  path: string,
  content: string,
  validate = false,
): Promise<void> {
  const file = normalizeMihomoConfigPath(path);
  const query = validate ? "?validate=mihomo" : "";
  await apiJson(`/api/configs${query}`, {
    method: "PUT",
    body: JSON.stringify({ file, content }),
  });
}

function mergeClashConnection(
  clash: ClashConnection,
  parsed: Partial<ClashConnection>,
): ClashConnection {
  return {
    port: parsed.port || clash.port || "9090",
    secret: parsed.secret ?? clash.secret ?? "",
    unix: parsed.unix ?? clash.unix ?? "",
  };
}

async function resolveClashConnection(clash: ClashConnection): Promise<ClashConnection> {
  const loaded = await fetchMihomoConfig();
  if (!loaded) return clash;
  const parsed = parseClashFromYaml(loaded.content);
  const merged = mergeClashConnection(clash, parsed);
  saveClashConnection(merged);
  return merged;
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

/** Switch to mihomo and wait until Clash API responds (zashboard talks to a running core). */
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

/** zashboard-style: ensure mihomo is up, reload config, refresh proxy-provider */
export async function applyMihomoConfigChanges(
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

/** Top-level keys that end a proxy-providers subsection. */
const PROVIDER_SECTION_STOP = /^(proxies|proxy-groups|rules|dns|geox-url|sniffer|tun|profile):/;

function isProviderHeaderLine(raw: string, provider: string): boolean {
  const header = `  ${provider}:`;
  return raw === header || raw.startsWith(`${header} `) || raw.startsWith(`${header}\t`);
}

/**
 * Line range [startLine, endLine) for one proxy-provider block (includes the `  name:` line).
 * Line-based — avoids /m+$ regex bugs that only strip the header and leave orphan fields.
 */
function findProviderBlockLineRange(
  lines: string[],
  provider: string,
): { startLine: number; endLine: number } | null {
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    if (isProviderHeaderLine(raw, provider)) {
      startLine = i;
      break;
    }
  }
  if (startLine < 0) return null;

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    // Next provider at same indent: `  other:`
    if (/^  [a-zA-Z][\w-]*:/.test(line) && !line.startsWith("    ")) {
      endLine = i;
      break;
    }
    // Next top-level section
    if (PROVIDER_SECTION_STOP.test(line)) {
      endLine = i;
      break;
    }
  }
  return { startLine, endLine };
}

function findProviderBlockRange(
  yaml: string,
  provider: string,
): { start: number; end: number } | null {
  const lines = yaml.split("\n");
  const range = findProviderBlockLineRange(lines, provider);
  if (!range) return null;
  let start = 0;
  for (let i = 0; i < range.startLine; i++) start += lines[i].length + 1;
  let end = start;
  for (let i = range.startLine; i < range.endLine; i++) end += lines[i].length + 1;
  return { start, end };
}

function providerSection(yaml: string, provider: string): string {
  const range = findProviderBlockRange(yaml, provider);
  if (!range) return "";
  return yaml.slice(range.start, range.end);
}

function removeProviderBlocks(yaml: string, provider: string): string {
  const lines = yaml.split("\n");
  // Remove every occurrence (corrupted configs may have duplicates).
  // Important: do NOT eat the newline after `proxy-providers:` — that glued
  // `proxy-providers:` + `proxies: []` into one invalid line.
  for (;;) {
    const range = findProviderBlockLineRange(lines, provider);
    if (!range) break;
    lines.splice(range.startLine, range.endLine - range.startLine);
  }
  return lines.join("\n");
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

export function getSubscriptionUrl(yaml: string, provider = DEFAULT_PROVIDER): string {
  if (!yaml.includes("proxy-providers:")) return "";
  const section = providerSection(yaml, provider);
  if (!section) return "";
  // Only the provider url — stop at health-check (its url is a probe, not the subscription).
  for (const line of section.split("\n")) {
    const raw = line.replace(/\r$/, "");
    if (/^\s+health-check\s*:/.test(raw)) break;
    if (!/^\s+url:/.test(raw)) continue;
    const val = raw.replace(/^\s+url:\s*/, "").replace(/^['"]|['"]$/g, "").trim();
    if (!val) continue;
    return val;
  }
  return "";
}

export function getSubscriptionHwid(yaml: string, provider = DEFAULT_PROVIDER): string {
  if (!yaml.includes("proxy-providers:")) return "";
  const section = providerSection(yaml, provider);
  if (!section) return "";
  return section.match(/x-hwid:\s*\n\s*-\s*['"]?([^'"\n#]*)['"]?/)?.[1]?.trim() ?? "";
}

export function getSubscriptionUserAgent(yaml: string, provider = DEFAULT_PROVIDER): string {
  if (!yaml.includes("proxy-providers:")) return DEFAULT_SUBSCRIPTION_USER_AGENT;
  const section = providerSection(yaml, provider);
  if (!section) return DEFAULT_SUBSCRIPTION_USER_AGENT;
  const match = section.match(/User-Agent:\s*\n\s*-\s*['"]?([^'"\n#]*)['"]?/i);
  return match?.[1]?.trim() || DEFAULT_SUBSCRIPTION_USER_AGENT;
}

export function updateSubscriptionProvider(
  yaml: string,
  patch: { url?: string; hwid?: string; userAgent?: string },
  provider = DEFAULT_PROVIDER,
): string {
  const currentUrl = getSubscriptionUrl(yaml, provider);
  const currentHwid = getSubscriptionHwid(yaml, provider);
  const currentUa = getSubscriptionUserAgent(yaml, provider);
  const url =
    patch.url !== undefined ? normalizeSubscriptionUrlInput(patch.url) : currentUrl;
  const hwid = patch.hwid !== undefined ? patch.hwid.trim() : currentHwid;
  const userAgent =
    patch.userAgent !== undefined ? patch.userAgent.trim() : currentUa;

  // Allow empty URL in YAML (user is typing / clearing the field).
  const block = buildProviderBlock(provider, url, hwid, userAgent);
  const cleaned = removeProviderBlocks(yaml, provider);
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
  await saveMihomoConfig(loaded.path, updated, true);
  return {
    path: normalizeMihomoConfigPath(loaded.path),
    clash: await applyMihomoConfigChanges(clash, { hardRestart: bootstrapped }),
  };
}
