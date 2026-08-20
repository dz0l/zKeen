import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Select } from "../components/ui";
import { GroupEditModal, rulesToDraft, type GroupEditDraft } from "../components/GroupEditModal";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { useSession } from "../lib/session";
import { ApiError } from "../lib/api";
import {
  applyMihomoConfigChanges,
  fetchMihomoConfig,
  saveMihomoConfig,
} from "../lib/config";
import {
  addIpPolicy,
  buildRuleLine,
  defaultNewGroup,
  deleteProxyGroup,
  listUserProxyGroups,
  parseIpPolicies,
  removeIpPolicy,
  rulesForGroup,
  setGroupRules,
  upsertProxyGroup,
  type IpPolicy,
  type ProxyGroupConfig,
} from "../lib/mihomoYaml";

type Tab = "groups" | "policies";

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

export function GroupsPoliciesPage() {
  const t = useT();
  const { mode } = useApp();
  const { clash, setClash } = useSession();
  const [tab, setTab] = useState<Tab>("groups");
  const [yaml, setYaml] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState<GroupEditDraft | null>(null);

  const [policyIp, setPolicyIp] = useState("");
  const [policyTarget, setPolicyTarget] = useState("DIRECT");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchMihomoConfig();
      if (!data) throw new Error(t("config.notFound"));
      setYaml(data.content);
      setConfigPath(data.path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("groups.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => listUserProxyGroups(yaml), [yaml]);
  const policies = useMemo(() => parseIpPolicies(yaml), [yaml]);
  const targetOptions = useMemo(() => {
    const opts = [
      { value: "DIRECT", label: "DIRECT" },
      { value: "REJECT", label: "REJECT" },
      ...groups.map((g) => ({ value: g.name, label: g.name })),
    ];
    return opts;
  }, [groups]);

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
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : t("groups.saveError"));
      throw err;
    }
  };

  const handleDeleteGroup = async (name: string) => {
    const next = deleteProxyGroup(yaml, name);
    await persist(next);
    setDraft(null);
  };

  const handleAddPolicy = async () => {
    const ip = policyIp.trim();
    if (!ip) return;
    setError("");
    try {
      const next = addIpPolicy(yaml, ip, policyTarget);
      await persist(next);
      setPolicyIp("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const handleRemovePolicy = async (p: IpPolicy) => {
    try {
      const next = removeIpPolicy(yaml, p.raw);
      await persist(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (loading) {
    return (
      <div className="page-enter py-12 text-center text-sm text-zk-muted">{t("app.loading")}</div>
    );
  }

  return (
    <div className="page-enter space-y-4">
      {error && (
        <div className="rounded-xl border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
          {error}
        </div>
      )}

      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("groups.title")}</h1>
        <p className="mt-1 text-sm text-zk-muted">{t("groups.pageSub")}</p>
      </div>

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
          {t("groups.tabPolicies")} ({policies.length})
        </button>
      </div>

      {tab === "groups" ? (
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
                label={t("policies.proxyGroup")}
                value={policyTarget}
                onChange={setPolicyTarget}
                options={targetOptions}
              />
              <Button
                size="md"
                variant="primary"
                disabled={saving || !policyIp.trim()}
                onClick={() => void handleAddPolicy()}
              >
                {saving ? t("app.loading") : t("policies.add")}
              </Button>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title={t("policies.activeTitle")}
              subtitle={t("policies.rules", { count: policies.length })}
            />
            <div className="divide-y divide-zk-border-soft">
              {policies.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-zk-dim sm:px-5">{t("policies.empty")}</p>
              ) : (
                policies.map((p) => (
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
                      onClick={() => void handleRemovePolicy(p)}
                    >
                      {t("groups.delete")}
                    </Button>
                  </div>
                ))
              )}
            </div>
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
