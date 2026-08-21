import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardHeader, Select } from "../components/ui";
import { IconChevron } from "../components/icons";
import { useT, useI18n } from "../lib/i18n";
import { useSession } from "../lib/session";
import { ApiError, clashJson } from "../lib/api";
import { useApiError } from "../lib/errors";
import {
  DEFAULT_PROVIDER,
  ensureMihomoRunning,
  fetchMihomoConfig,
  getTopLevelScalar,
  healthCheckProxyProvider,
  isClashConnectionError,
  refreshProxyProvider,
  saveMihomoConfig,
  setTopLevelScalar,
  applyMihomoConfigChanges,
  updateGeoDatabases,
} from "../lib/config";
import {
  buildProxyNameSets,
  collectBulkServerOptions,
  collectProviderServers,
  delaysFromProvider,
  filterGroupMembers,
  isBuiltinSpecialNode,
  isBulkSkipGroup,
  isUserProxyGroup,
  parseGroupIcons,
  type ClashDelayResponse,
  type ClashProvidersResponse,
  type ClashProxiesResponse,
} from "../lib/clash";
import { proxyGroupNamesInOrder } from "../lib/mihomoYaml";

type PageTab = "groups" | "provider";

const GEO_LAST_KEY = "zkeen-geo-last-ok";

function formatGeoDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale === "en" ? "en-GB" : "ru-RU");
}

interface ProxyNode {
  name: string;
  delay?: number;
}

interface ProxyGroup {
  name: string;
  type: string;
  nodes: ProxyNode[];
  icon?: string;
}

function delayColor(ms: number) {
  if (ms <= 100) return "text-zk-accent";
  if (ms <= 200) return "text-zk-amber";
  return "text-zk-coral";
}

function mapGroups(
  data: ClashProxiesResponse,
  icons: Record<string, string>,
  yamlOrder: string[],
): ProxyGroup[] {
  const { groupNames } = buildProxyNameSets(data);
  const groups = Object.values(data.proxies)
    .filter(isUserProxyGroup)
    .map((g) => ({
      name: g.name,
      type: g.type,
      icon: icons[g.name],
      nodes: filterGroupMembers(g.all, groupNames).map((name) => ({ name })),
    }));

  if (yamlOrder.length) {
    const idx = new Map(yamlOrder.map((n, i) => [n, i]));
    return groups.sort((a, b) => (idx.get(a.name) ?? 9999) - (idx.get(b.name) ?? 9999));
  }
  return groups;
}

function selectedMap(data: ClashProxiesResponse): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of Object.values(data.proxies)) {
    if (isUserProxyGroup(item) && item.now) {
      map[item.name] = item.now;
    }
  }
  return map;
}

