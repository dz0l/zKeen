export type AppMode = "safe" | "expert";

export type PageId =
  | "status"
  | "connections"
  | "proxies"
  | "config"
  | "groups"
  | "policies"
  | "settings";

export interface NavItem {
  id: PageId;
  labelKey: string;
  shortLabelKey: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "status", labelKey: "nav.status", shortLabelKey: "nav.status" },
  { id: "connections", labelKey: "nav.connections", shortLabelKey: "nav.connectionsShort" },
  { id: "proxies", labelKey: "nav.proxies", shortLabelKey: "nav.proxies" },
  { id: "config", labelKey: "nav.config", shortLabelKey: "nav.config" },
  { id: "groups", labelKey: "nav.groups", shortLabelKey: "nav.groups" },
  { id: "policies", labelKey: "nav.policies", shortLabelKey: "nav.policies" },
  { id: "settings", labelKey: "nav.settings", shortLabelKey: "nav.settings" },
];

export const MOBILE_PRIMARY: PageId[] = ["status", "connections", "proxies", "config"];
