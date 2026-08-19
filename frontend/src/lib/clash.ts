export interface ClashProxyItem {
  type: string;
  name: string;
  now?: string;
  all?: string[];
  history?: { time: string; delay: number }[];
  udp?: boolean;
}

export interface ClashProxiesResponse {
  proxies: Record<string, ClashProxyItem>;
}

export interface ClashDelayResponse {
  delay: number;
}

export interface ClashVersionResponse {
  version?: string;
  meta?: boolean;
}

export interface ClashMemoryResponse {
  inuse?: number;
  oslimit?: number;
  memory?: number;
}

export interface ClashConnectionsResponse {
  connections?: unknown[];
  downloadTotal?: number;
  uploadTotal?: number;
  memory?: number;
}

const GROUP_TYPES = new Set([
  "selector",
  "select",
  "urltest",
  "fallback",
  "loadbalance",
  "load-balance",
  "relay",
  "compatible",
]);

/** Built-in or meta groups — hidden from the UI list and bulk selector targets. */
export const HIDDEN_PROXY_GROUPS = new Set([
  "GLOBAL",
  "COMPATIBLE",
  "REJECT",
  "DIRECT",
  "PASS",
]);

export function isProxyGroup(item: ClashProxyItem): boolean {
  return GROUP_TYPES.has(item.type.toLowerCase());
}

export function isHiddenProxyGroup(name: string): boolean {
  return HIDDEN_PROXY_GROUPS.has(name);
}

export function isUserProxyGroup(item: ClashProxyItem): boolean {
  return isProxyGroup(item) && !isHiddenProxyGroup(item.name);
}

export function buildProxyNameSets(data: ClashProxiesResponse): {
  groupNames: Set<string>;
  leafNames: Set<string>;
} {
  const groupNames = new Set<string>();
  const leafNames = new Set<string>();

  for (const item of Object.values(data.proxies)) {
    if (isProxyGroup(item)) {
      groupNames.add(item.name);
    } else if (!isHiddenProxyGroup(item.name)) {
      leafNames.add(item.name);
    }
  }

  return { groupNames, leafNames };
}

export function collectBulkServerOptions(data: ClashProxiesResponse): string[] {
  const { leafNames } = buildProxyNameSets(data);
  const servers = Array.from(leafNames).sort((a, b) => a.localeCompare(b));
  if (!servers.includes("DIRECT")) {
    servers.unshift("DIRECT");
  } else {
    servers.sort((a, b) => {
      if (a === "DIRECT") return -1;
      if (b === "DIRECT") return 1;
      return a.localeCompare(b);
    });
  }
  return servers;
}

export function filterGroupMembers(all: string[] | undefined, groupNames: Set<string>): string[] {
  return (all ?? []).filter(
    (name) => name === "DIRECT" || name === "REJECT" || !groupNames.has(name),
  );
}

export function parseGroupIcons(yaml: string): Record<string, string> {
  const icons: Record<string, string> = {};
  if (!yaml.includes("proxy-groups:")) return icons;

  for (const block of yaml.split(/\n  - name:/).slice(1)) {
    const name = block.match(/^ ['"]?([^'"\n]+)/)?.[1]?.trim();
    const icon = block.match(/\n    icon: ['"]?([^'"\n]+)/)?.[1]?.trim();
    if (name && icon) {
      icons[name] = icon;
    }
  }
  return icons;
}

export function parseMemoryBytes(raw?: ClashMemoryResponse | null): number | undefined {
  if (!raw) return undefined;
  if (typeof raw.inuse === "number") return raw.inuse;
  if (typeof raw.memory === "number") return raw.memory;
  return undefined;
}

export function parseConnectionCount(raw?: ClashConnectionsResponse | null): number {
  if (!raw) return 0;
  if (Array.isArray(raw.connections)) return raw.connections.length;
  return 0;
}

export function formatTrafficTotal(raw?: ClashConnectionsResponse | null): string {
  if (!raw) return "—";
  const total = (raw.downloadTotal ?? 0) + (raw.uploadTotal ?? 0);
  if (total <= 0) return "0 B";
  return formatBytes(total);
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
