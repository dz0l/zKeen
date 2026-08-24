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
  normalizePolicyDomain,
  normalizePolicyIp,
  parseUserPolicies,
  replaceUserPolicies,
  rulesForGroup,
  setGroupRules,
  upsertProxyGroup,
  userPolicyId,
  type ProxyGroupConfig,
  type UserPolicy,
  type UserPolicyDraft,
  type UserPolicyKind,
} from "../lib/mihomoYaml";

type Tab = "groups" | "policies";

const DEFAULT_PROXY_GROUP = "PROXY";
const DEFAULT_DIRECT_GROUP = "STRAIGHT";

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

function PolicyAddBlock({
  title,
  groupLabel,
  group,
  groupOptions,
  onGroupChange,
  ip,
  onIpChange,
  domain,
  onDomainChange,
  onAddIp,
  onAddDomain,
  ipLabel,
  domainLabel,
  addLabel,
  ipPlaceholder,
}: {
  title: string;
  groupLabel: string;
  group: string;
  groupOptions: { value: string; label: string }[];
  onGroupChange: (v: string) => void;
  ip: string;
  onIpChange: (v: string) => void;
  domain: string;
  onDomainChange: (v: string) => void;
  onAddIp: () => void;
  onAddDomain: () => void;
  ipLabel: string;
  domainLabel: string;
  addLabel: string;
  ipPlaceholder: string;
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="space-y-3 p-4 sm:p-5">
        <Select label={groupLabel} value={group} onChange={onGroupChange} options={groupOptions} />
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Input
              label={ipLabel}
              placeholder={ipPlaceholder}
              mono
              value={ip}
              onChange={onIpChange}
            />
          </div>
          <Button size="md" variant="secondary" disabled={!ip.trim()} onClick={onAddIp}>
            {addLabel}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Input
              label={domainLabel}
              placeholder="example.com"
              mono
              value={domain}
              onChange={onDomainChange}
            />
          </div>
          <Button size="md" variant="secondary" disabled={!domain.trim()} onClick={onAddDomain}>
            {addLabel}
          </Button>
        </div>
      </div>
    </Card>
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

  const [proxyGroup, setProxyGroup] = useState(DEFAULT_PROXY_GROUP);
  const [directGroup, setDirectGroup] = useState(DEFAULT_DIRECT_GROUP);
  const [proxyIp, setProxyIp] = useState("");
  const [proxyDomain, setProxyDomain] = useState("");
  const [directIp, setDirectIp] = useState("");
  const [directDomain, setDirectDomain] = useState("");
  const [policyDrafts, setPolicyDrafts] = useState<UserPolicyDraft[]>([]);
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
      let content = data.content;
      const needsHeal =
        /(?:^|\n)\s*-\s*SRC-IP,/.test(content) ||
        (parseUserPolicies(content).some((p) => p.kind === "ip") &&
          !content.includes("# zkeen:policies"));
      if (needsHeal) {
        const all = parseUserPolicies(content);
        content = replaceUserPolicies(ensurePolicyGroups(content), all);
        try {
          await saveMihomoConfig(data.path, content, true);
          const conn = await applyMihomoConfigChanges(clash);
          setClash(conn);
        } catch {
          /* rewritten yaml still shown */
        }
      }
      setYaml(content);
      setConfigPath(data.path);
      setPolicyDrafts(parseUserPolicies(content));
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

  const groupOptions = useMemo(
    () => groups.map((g) => ({ value: g.name, label: g.name })),
    [groups],
  );

  useEffect(() => {
    if (groups.some((g) => g.name === DEFAULT_PROXY_GROUP)) {
      setProxyGroup(DEFAULT_PROXY_GROUP);
    } else if (groups[0]) {
      setProxyGroup(groups[0].name);
    }
    if (groups.some((g) => g.name === DEFAULT_DIRECT_GROUP)) {
      setDirectGroup(DEFAULT_DIRECT_GROUP);
    } else if (groups.find((g) => g.name !== DEFAULT_PROXY_GROUP)) {
      setDirectGroup(groups.find((g) => g.name !== DEFAULT_PROXY_GROUP)!.name);
    }
  }, [groups]);

  const persist = async (nextYaml: string) => {
    if (mode === "safe" && !window.confirm(t("groups.confirmApply"))) {
      throw new Error(t("groups.applyCancelled"));
    }
    setSaving(true);
    setError("");
    try {
      await saveMihomoConfig(configPath || "/opt/etc/mihomo/config.yaml", nextYaml, true);
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

  const addPolicyDraft = (kind: UserPolicyKind, rawValue: string, target: string) => {
    const value = kind === "ip" ? normalizePolicyIp(rawValue) : normalizePolicyDomain(rawValue);
    if (!value || !target.trim()) return;
    const policy: UserPolicy = { kind, value, target: target.trim() };
    const id = userPolicyId(policy);
    setError("");
    setPolicyDrafts((prev) => [...prev.filter((p) => p.id !== id), { ...policy, id }]);
    setPoliciesDirty(true);
  };

  const persistPolicies = async (drafts: UserPolicyDraft[]) => {
    const policies: UserPolicy[] = drafts.map(({ kind, value, target }) => ({
      kind,
      value,
      target,
    }));
    const next = replaceUserPolicies(ensurePolicyGroups(yaml), policies);
    await persist(next);
    setPoliciesDirty(false);
  };

  const handleApplyPolicies = async () => {
    setError("");
    try {
      await persistPolicies(policyDrafts);
    } catch (err) {
      setError(apiErr(err, "groups.saveError"));
    }
  };

  const handleRemovePolicyDraft = async (id: string) => {
    const nextDrafts = policyDrafts.filter((p) => p.id !== id);
    setPolicyDrafts(nextDrafts);
    setError("");
    try {
      await persistPolicies(nextDrafts);
    } catch (err) {
      setError(apiErr(err, "groups.saveError"));
      await load();
    }
  };

  const policyGroupSelectOptions = useMemo(() => {
    if (groupOptions.length > 0) return groupOptions;
    return [
      { value: DEFAULT_PROXY_GROUP, label: DEFAULT_PROXY_GROUP },
      { value: DEFAULT_DIRECT_GROUP, label: DEFAULT_DIRECT_GROUP },
    ];
  }, [groupOptions]);

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
            <CardHeader title={t("groups.newGroup")} />
            <div className="flex items-end gap-3 p-4 sm:p-5">
              <div className="flex-1">
                <Input
                  label={t("groups.name")}
                  placeholder={t("groups.namePlaceholder")}
                  value={newName}
                  onChange={setNewName}
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
            <CardHeader title={t("groups.existingTitle")} />
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
          <PolicyAddBlock
            title={t("policies.proxyBlock")}
            groupLabel={t("policies.group")}
            group={proxyGroup}
            groupOptions={policyGroupSelectOptions}
            onGroupChange={setProxyGroup}
            ip={proxyIp}
            onIpChange={setProxyIp}
            domain={proxyDomain}
            onDomainChange={setProxyDomain}
            ipLabel={t("policies.proxyIp")}
            domainLabel={t("policies.proxyDomain")}
            ipPlaceholder={t("policies.ipPlaceholder")}
            addLabel={t("policies.add")}
            onAddIp={() => {
              addPolicyDraft("ip", proxyIp, proxyGroup);
              setProxyIp("");
            }}
            onAddDomain={() => {
              addPolicyDraft("domain", proxyDomain, proxyGroup);
              setProxyDomain("");
            }}
          />

          <PolicyAddBlock
            title={t("policies.directBlock")}
            groupLabel={t("policies.group")}
            group={directGroup}
            groupOptions={policyGroupSelectOptions}
            onGroupChange={setDirectGroup}
            ip={directIp}
            onIpChange={setDirectIp}
            domain={directDomain}
            onDomainChange={setDirectDomain}
            ipLabel={t("policies.directIp")}
            domainLabel={t("policies.directDomain")}
            ipPlaceholder={t("policies.ipPlaceholder")}
            addLabel={t("policies.add")}
            onAddIp={() => {
              addPolicyDraft("ip", directIp, directGroup);
              setDirectIp("");
            }}
            onAddDomain={() => {
              addPolicyDraft("domain", directDomain, directGroup);
              setDirectDomain("");
            }}
          />

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
                      <p className="font-mono text-sm">{p.value}</p>
                      <p className="text-[11px] text-zk-muted">
                        {p.kind === "ip" ? "SRC-IP-CIDR" : "DOMAIN-SUFFIX"} →{" "}
                        <span className="text-zk-accent">{p.target}</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => void handleRemovePolicyDraft(p.id)}
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
