import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { SettingsPage } from "./SettingsPage";
import { ConfigPage } from "./ConfigPage";
import { GroupsPoliciesPage } from "./GroupsPoliciesPage";

type HubTab = "main" | "quick" | "groups" | "policies" | "editor";

const TABS: { id: HubTab; labelKey: string; expertOnly?: boolean }[] = [
  { id: "main", labelKey: "hub.tabMain" },
  { id: "quick", labelKey: "hub.tabQuick" },
  { id: "groups", labelKey: "hub.tabGroups", expertOnly: true },
  { id: "policies", labelKey: "hub.tabPolicies", expertOnly: true },
  { id: "editor", labelKey: "hub.tabEditor", expertOnly: true },
];

export function ConfigHubPage() {
  const t = useT();
  const { mode } = useApp();
  const [tab, setTab] = useState<HubTab>(mode === "safe" ? "quick" : "main");

  useEffect(() => {
    if (mode === "safe" && (tab === "editor" || tab === "groups" || tab === "policies")) {
      setTab("quick");
    }
  }, [mode, tab]);

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("hub.title")}</h1>
        <p className="mt-1 text-sm text-zk-muted">{t("hub.subtitle")}</p>
      </div>

      <div className="flex flex-wrap gap-1 rounded-xl border border-zk-border-soft bg-zk-bg-elevated p-1">
        {TABS.map((item) => {
          if (mode === "safe" && item.expertOnly) return null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-lg px-2.5 py-2 text-[11px] font-semibold transition-all sm:px-3 sm:text-xs ${
                tab === item.id
                  ? "bg-zk-surface text-zk-text shadow-sm"
                  : "text-zk-muted hover:text-zk-text"
              }`}
            >
              {t(item.labelKey)}
            </button>
          );
        })}
      </div>

      {tab === "main" && <SettingsPage embedded />}
      {tab === "quick" && <ConfigPage embedded forceTab="quick" />}
      {tab === "editor" && <ConfigPage embedded forceTab="editor" />}
      {tab === "groups" && <GroupsPoliciesPage embedded forceTab="groups" />}
      {tab === "policies" && <GroupsPoliciesPage embedded forceTab="policies" />}
    </div>
  );
}
