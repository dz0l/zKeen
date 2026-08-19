import { apiJson, clashJson, type ClashConnection } from "./api";

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

/** zashboard-style: reload config on disk, then refresh proxy-provider */
export async function applyMihomoConfigChanges(clash: ClashConnection): Promise<void> {
  try {
    await reloadClashConfig(clash);
  } catch {
    await reloadMihomoCore();
  }
  try {
    await refreshProxyProvider(DEFAULT_PROVIDER, clash);
  } catch {
    /* provider refresh optional if core still reloading */
  }
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
  const blockRe = providerBlockRe(provider);

  if (yaml.includes("proxy-providers:") && blockRe.test(yaml)) {
    return yaml.replace(blockRe, `\n${block}`);
  }

  if (yaml.includes("proxy-providers:")) {
    return yaml.replace(/(\nproxy-providers:\s*\n)/, `$1${block}\n`);
  }

  const insert = `\nproxy-providers:\n${block}\n`;
  const anchor = yaml.match(/\n(proxies|proxy-groups|rules):/);
  if (anchor?.index !== undefined) {
    return yaml.slice(0, anchor.index) + insert + yaml.slice(anchor.index);
  }
  return `${yaml.trimEnd()}${insert}`;
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
): Promise<{ path: string }> {
  const loaded = await fetchMihomoConfig();
  if (!loaded) {
    throw new Error(
      `Mihomo config missing (${DEFAULT_CONFIG_PATH}). Re-run install or bootstrap default config.`,
    );
  }
  const updated = updateSubscriptionProvider(loaded.content, { url, hwid });
  await saveMihomoConfig(loaded.path, updated, false);
  await applyMihomoConfigChanges(clash);
  return { path: normalizeMihomoConfigPath(loaded.path) };
}
