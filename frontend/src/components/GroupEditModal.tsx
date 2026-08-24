import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button, CardHeader, Input, Select } from "./ui";
import { useT } from "../lib/i18n";
import {
  RULE_TYPES,
  buildRuleLine,
  type ProxyGroupConfig,
  type ParsedRule,
} from "../lib/mihomoYaml";

const GROUP_TYPES = [
  { value: "select", label: "select" },
  { value: "url-test", label: "url-test" },
  { value: "fallback", label: "fallback" },
  { value: "load-balance", label: "load-balance" },
  { value: "relay", label: "relay" },
];

export interface GroupEditDraft {
  group: ProxyGroupConfig;
  rules: { type: string; value: string }[];
  isNew: boolean;
}

export function GroupEditModal({
  open,
  draft,
  onClose,
  onSave,
  onDelete,
  saving,
}: {
  open: boolean;
  draft: GroupEditDraft | null;
  onClose: () => void;
  onSave: (draft: GroupEditDraft) => Promise<void>;
  onDelete?: (name: string) => Promise<void>;
  saving: boolean;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [type, setType] = useState("select");
  const [icon, setIcon] = useState("");
  const [useCsv, setUseCsv] = useState("subscription");
  const [proxiesCsv, setProxiesCsv] = useState("DIRECT");
  const [url, setUrl] = useState("");
  const [interval, setInterval] = useState("");
  const [rules, setRules] = useState<{ type: string; value: string }[]>([]);
  const [ruleType, setRuleType] = useState("DOMAIN-SUFFIX");
  const [ruleValue, setRuleValue] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (!draft) return;
    setName(draft.group.name);
    setType(draft.group.type || "select");
    setIcon(draft.group.icon || "");
    setUseCsv((draft.group.use ?? ["subscription"]).join(", "));
    setProxiesCsv((draft.group.proxies ?? ["DIRECT"]).join(", "));
    setUrl(draft.group.url || "");
    setInterval(draft.group.interval != null ? String(draft.group.interval) : "");
    setRules(draft.rules);
    setConfirmDel(false);
    setLocalError("");
  }, [draft]);

  const rulePreview = useMemo(() => {
    if (!ruleValue.trim() || !name.trim()) return "";
    return buildRuleLine(ruleType, ruleValue.trim(), name.trim());
  }, [ruleType, ruleValue, name]);

  if (!open || !draft) return null;

  const addRule = () => {
    const v = ruleValue.trim();
    if (!v) return;
    setRules((prev) => [...prev, { type: ruleType, value: v }]);
    setRuleValue("");
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setLocalError(t("groups.nameRequired"));
      return;
    }
    const group: ProxyGroupConfig = {
      name: trimmed,
      type,
      icon: icon.trim() || undefined,
      use: useCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      proxies: proxiesCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      url: type === "url-test" ? url.trim() || undefined : undefined,
      interval: type === "url-test" && interval ? Number(interval) : undefined,
    };
    try {
      await onSave({ group, rules, isNew: draft.isNew });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : t("groups.saveError"));
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-zk-border-soft bg-zk-surface shadow-2xl sm:rounded-2xl">
        <CardHeader
          title={draft.isNew ? t("groups.newGroup") : t("groups.editGroup")}
          subtitle={trimmedSubtitle(draft)}
          action={
            <button type="button" onClick={onClose} className="text-zk-muted hover:text-zk-text">
              ✕
            </button>
          }
        />
        <div className="scrollbar-thin space-y-4 overflow-y-auto p-4 sm:p-5">
          {localError && (
            <p className="rounded-lg border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
              {localError}
            </p>
          )}

          <Input
            label={t("groups.name")}
            value={name}
            onChange={setName}
            placeholder="football"
          />
          <Select label={t("groups.type")} value={type} onChange={setType} options={GROUP_TYPES} />
          <Input
            label={t("groups.icon")}
            value={icon}
            onChange={setIcon}
            placeholder="https://..."
            mono
            hint={t("groups.iconHint")}
          />
          <Input
            label={t("groups.use")}
            value={useCsv}
            onChange={setUseCsv}
            placeholder="subscription"
            hint={t("groups.useHint")}
          />
          <Input
            label={t("groups.proxies")}
            value={proxiesCsv}
            onChange={setProxiesCsv}
            placeholder="DIRECT"
            hint={t("groups.proxiesHint")}
          />
          {type === "url-test" && (
            <>
              <Input label="url" value={url} onChange={setUrl} mono />
              <Input label="interval" value={interval} onChange={setInterval} placeholder="300" />
            </>
          )}

          <div className="space-y-2 rounded-xl border border-zk-border-soft p-3">
            <p className="text-sm font-semibold">{t("groups.rulesTitle")}</p>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
              <Select
                compact
                label={t("groups.ruleType")}
                value={ruleType}
                onChange={setRuleType}
                options={RULE_TYPES.filter((r) => r !== "MATCH").map((r) => ({ value: r, label: r }))}
              />
              <Input
                label={t("groups.ruleValue")}
                value={ruleValue}
                onChange={setRuleValue}
                placeholder="api.sportdb.dev"
                mono
              />
              <div className="flex items-end">
                <Button size="sm" variant="secondary" onClick={addRule} disabled={!ruleValue.trim()}>
                  {t("groups.addRule")}
                </Button>
              </div>
            </div>
            {rulePreview && (
              <p className="font-mono text-[10px] text-zk-dim">→ {rulePreview}</p>
            )}
            <ul className="divide-y divide-zk-border-soft">
              {rules.length === 0 ? (
                <li className="py-3 text-center text-xs text-zk-dim">{t("groups.noRules")}</li>
              ) : (
                rules.map((r, i) => (
                  <li key={`${r.type}-${r.value}-${i}`} className="flex items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {buildRuleLine(r.type, r.value, name.trim() || draft.group.name)}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-zk-coral"
                      onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
                    >
                      {t("groups.delete")}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-zk-border-soft px-4 py-3 sm:px-5">
          {!draft.isNew && onDelete && (
            confirmDel ? (
              <Button
                size="sm"
                variant="danger"
                disabled={saving}
                onClick={() => void onDelete(draft.group.name)}
              >
                {t("groups.confirmDelete")}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDel(true)}>
                {t("groups.delete")}
              </Button>
            )
          )}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>
              {t("groups.cancel")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? t("app.loading") : t("groups.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function trimmedSubtitle(draft: GroupEditDraft): string {
  return draft.isNew ? draft.group.name || "…" : draft.group.name;
}

export function rulesToDraft(rules: ParsedRule[]): { type: string; value: string }[] {
  return rules
    .filter((r) => r.type && r.type !== "COMPLEX" && r.type !== "MATCH")
    .map((r) => ({ type: r.type, value: r.payload }));
}
