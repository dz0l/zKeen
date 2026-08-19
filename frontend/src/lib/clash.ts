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
}

export interface ClashConnectionsResponse {
  connections?: unknown[];
  downloadTotal?: number;
  uploadTotal?: number;
}

const GROUP_TYPES = new Set([
  "selector",
  "urltest",
  "fallback",
  "loadbalance",
  "relay",
  "compatible",
]);

export function isProxyGroup(item: ClashProxyItem): boolean {
  return GROUP_TYPES.has(item.type.toLowerCase());
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
