import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Select } from "../components/ui";
import { GroupEditModal, rulesToDraft, type GroupEditDraft } from "../components/GroupEditModal";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { useSession } from "../lib/session";
import { useApiError } from "../lib/errors";
import {
  applyMihomoConfigChanges,
  fetchMihomoConfig,
  saveMihomoConfig,
} from "../lib/config";
import {
  buildRuleLine,
  defaultNewGroup,
  deleteProxyGroup,
  ensurePolicyGroups,
  listUserProxyGroups,
  parseIpPolicies,
  replaceIpPolicies,
  rulesForGroup,
  setGroupRules,
  upsertProxyGroup,
  type ProxyGroupConfig,
} from "../lib/mihomoYaml";

type Tab = "groups" | "policies";

type PolicyDraft = { id: string; ip: string; target: "DIRECT" | "PROXY" };

function GroupIcon({ name, icon }: { name: string; icon?: string }) {
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        className="h-5 w-5 shrink-0 rounded object-contain"
        loading="lazy"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-zk-surface-hover text-[10px] font-bold text-zk-muted">
      {name[0]?.toUpperCase()}
    </span>
  );
}

export function GroupsPoliciesPage({
  embedded = false,
  forceTab,
}: {
  embedded?: boolean;
  forceTab?: Tab;
} = {}) {
  const t = useT();
  const apiErr = useApiError();
  const { mode } = useApp();
  const { clash, setClash } = useSession();
  const [tab, setTab] = useState<Tab>(forceTab || "groups");
  const [yaml, setYaml] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState<GroupEditDraft | null>(null);

  const [policyIp, setPolicyIp] = useState("");
  const [policyTarget, setPolicyTarget] = useState<"DIRECT" | "PROXY">("DIRECT");
  const [policyDrafts, setPolicyDrafts] = useState<PolicyDraft[]>([]);
  const [policiesDirty, setPoliciesDirty] = useState(false);

  useEffect(() => {
    if (forceTab) setTab(forceTab);
  }, [forceTab]);

  const activeTab = forceTab || tab;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchMihomoConfig();
      if (!data) throw new Error(t("config.notFound"));
      setYaml(data.content);
      setConfigPath(data.path);
      const loaded = parseIpPolicies(data.content)
        .filter((p) => p.target === "DIRECT" || p.target === "PROXY")
        .map((p) => ({
          id: p.id,
          ip: p.ip,
          target: p.target as "DIRECT" | "PROXY",
        }));
      setPolicyDrafts(loaded);
      setPoliciesDirty(false);
    } catch (err) {
      setError(apiErr(err, "groups.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t, apiErr]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => listUserProxyGroups(yaml), [yaml]);

  const persist = async (nextYaml: string) => {
    if (mode === "safe" && !window.confirm(t("groups.confirmApply"))) {
      throw new Error(t("groups.applyCancelled"));
    }
    setSaving(true);
    setError("");
    try {
      await saveMihomoConfig(configPath || "/opt/etc/mihomo/config.yaml", nextYaml, false);
      const conn = await applyMihomoConfigChanges(clash);
      setClash(conn);
      setYaml(nextYaml);
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (g: ProxyGroupConfig) => {
    setDraft({
      group: g,
      rules: rulesToDraft(rulesForGroup(yaml, g.name)),
      isNew: false,
    });
  };

  const openNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (groups.some((g) => g.name === trimmed)) {
      setError(t("groups.nameExists"));
      return;
    }
    setDraft({
      group: defaultNewGroup(trimmed),
      rules: [],
      isNew: true,
    });
    setNewName("");
  };

  const handleSaveDraft = async (d: GroupEditDraft) => {
    try {
      const oldName = draft?.group.name;
      let next = yaml;
      if (!d.isNew && oldName && oldName !== d.group.name) {
        next = deleteProxyGroup(next, oldName);
      }
      next = upsertProxyGroup(next, d.group);
      const payloads = d.rules.map((r) => buildRuleLine(r.type, r.value, d.group.name));
      next = setGroupRules(next, d.group.name, payloads);
      await persist(next);
      setDraft(null);
    } catch (err) {
      setError(apiErr(err, "groups.saveError"));
      throw err;
    }
  };

  const handleDeleteGroup = async (name: string) => {
    const next = deleteProxyGroup(yaml, name);
    await persist(next);
    setDraft(null);
  };

  const handleAddPolicyDraft = () => {
    const ip = policyIp.trim();
    if (!ip) return;
    setError("");
    setPolicyDrafts((prev) => {
      const without = prev.filter((p) => p.ip !== ip);
      return [...without, { id: `draft:${ip}:${policyTarget}`, ip, target: policyTarget }];
    });
    setPoliciesDirty(true);
    setPolicyIp("");
  };

  const handleRemovePolicyDraft = (id: string) => {
    setPolicyDrafts((prev) => prev.filter((p) => p.id !== id));
    setPoliciesDirty(true);
  };

  const handleApplyPolicies = async () => {
    setError("");
    try {
      let next = ensurePolicyGroups(yaml);
      next = replaceIpPolicies(
        next,
        policyDrafts.map((p) => ({ ip: p.ip, target: p.target })),
      );
      await persist(next);
      setPoliciesDirty(false);
    } catch (err) {
      setError(apiErr(err, "groups.saveError"));
    }
  };

  if (loading) {
    return (
      <div className="page-enter py-12 text-center text-sm text-zk-muted">{t("app.loading")}</div>
    );
  }

  return (
    <div className={embedded ? "space-y-4" : "page-enter space-y-4"}>
      {error && (
        <div className="rounded-xl border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
          {error}
        </div>
      )}

      {!embedded && (
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("groups.title")}</h1>
          <p className="mt-1 text-sm text-zk-muted">{t("groups.pageSub")}</p>
        </div>
      )}

      {!embedded && (
        <div className="flex rounded-xl border border-zk-border-soft bg-zk-bg-elevated p-1">
          <button
            type="button"
            onClick={() => setTab("groups")}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
              tab === "groups" ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-muted hover:text-zk-text"
            }`}
          >
            {t("groups.tabGroups")} ({groups.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("policies")}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
              tab === "policies" ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-muted hover:text-zk-text"
            }`}
          >
            {t("groups.tabPolicies")} ({policyDrafts.length})
          </button>
        </div>
      )}

      {activeTab === "groups" ? (
        <>
          <Card>
            <CardHeader title={t("groups.newGroup")} subtitle={t("groups.newGroupSub")} />
            <div className="flex items-end gap-3 p-4 sm:p-5">
              <div className="flex-1">
                <Input
                  label={t("groups.name")}
                  placeholder={t("groups.namePlaceholder")}
                  value={newName}
                  onChange={setNewName}
                  hint={t("groups.nameHint")}
                />
              </div>
              <Button
                size="md"
                variant="primary"
                onClick={openNew}
                disabled={!newName.trim() || groups.some((g) => g.name === newName.trim())}
              >
                {t("groups.add")}
              </Button>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title={t("groups.existingTitle")}
              subtitle={t("groups.existingCount", { count: groups.length })}
            />
            <div className="divide-y divide-zk-border-soft">
              {groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => openEdit(g)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-zk-bg-elevated/50 sm:px-5"
                >
                  <GroupIcon name={g.name} icon={g.icon} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{g.name}</p>
                    <p className="text-[11px] text-zk-muted">
                      {g.type}
                      {g.use?.length ? ` · use: ${g.use.join(",")}` : ""}
                    </p>
                  </div>
                  <Badge variant="muted">{t("groups.edit")}</Badge>
                </button>
              ))}
            </div>
          </Card>
        </>
      ) : (
        <>
          <Card>
            <CardHeader title={t("policies.newPolicy")} subtitle={t("policies.newPolicySub")} />
            <div className="space-y-3 p-4 sm:p-5">
              <Input
                label={t("policies.ip")}
                placeholder={t("policies.ipPlaceholder")}
                value={policyIp}
                onChange={setPolicyIp}
                mono
                hint={t("policies.ipHint")}
              />
              <Select
                label={t("policies.policyType")}
                value={policyTarget}
                onChange={(v) => setPolicyTarget(v as "DIRECT" | "PROXY")}
                options={[
                  { value: "DIRECT", label: "DIRECT" },
                  { value: "PROXY", label: "PROXY" },
                ]}
              />
              <Button
                size="md"
                variant="secondary"
                disabled={!policyIp.trim()}
                onClick={handleAddPolicyDraft}
              >
                {t("policies.add")}
              </Button>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title={t("policies.activeTitle")}
              subtitle={t("policies.rules", { count: policyDrafts.length })}
              action={
                <Button
                  size="sm"
                  variant="primary"
                  disabled={saving || !policiesDirty}
                  onClick={() => void handleApplyPolicies()}
                >
                  {saving ? t("app.loading") : t("policies.apply")}
                </Button>
              }
            />
            <div className="divide-y divide-zk-border-soft">
              {policyDrafts.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zk-dim sm:px-5">{t("policies.empty")}</p>
              ) : (
                policyDrafts.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm">{p.ip}</p>
                      <p className="text-[11px] text-zk-muted">
                        SRC-IP → <span className="text-zk-accent">{p.target}</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => handleRemovePolicyDraft(p.id)}
                    >
                      {t("groups.delete")}
                    </Button>
                  </div>
                ))
              )}
            </div>
            {policiesDirty && (
              <p className="border-t border-zk-border-soft px-4 py-2 text-[11px] text-zk-amber sm:px-5">
                {t("policies.dirtyHint")}
              </p>
            )}
          </Card>
        </>
      )}

      <GroupEditModal
        open={!!draft}
        draft={draft}
        saving={saving}
        onClose={() => setDraft(null)}
        onSave={handleSaveDraft}
        onDelete={handleDeleteGroup}
      />
    </div>
  );
}
