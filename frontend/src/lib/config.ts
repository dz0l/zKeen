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

export async function saveMihomoConfig(
  path: string,
  content: string,
  validate = false,
): Promise<void> {
  const query = validate ? "?validate=mihomo" : "";
  await apiJson(`/api/configs${query}`, {
    method: "PUT",
    body: JSON.stringify({ file: path, content }),
  });
}

export async function refreshProxyProvider(
  providerName: string,
  clash: ClashConnection,
): Promise<void> {
  await clashJson(`providers/proxies/${encodeURIComponent(providerName)}`, clash, {
    method: "PUT",
  });
}

const PROVIDER_TEMPLATE = (provider: string, url: string) => `  ${provider}:
    type: http
    url: "${url}"
    path: ./proxy-providers/${provider}.yaml
    interval: 0
    header:
      User-Agent:
        - "Mihomo"
    health-check:
      enable: true
      url: http://www.msftncsi.com/ncsi.txt
      interval: 3000
`;

export function getSubscriptionUrl(yaml: string, provider = DEFAULT_PROVIDER): string {
  if (!yaml.includes("proxy-providers:")) return "";
  const re = new RegExp(
    `${provider}:[\\s\\S]*?url:\\s*['"]?([^'"\n#]*)['"]?`,
    "m",
  );
  const raw = yaml.match(re)?.[1]?.trim() ?? "";
  return raw;
}

export function setSubscriptionUrl(
  yaml: string,
  url: string,
  provider = DEFAULT_PROVIDER,
): string {
  const trimmed = url.trim();
  if (!trimmed) return yaml;

  const providerBlockRe = new RegExp(
    `(\\n\\s*${provider}:[\\s\\S]*?\\n\\s*url:\\s*)['"]?[^'"\n#]*['"]?`,
    "m",
  );
  if (yaml.includes("proxy-providers:") && providerBlockRe.test(yaml)) {
    return yaml.replace(providerBlockRe, `$1"${trimmed}"`);
  }

  const newProvider = `${PROVIDER_TEMPLATE(provider, trimmed)}\n`;

  if (yaml.includes("proxy-providers:")) {
    return yaml.replace(/(\nproxy-providers:\s*\n)/, `$1${newProvider}`);
  }

  const block = `\nproxy-providers:\n${newProvider}`;

  const anchor = yaml.match(/\n(proxies|proxy-groups|rules):/);
  if (anchor?.index !== undefined) {
    return yaml.slice(0, anchor.index) + block + yaml.slice(anchor.index);
  }
  return `${yaml.trimEnd()}${block}\n`;
}

export async function applySubscriptionUrl(
  url: string,
  clash: ClashConnection,
): Promise<{ path: string }> {
  const loaded = await fetchMihomoConfig();
  if (!loaded) {
    throw new Error(
      `Mihomo config missing (${DEFAULT_CONFIG_PATH}). Re-run install or bootstrap default config.`,
    );
  }
  const updated = setSubscriptionUrl(loaded.content, url);
  await saveMihomoConfig(loaded.path, updated, true);
  try {
    await refreshProxyProvider(DEFAULT_PROVIDER, clash);
  } catch {
    /* provider refresh optional if core still reloading */
  }
  return { path: loaded.path };
}