export function ProxiesPage() {
  const t = useT();
  const { locale } = useI18n();
  const apiErr = useApiError();
  const { clash, setClash, settings } = useSession();
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [bulkServers, setBulkServers] = useState<string[]>(["DIRECT"]);
  const [bulkServer, setBulkServer] = useState("DIRECT");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [delays, setDelays] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState("");
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [geoUpdating, setGeoUpdating] = useState(false);
  const [geoStatus, setGeoStatus] = useState<"idle" | "ok" | "err">("idle");
  const [geoLastOk, setGeoLastOk] = useState(() => {
    try {
      return localStorage.getItem(GEO_LAST_KEY) || "";
    } catch {
      return "";
    }
  });
  const [coreMode, setCoreMode] = useState("rule");
  const [modeSaving, setModeSaving] = useState(false);
  const [pageTab, setPageTab] = useState<PageTab>("groups");
  const [serverNames, setServerNames] = useState<string[]>([]);
  const [providerEmpty, setProviderEmpty] = useState(false);

  const clashKey = `${clash.port}|${clash.secret}|${clash.unix}`;
  const clashRef = useRef(clash);
  clashRef.current = clash;

  const loadProxies = useCallback(async () => {
    setLoading(true);
    setError("");
    setOffline(false);
    const conn = clashRef.current;
    try {
      const [data, providers, config] = await Promise.all([
        clashJson<ClashProxiesResponse>("proxies", conn, undefined, 20000),
        clashJson<ClashProvidersResponse>("providers/proxies", conn, undefined, 20000).catch(
          () => null,
        ),
        fetchMihomoConfig().catch(() => null),
      ]);
      const icons = config ? parseGroupIcons(config.content) : {};
      const yamlOrder = config ? proxyGroupNamesInOrder(config.content) : [];
      if (config) {
        setCoreMode(getTopLevelScalar(config.content, "mode") || "rule");
      }
      setBulkServers(collectBulkServerOptions(data));
      const fromProvider = collectProviderServers(providers ?? undefined, DEFAULT_PROVIDER);
      if (fromProvider.length > 0) {
        setServerNames(fromProvider);
        setProviderEmpty(false);
      } else {
        // Fallback: nodes referenced by groups via `use: [subscription]` (exclude builtins)
        const { leafNames } = buildProxyNameSets(data);
        const fallback = [...leafNames]
          .filter((n) => !isBuiltinSpecialNode(n) && n !== "DIRECT")
          .sort((a, b) => a.localeCompare(b));
        setServerNames(fallback);
        setProviderEmpty(true);
      }
      setGroups(mapGroups(data, icons, yamlOrder));
      setSelected(selectedMap(data));
    } catch (err) {
      if (isClashConnectionError(err)) {
        setOffline(true);
        setError(t("proxies.mihomoOffline"));
      } else {
        setError(apiErr(err, "proxies.loadError"));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  const startMihomo = useCallback(async () => {
    setStarting(true);
    setError("");
    try {
      const conn = await ensureMihomoRunning(clashRef.current);
      setClash(conn);
      await loadProxies();
    } catch (err) {
      setError(apiErr(err, "proxies.startError"));
    } finally {
      setStarting(false);
    }
  }, [setClash, loadProxies, t]);

  useEffect(() => {
    loadProxies();
  }, [loadProxies, clashKey]);

  const filtered = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, search]);

  const applyToAll = useCallback(
    async (server: string) => {
      setBulkServer(server);
      setBusy("__all__");
      setError("");
      const conn = clashRef.current;
      try {
        const targets = groups.filter(
          (g) => !isBulkSkipGroup(g.name) && g.nodes.some((n) => n.name === server),
        );
        if (!targets.length) {
          throw new ApiError(400, t("proxies.noGroupsForServer"));
        }

        const next: Record<string, string> = { ...selected };
        // Parallel batches to avoid very long waits with many groups
        const chunkSize = 8;
        for (let i = 0; i < targets.length; i += chunkSize) {
          const chunk = targets.slice(i, i + chunkSize);
          await Promise.all(
            chunk.map(async (g) => {
              await clashJson(
                `proxies/${encodeURIComponent(g.name)}`,
                conn,
                {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: server }),
                },
                10000,
              );
              next[g.name] = server;
            }),
          );
        }
        setSelected({ ...next });
      } catch (err) {
        setError(apiErr(err, "proxies.switchError"));
        await loadProxies();
      } finally {
        setBusy("");
      }
    },
    [groups, selected, t, loadProxies],
  );

  const selectProxy = useCallback(
    async (groupName: string, nodeName: string) => {
      setBusy(groupName);
      setError("");
      try {
        await clashJson(
          `proxies/${encodeURIComponent(groupName)}`,
          clashRef.current,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: nodeName }),
          },
          10000,
        );
        setSelected((s) => ({ ...s, [groupName]: nodeName }));
      } catch (err) {
        setError(apiErr(err, "proxies.switchError"));
      } finally {
        setBusy("");
      }
    },
    [t],
  );

  const testDelay = useCallback(
    async (name: string) => {
      if (isBuiltinSpecialNode(name) || name === "DIRECT") return;
      const url = encodeURIComponent(settings?.clash_api.ping_url || "http://www.gstatic.com/generate_204");
      const timeout = Math.max(settings?.clash_api.ping_timeout || 5000, 8000);
      try {
        // Prefer provider-scoped delay API (more reliable for subscription nodes).
        let res: ClashDelayResponse;
        try {
          res = await clashJson<ClashDelayResponse>(
            `providers/proxies/${encodeURIComponent(DEFAULT_PROVIDER)}/${encodeURIComponent(name)}/delay?url=${url}&timeout=${timeout}`,
            clashRef.current,
            undefined,
            timeout + 10000,
          );
        } catch {
          res = await clashJson<ClashDelayResponse>(
            `proxies/${encodeURIComponent(name)}/delay?url=${url}&timeout=${timeout}`,
            clashRef.current,
            undefined,
            timeout + 10000,
          );
        }
        setDelays((d) => ({ ...d, [name]: res.delay > 0 ? res.delay : -1 }));
      } catch {
        setDelays((d) => ({ ...d, [name]: -1 }));
      }
    },
    [settings],
  );

  const testAllServers = useCallback(async () => {
    setTesting(true);
    setError("");
    const names = serverNames.filter((n) => !isBuiltinSpecialNode(n) && n !== "DIRECT");
    // Mark pending
    setDelays((prev) => {
      const next = { ...prev };
      for (const n of names) next[n] = prev[n] ?? 0;
      return next;
    });
    try {
      // Bulk health-check updates provider history in one Mihomo call.
      try {
        await healthCheckProxyProvider(DEFAULT_PROVIDER, clashRef.current, 300000);
        const providers = await clashJson<ClashProvidersResponse>(
          "providers/proxies",
          clashRef.current,
          undefined,
          20000,
        );
        const fromHist = delaysFromProvider(providers, DEFAULT_PROVIDER);
        if (Object.keys(fromHist).length > 0) {
          setDelays((d) => ({ ...d, ...fromHist }));
          const anyOk = Object.values(fromHist).some((v) => v > 0);
          if (anyOk) return;
        }
      } catch {
        /* fall through to per-node delay */
      }

      // Sequential / small batches — routers choke on many parallel delay tests.
      const chunkSize = 2;
      for (let i = 0; i < names.length; i += chunkSize) {
        await Promise.all(names.slice(i, i + chunkSize).map((n) => testDelay(n)));
      }
    } catch (err) {
      setError(apiErr(err, "proxies.testError"));
    } finally {
      setTesting(false);
    }
  }, [serverNames, testDelay, t]);

  const refreshProvider = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      await refreshProxyProvider(DEFAULT_PROVIDER, clashRef.current);
      await loadProxies();
    } catch (err) {
      setError(apiErr(err, "proxies.refreshError"));
    } finally {
      setRefreshing(false);
    }
  }, [loadProxies, t]);

  const refreshGeo = useCallback(async () => {
    setGeoUpdating(true);
    setGeoStatus("idle");
    setError("");
    try {
      await updateGeoDatabases(clashRef.current);
      const iso = new Date().toISOString();
      try {
        localStorage.setItem(GEO_LAST_KEY, iso);
      } catch {
        /* ignore */
      }
      setGeoLastOk(iso);
      setGeoStatus("ok");
    } catch (err) {
      setGeoStatus("err");
      setError(apiErr(err, "proxies.geoError"));
    } finally {
      setGeoUpdating(false);
    }
  }, [t]);

  const applyCoreMode = useCallback(
    async (value: string) => {
      setModeSaving(true);
      setError("");
      try {
        const loaded = await fetchMihomoConfig();
        if (!loaded) throw new ApiError(404, t("config.notFound"));
        const updated = setTopLevelScalar(loaded.content, "mode", value);
        await saveMihomoConfig(loaded.path, updated, false);
        const conn = await applyMihomoConfigChanges(clashRef.current);
        setClash(conn);
        setCoreMode(value);
      } catch (err) {
        setError(apiErr(err, "proxies.modeError"));
      } finally {
        setModeSaving(false);
      }
    },
    [setClash, t],
  );

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
        <div className="rounded-xl border border-zk-coral/25 bg-zk-coral/10 px-3 py-3 text-center text-xs text-zk-coral space-y-2">
          <p>{error}</p>
          {offline && (
            <Button size="sm" variant="primary" disabled={starting} onClick={startMihomo}>
              {starting ? t("app.loading") : t("proxies.startMihomo")}
            </Button>
          )}
        </div>
      )}

      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("proxies.title")}</h1>
          <p className="mt-1 text-sm text-zk-muted">
            {t("proxies.subtitle", { count: groups.length })}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={loadProxies} disabled={!!busy || refreshing}>
          ⟳
        </Button>
      </div>

      <div className="flex rounded-xl border border-zk-border-soft bg-zk-bg-elevated p-1">
        <button
          type="button"
          onClick={() => setPageTab("groups")}
          className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
            pageTab === "groups" ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-muted hover:text-zk-text"
          }`}
        >
          {t("proxies.tabGroups")}
        </button>
        <button
          type="button"
          onClick={() => setPageTab("provider")}
          className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
            pageTab === "provider" ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-muted hover:text-zk-text"
          }`}
        >
          {t("proxies.tabProvider")}
        </button>
      </div>

      {pageTab === "provider" ? (
        <div className="space-y-4">
          <Card>
            <CardHeader title={t("proxies.providerTitle")} subtitle={t("proxies.providerSub")} />
            <div className="flex flex-wrap gap-2 p-4 sm:p-5">
              <Button
                size="md"
                variant="primary"
                disabled={refreshing || testing || !!busy}
                onClick={() => void refreshProvider()}
              >
                {refreshing ? t("app.loading") : t("proxies.refreshProvider")}
              </Button>
              <Button
                size="md"
                variant="secondary"
                disabled={testing || refreshing || !!busy || serverNames.length === 0}
                onClick={() => void testAllServers()}
              >
                {testing
                  ? t("app.loading")
                  : t("proxies.testAllServers", { count: serverNames.length })}
              </Button>
            </div>
            {providerEmpty && serverNames.length === 0 && (
              <p className="border-t border-zk-border-soft px-4 py-3 text-xs text-zk-muted sm:px-5">
                {t("proxies.providerEmpty")}
              </p>
            )}
            {serverNames.length > 0 && (
              <div className="max-h-64 overflow-y-auto border-t border-zk-border-soft px-4 py-3 sm:px-5">
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {serverNames.map((name) => {
                    const delay = delays[name];
                    return (
                      <div
                        key={name}
                        className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm"
                      >
                        <span className="truncate text-zk-text">{name}</span>
                        {delay !== undefined && (
                          <span
                            className={`ml-2 shrink-0 font-mono text-xs ${
                              delay < 0
                                ? "text-zk-coral"
                                : delay === 0
                                  ? "text-zk-dim"
                                  : delayColor(delay)
                            }`}
                          >
                            {delay < 0 ? "—" : delay === 0 ? "…" : `${delay}ms`}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title={t("proxies.geoTitle")} subtitle={t("proxies.geoSub")} />
            <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
              <Button
                size="md"
                variant="secondary"
                disabled={geoUpdating || !!busy}
                onClick={() => void refreshGeo()}
              >
                {geoUpdating ? t("app.loading") : t("proxies.updateGeo")}
              </Button>
              <span className="text-xs text-zk-muted">
                {geoUpdating
                  ? t("proxies.geoUpdating")
                  : geoStatus === "ok"
                    ? t("proxies.geoSuccess")
                    : geoStatus === "err"
                      ? t("proxies.geoFail")
                      : geoLastOk
                        ? t("proxies.geoLast", { date: formatGeoDate(geoLastOk, locale) })
                        : t("proxies.geoNever")}
              </span>
            </div>
          </Card>
        </div>
      ) : (
        <>
          <Card>
            <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-end sm:gap-4 sm:p-4">
              <Select
                inline
                className="min-w-0 flex-1"
                label={t("proxies.allTo")}
                options={bulkServers.map((n) => ({ value: n, label: n }))}
                value={bulkServer}
                onChange={applyToAll}
              />
              <div className="flex min-w-0 flex-1 items-end gap-2">
                <Select
                  inline
                  className="min-w-0 flex-1"
                  label={t("proxies.modeTitle")}
                  value={coreMode}
                  onChange={(v) => void applyCoreMode(v)}
                  options={[
                    { value: "rule", label: "rule" },
                    { value: "global", label: "global" },
                    { value: "direct", label: "direct" },
                  ]}
                />
                {modeSaving && <span className="shrink-0 pb-2 text-xs text-zk-muted">{t("app.loading")}</span>}
              </div>
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
                    {group.icon ? (
                      <img
                        src={group.icon}
                        alt=""
                        className="h-6 w-6 shrink-0 rounded-md bg-zk-surface-hover object-contain p-0.5"
                      />
                    ) : (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zk-surface-hover text-[11px] font-bold text-zk-muted">
                        {group.name[0]?.toUpperCase()}
                      </span>
                    )}
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
        </>
      )}
    </div>
  );
}
