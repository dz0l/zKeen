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

export interface ClashConnectionMeta {
  network?: string;
  type?: string;
  sourceIP?: string;
  destinationIP?: string;
  sourcePort?: string;
  destinationPort?: string;
  host?: string;
  process?: string;
}

export interface ClashConnectionItem {
  id: string;
  metadata?: ClashConnectionMeta;
  upload?: number;
  download?: number;
  start?: string;
  chains?: string[];
  rule?: string;
  rulePayload?: string;
}

export interface ClashConnectionsResponse {
  connections?: ClashConnectionItem[] | null;
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

/** Built-in or meta groups — hidden from the UI list. */
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

/** Built-in non-server nodes (except DIRECT, which we keep for selection). */
export function isBuiltinSpecialNode(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === "DIRECT") return false;
  return (
    upper === "REJECT" ||
    upper.startsWith("REJECT") ||
    upper === "PASS" ||
    upper.startsWith("PASS") ||
    upper === "COMPATIBLE" ||
    upper === "GLOBAL"
  );
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

/** Servers for bulk select: DIRECT + subscription nodes from user groups (not PASS/REJECT*). */
export function collectBulkServerOptions(data: ClashProxiesResponse): string[] {
  const { groupNames } = buildProxyNameSets(data);
  const names = new Set<string>(["DIRECT"]);

  for (const item of Object.values(data.proxies)) {
    if (!isUserProxyGroup(item)) continue;
    for (const name of item.all ?? []) {
      if (groupNames.has(name)) continue;
      if (isBuiltinSpecialNode(name)) continue;
      names.add(name);
    }
  }

  return Array.from(names).sort((a, b) => {
    if (a === "DIRECT") return -1;
    if (b === "DIRECT") return 1;
    return a.localeCompare(b);
  });
}

export function filterGroupMembers(all: string[] | undefined, groupNames: Set<string>): string[] {
  return (all ?? []).filter((name) => {
    if (name === "DIRECT") return true;
    if (groupNames.has(name)) return false;
    if (isBuiltinSpecialNode(name)) return false;
    return true;
  });
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

export function parseMemoryBytes(raw?: ClashMemoryResponse | ClashConnectionsResponse | null): number | undefined {
  if (!raw) return undefined;
  if ("inuse" in raw && typeof raw.inuse === "number") return raw.inuse;
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
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDurationSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function connectionStartedAt(start?: string): number {
  if (!start) return Date.now();
  const ts = Date.parse(start);
  return Number.isNaN(ts) ? Date.now() : ts;
}
