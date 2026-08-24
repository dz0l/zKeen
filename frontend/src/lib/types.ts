export type AppMode = "safe" | "expert";

export type PageId = "status" | "connections" | "proxies" | "config";

export interface NavItem {
  id: PageId;
  labelKey: string;
  shortLabelKey: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "status", labelKey: "nav.status", shortLabelKey: "nav.status" },
  { id: "proxies", labelKey: "nav.proxies", shortLabelKey: "nav.proxies" },
  { id: "connections", labelKey: "nav.connections", shortLabelKey: "nav.connectionsShort" },
  { id: "config", labelKey: "nav.settings", shortLabelKey: "nav.settings" },
];

export const MOBILE_PRIMARY: PageId[] = ["status", "proxies", "connections", "config"];
