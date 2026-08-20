import { ApiError, apiJson, clashJson, parseClashFromYaml, saveClashConnection, type ApiResponse, type ClashConnection } from "./api";

export interface ControlInfo {
  cores: string[];
  currentCore: string;
  running: boolean;
}

export interface ConfigItem {
  file: string;
  content: string;
}

export const ONBOARDING_KEY = "zkeen-onboarding-v1";
export const DEFAULT_PROVIDER = "subscription";
export const DEFAULT_CONFIG_PATH = "/opt/etc/mihomo/config.yaml";

export function isOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "done";
  } catch {
    return false;
  }
}

export function completeOnboarding() {
  localStorage.setItem(ONBOARDING_KEY, "done");
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
  attempts = 24,
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
  throw lastError instanceof ApiError
    ? lastError
    : new ApiError(502, "Mihomo API not reachable on 127.0.0.1:9090");
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

/** zashboard-style: ensure mihomo is up, reload config, refresh proxy-provider */
export async function applyMihomoConfigChanges(
  clash: ClashConnection,
  opts?: { hardRestart?: boolean },
): Promise<ClashConnection> {
  const conn = await ensureMihomoRunning(clash);
  if (opts?.hardRestart) {
    await apiJson("/api/control", {
      method: "POST",
      body: JSON.stringify({ action: "hardRestart", core: "mihomo" }),
    });
    await waitForClashApi(conn, 40, 500);
  } else {
    try {
      await reloadClashConfig(conn);
    } catch {
      await reloadMihomoCore();
      await waitForClashApi(conn);
    }
  }
  await refreshProxyProvider(DEFAULT_PROVIDER, conn);
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

const providerBlockRe = (provider: string) =>
  new RegExp(
    `\\n  ${provider}:[\\s\\S]*?(?=\\n  [a-zA-Z][\\w-]*:|\\nproxies:|\\nproxy-groups:|\\nrules:|\\ndns:|\\ngeox-url:)`,
    "m",
  );

function removeProviderBlocks(yaml: string, provider: string): string {
  const re = new RegExp(
    `\\n  ${provider}:[\\s\\S]*?(?=\\n  [a-zA-Z][\\w-]*:|\\nproxies:|\\nproxy-groups:|\\nrules:|\\ndns:|\\ngeox-url:|$)`,
    "gm",
  );
  return yaml.replace(re, "");
}

function buildProviderBlock(provider: string, url: string, hwid: string): string {
  const hwidSection = hwid ? `\n      x-hwid:\n        - "${hwid}"` : "";
  return `  ${provider}:
    type: http
    url: "${url}"
    path: ./proxy-providers/${provider}.yaml
    interval: 0
    header:
      User-Agent:
        - "Mihomo"${hwidSection}
    health-check:
      enable: true
      url: http://www.msftncsi.com/ncsi.txt
      interval: 3000
`;
}

function providerSection(yaml: string, provider: string): string {
  return yaml.match(providerBlockRe(provider))?.[0] ?? "";
}

export function getSubscriptionUrl(yaml: string, provider = DEFAULT_PROVIDER): string {
  if (!yaml.includes("proxy-providers:")) return "";
  const section = providerSection(yaml, provider);
  if (!section) return "";
  return section.match(/url:\s*['"]?([^'"\n#]*)['"]?/)?.[1]?.trim() ?? "";
}

export function getSubscriptionHwid(yaml: string, provider = DEFAULT_PROVIDER): string {
  if (!yaml.includes("proxy-providers:")) return "";
  const section = providerSection(yaml, provider);
  if (!section) return "";
  return section.match(/x-hwid:\s*\n\s*-\s*['"]?([^'"\n#]*)['"]?/)?.[1]?.trim() ?? "";
}

export function updateSubscriptionProvider(
  yaml: string,
  patch: { url?: string; hwid?: string },
  provider = DEFAULT_PROVIDER,
): string {
  const currentUrl = getSubscriptionUrl(yaml, provider);
  const currentHwid = getSubscriptionHwid(yaml, provider);
  const url = patch.url !== undefined ? patch.url.trim() : currentUrl;
  const hwid = patch.hwid !== undefined ? patch.hwid.trim() : currentHwid;

  if (!url) return yaml;

  const block = buildProviderBlock(provider, url, hwid);
  let cleaned = removeProviderBlocks(yaml, provider);

  if (cleaned.includes("proxy-providers:")) {
    return cleaned.replace(/(\nproxy-providers:\s*\n)/, `$1${block}\n`);
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

export async function applySubscriptionUrl(
  url: string,
  clash: ClashConnection,
  hwid = "",
): Promise<{ path: string; clash: ClashConnection }> {
  const bootstrapped = await ensureZkeenMihomoConfig();
  const loaded = await fetchMihomoConfig();
  if (!loaded) {
    throw new Error(
      `Mihomo config missing (${DEFAULT_CONFIG_PATH}). Re-run install or bootstrap default config.`,
    );
  }
  const updated = updateSubscriptionProvider(loaded.content, { url, hwid });
  await saveMihomoConfig(loaded.path, updated, false);
  return {
    path: normalizeMihomoConfigPath(loaded.path),
    clash: await applyMihomoConfigChanges(clash, { hardRestart: bootstrapped }),
  };
}
