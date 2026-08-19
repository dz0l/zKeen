import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Select } from "../components/ui";
import { IconChevron } from "../components/icons";
import { useT } from "../lib/i18n";
import { useSession } from "../lib/session";
import { ApiError, clashJson } from "../lib/api";
import {
  isProxyGroup,
  type ClashDelayResponse,
  type ClashProxiesResponse,
} from "../lib/clash";

interface ProxyNode {
  name: string;
  delay?: number;
}

interface ProxyGroup {
  name: string;
  type: string;
  nodes: ProxyNode[];
}

function delayColor(ms: number) {
  if (ms <= 100) return "text-zk-accent";
  if (ms <= 200) return "text-zk-amber";
  return "text-zk-coral";
}

function mapGroups(data: ClashProxiesResponse): ProxyGroup[] {
  return Object.values(data.proxies)
    .filter(isProxyGroup)
    .map((g) => ({
      name: g.name,
      type: g.type,
      nodes: (g.all ?? []).map((name) => ({ name })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function selectedMap(data: ClashProxiesResponse): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of Object.values(data.proxies)) {
    if (isProxyGroup(item) && item.now) {
      map[item.name] = item.now;
    }
  }
  return map;
}

export function ProxiesPage() {
  const t = useT();
  const { clash, settings } = useSession();
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [delays, setDelays] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [testing, setTesting] = useState(false);

  const loadProxies = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await clashJson<ClashProxiesResponse>("proxies", clash);
      setGroups(mapGroups(data));
      setSelected(selectedMap(data));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("proxies.loadError"));
    } finally {
      setLoading(false);
    }
  }, [clash, t]);

  useEffect(() => {
    loadProxies();
  }, [loadProxies]);

  const filtered = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, search]);

  const allNodeNames = useMemo(() => {
    const names = new Set<string>();
    for (const g of groups) {
      for (const n of g.nodes) names.add(n.name);
    }
    return Array.from(names).sort();
  }, [groups]);

  const selectProxy = useCallback(
    async (groupName: string, nodeName: string) => {
      setBusy(groupName);
      setError("");
      try {
        await clashJson(`proxies/${encodeURIComponent(groupName)}`, clash, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: nodeName }),
        });
        setSelected((s) => ({ ...s, [groupName]: nodeName }));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("proxies.switchError"));
      } finally {
        setBusy("");
      }
    },
    [clash, t],
  );

  const applyToAll = useCallback(
    async (server: string) => {
      setBusy("__all__");
      setError("");
      try {
        for (const g of groups) {
          await clashJson(`proxies/${encodeURIComponent(g.name)}`, clash, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: server }),
          });
        }
        setSelected(() => {
          const next: Record<string, string> = {};
          for (const g of groups) next[g.name] = server;
          return next;
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("proxies.switchError"));
      } finally {
        setBusy("");
      }
    },
    [groups, clash, t],
  );

  const testDelay = useCallback(
    async (name: string) => {
      const url = encodeURIComponent(settings?.clash_api.ping_url || "https://www.gstatic.com/generate_204");
      const timeout = settings?.clash_api.ping_timeout || 5000;
      try {
        const res = await clashJson<ClashDelayResponse>(
          `proxies/${encodeURIComponent(name)}/delay?url=${url}&timeout=${timeout}`,
          clash,
        );
        if (res.delay >= 0) {
          setDelays((d) => ({ ...d, [name]: res.delay }));
        }
      } catch {
        setDelays((d) => ({ ...d, [name]: -1 }));
      }
    },
    [clash, settings],
  );

  const testAllVisible = useCallback(async () => {
    setTesting(true);
    const names = new Set<string>();
    for (const g of filtered) {
      for (const n of g.nodes) names.add(n.name);
    }
    await Promise.all(Array.from(names).map((n) => testDelay(n)));
    setTesting(false);
  }, [filtered, testDelay]);

  if (loading) {
    return (
      <div className="page-enter py-12 text-center text-sm text-zk-muted">
        {t("app.loading")}
      </div>
    );
  }

  return (
    <div className="page-enter space-y-4">
      {error && (
        <div className="rounded-xl border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-center text-xs text-zk-coral">
          {error}
        </div>
      )}

      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("proxies.title")}</h1>
          <p className="mt-1 text-sm text-zk-muted">
            {t("proxies.subtitle", { count: groups.length })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={loadProxies} disabled={!!busy}>
            ⟳
          </Button>
          <Button size="sm" variant="secondary" onClick={testAllVisible} disabled={testing || !!busy}>
            {testing ? t("app.loading") : t("proxies.testAll")}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader title={t("proxies.quickSelect")} subtitle={t("proxies.quickSelectSub")} />
        <div className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
          <div className="min-w-[200px] flex-1">
            <Select
              label={t("proxies.serverForAll")}
              options={allNodeNames.map((n) => ({ value: n, label: n }))}
              value="DIRECT"
              onChange={applyToAll}
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => applyToAll("DIRECT")} disabled={!!busy}>
            {t("proxies.resetAll")}
          </Button>
        </div>
      </Card>

      <input
        type="text"
        placeholder={t("proxies.search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-xl border border-zk-border-soft bg-zk-bg-elevated px-3.5 py-2.5 text-sm text-zk-text outline-none transition-colors placeholder:text-zk-dim focus:border-zk-accent/50 focus:ring-2 focus:ring-zk-accent/10"
      />

      <div className="space-y-1.5">
        {filtered.map((group) => {
          const open = expanded === group.name;
          const current = selected[group.name];
          const currentDelay = current ? delays[current] : undefined;
          const isGroupBusy = busy === group.name || busy === "__all__";
          return (
            <Card key={group.name} className="overflow-hidden">
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3.5 py-3 text-left sm:px-4"
                onClick={() => setExpanded(open ? "" : group.name)}
              >
                <IconChevron
                  className={`h-3.5 w-3.5 shrink-0 text-zk-dim transition-transform ${open ? "rotate-90" : ""}`}
                />
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zk-surface-hover text-[11px] font-bold text-zk-muted">
                  {group.name[0]?.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold">{group.name}</span>
                  <p className="truncate text-[11px] text-zk-muted">
                    <span className={current === "DIRECT" ? "text-zk-dim" : "text-zk-accent"}>
                      {current || "—"}
                    </span>
                    {currentDelay !== undefined && currentDelay >= 0 && (
                      <span className={`ml-2 font-mono ${delayColor(currentDelay)}`}>
                        {currentDelay}ms
                      </span>
                    )}
                    {isGroupBusy && (
                      <span className="ml-2 text-zk-dim">{t("app.loading")}</span>
                    )}
                  </p>
                </div>
                <Badge variant={current === "DIRECT" ? "muted" : "default"}>
                  {current === "DIRECT" ? "DIRECT" : group.type}
                </Badge>
              </button>

              {open && (
                <div className="border-t border-zk-border-soft px-2 pb-2 sm:px-3">
                  <div className="mt-1 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {group.nodes.map((node) => {
                      const isActive = current === node.name;
                      const isDirect = node.name === "DIRECT";
                      const isReject = node.name === "REJECT";
                      const delay = delays[node.name];
                      return (
                        <button
                          key={node.name}
                          type="button"
                          disabled={isGroupBusy}
                          onClick={() => selectProxy(group.name, node.name)}
                          className={`flex items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors ${
                            isActive
                              ? "bg-zk-accent/10 border border-zk-accent/25 text-zk-accent"
                              : isDirect
                                ? "hover:bg-zk-surface-hover border border-transparent text-zk-dim"
                                : isReject
                                  ? "hover:bg-zk-coral/10 border border-transparent text-zk-coral/70"
                                  : "hover:bg-zk-surface-hover border border-transparent text-zk-text"
                          }`}
                        >
                          <span className="truncate font-medium">{node.name}</span>
                          {delay !== undefined && delay >= 0 && (
                            <span className={`ml-2 shrink-0 font-mono text-xs ${delayColor(delay)}`}>
                              {delay}ms
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>
          );
        })}

        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-zk-dim">{t("proxies.noResults")}</p>
        )}
      </div>
    </div>
  );
}
