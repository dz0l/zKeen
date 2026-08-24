import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Card, CardHeader, Select, StatTile } from "../components/ui";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { useSession } from "../lib/session";
import { clashJson, clashWsUrl } from "../lib/api";
import { useApiError } from "../lib/errors";
import {
  applyMihomoConfigChanges,
  fetchMihomoConfig,
  getTopLevelScalar,
  saveMihomoConfig,
  setTopLevelScalar,
} from "../lib/config";
import {
  connectionStartedAt,
  formatBytes,
  formatDurationSec,
  type ClashConnectionItem,
  type ClashConnectionsResponse,
} from "../lib/clash";

type PageTab = "connections" | "logs";
type ConnTab = "active" | "closed";

interface Connection {
  id: string;
  sourceIp: string;
  host: string;
  network: string;
  rule: string;
  chain: string;
  upload: number;
  download: number;
  durationSec: number;
  closedAt?: number;
}

interface LogLine {
  id: number;
  type: string;
  payload: string;
  time: number;
}

const LOG_LIMIT = 300;
const CLOSED_LIMIT = 100;

const LOG_LEVEL_RANK: Record<string, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  silent: 4,
};

function normalizeLogType(type: string): string {
  const t = type.toLowerCase();
  if (t === "warn") return "warning";
  return t;
}

function logPassesFilter(type: string, selectedLevel: string): boolean {
  if (selectedLevel === "silent") return false;
  const msgRank = LOG_LEVEL_RANK[normalizeLogType(type)] ?? 1;
  const minRank = LOG_LEVEL_RANK[selectedLevel] ?? 1;
  return msgRank >= minRank;
}

function mapClashConnection(item: ClashConnectionItem): Connection {
  const meta = item.metadata ?? {};
  const host = meta.host || meta.destinationIP || "—";
  const start = connectionStartedAt(item.start);
  return {
    id: item.id,
    sourceIp: meta.sourceIP || "—",
    host,
    network: (meta.network || "tcp").toUpperCase(),
    rule: item.rule || "—",
    chain: (item.chains ?? []).slice().reverse().join(" → ") || "—",
    upload: item.upload ?? 0,
    download: item.download ?? 0,
    durationSec: Math.max(0, Math.floor((Date.now() - start) / 1000)),
  };
}

function formatClosedAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

function IpDropdown({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  allLabel,
}: {
  value: string;
  onChange: (ip: string) => void;
  options: { ip: string; count: number }[];
  placeholder: string;
  searchPlaceholder: string;
  allLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPos = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  };

  useEffect(() => {
    if (!open) return;
    updateMenuPos();
    window.addEventListener("resize", updateMenuPos);
    window.addEventListener("scroll", updateMenuPos, true);
    return () => {
      window.removeEventListener("resize", updateMenuPos);
      window.removeEventListener("scroll", updateMenuPos, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.ip.toLowerCase().includes(q));
  }, [options, search]);

  const menu = open ? (
    <div
      ref={menuRef}
      style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
      className="fixed z-[200] rounded-xl border border-zk-border-soft bg-zk-surface shadow-2xl shadow-black/40"
    >
      <div className="border-b border-zk-border-soft p-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={searchPlaceholder}
          autoFocus
          className="w-full rounded-lg border border-zk-border-soft bg-zk-bg/50 px-2.5 py-1.5 font-mono text-xs text-zk-text outline-none placeholder:text-zk-dim focus:border-zk-accent/40"
        />
      </div>
      <ul className="scrollbar-thin max-h-56 overflow-y-auto py-1">
        <li>
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
              setSearch("");
            }}
            className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zk-bg-elevated ${!value ? "text-zk-accent" : "text-zk-muted"}`}
          >
            {allLabel}
          </button>
        </li>
        {filtered.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-zk-muted">{placeholder}</li>
        ) : (
          filtered.map(({ ip, count }) => (
            <li key={ip}>
              <button
                type="button"
                onClick={() => {
                  onChange(ip);
                  setOpen(false);
                  setSearch("");
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-zk-bg-elevated ${
                  value === ip ? "bg-zk-accent/10 text-zk-accent" : "text-zk-text"
                }`}
              >
                <span className="font-mono text-xs">{ip}</span>
                <span className="text-[10px] tabular-nums text-zk-dim">{count}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-zk-border-soft bg-zk-bg/50 px-3 py-2 text-left text-sm transition-colors hover:border-zk-accent/30 focus:border-zk-accent/40 focus:outline-none"
      >
        <span className={`truncate font-mono ${value ? "text-zk-text" : "text-zk-muted"}`}>
          {value || allLabel}
        </span>
        <span className="shrink-0 text-zk-dim">{open ? "▴" : "▾"}</span>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

export function ConnectionsPage() {
  const t = useT();
  const apiErr = useApiError();
  const { mode } = useApp();
  const { clash, setClash } = useSession();
  const clashRef = useRef(clash);
  clashRef.current = clash;

  const [pageTab, setPageTab] = useState<PageTab>("connections");
  const [tab, setTab] = useState<ConnTab>("active");
  const [activeList, setActiveList] = useState<Connection[]>([]);
  const [closedList, setClosedList] = useState<Connection[]>([]);
  const prevMapRef = useRef<Map<string, Connection>>(new Map());
  const [uploadTotal, setUploadTotal] = useState(0);
  const [downloadTotal, setDownloadTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ipFilter, setIpFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");

  const [logLevel, setLogLevel] = useState("silent");
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [logsPaused, setLogsPaused] = useState(false);
  const [logsSaving, setLogsSaving] = useState(false);
  const [logsError, setLogsError] = useState("");
  const logsPausedRef = useRef(false);
  logsPausedRef.current = logsPaused;
  const logIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  const pushClosed = useCallback((items: Connection[]) => {
    if (!items.length) return;
    const now = Date.now();
    setClosedList((prev) => {
      const seen = new Set(prev.map((c) => c.id));
      const added = items
        .filter((c) => !seen.has(c.id))
        .map((c) => ({ ...c, closedAt: c.closedAt ?? now }));
      return [...added, ...prev].slice(0, CLOSED_LIMIT);
    });
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const data = await clashJson<ClashConnectionsResponse>(
        "connections",
        clashRef.current,
        undefined,
        8000,
      );
      const next = (data.connections ?? []).map(mapClashConnection);
      const nextMap = new Map(next.map((c) => [c.id, c]));
      const prev = prevMapRef.current;
      if (prev.size > 0) {
        const disappeared: Connection[] = [];
        for (const [id, conn] of prev) {
          if (!nextMap.has(id)) disappeared.push(conn);
        }
        pushClosed(disappeared);
      }
      prevMapRef.current = nextMap;
      setActiveList(next);
      setUploadTotal(data.uploadTotal ?? 0);
      setDownloadTotal(data.downloadTotal ?? 0);
      setError("");
    } catch (err) {
      setError(apiErr(err, "conn.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t, pushClosed]);

  useEffect(() => {
    setLoading(true);
    loadConnections();
    const id = setInterval(loadConnections, 3000);
    return () => clearInterval(id);
  }, [loadConnections, clash.port, clash.secret, clash.unix]);

  useEffect(() => {
    fetchMihomoConfig()
      .then((cfg) => {
        if (cfg) setLogLevel(getTopLevelScalar(cfg.content, "log-level") || "silent");
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (pageTab !== "logs") return;
    const level = logLevel || "info";
    const url = clashWsUrl("logs", clashRef.current, level === "silent" ? undefined : { level });
    let ws: WebSocket | null = null;
    let closed = false;
    try {
      ws = new WebSocket(url);
      ws.onmessage = (ev) => {
        if (logsPausedRef.current) return;
        try {
          const data = JSON.parse(String(ev.data)) as { type?: string; payload?: string };
          const type = data.type || "info";
          if (!logPassesFilter(type, level)) return;
          const line: LogLine = {
            id: ++logIdRef.current,
            type,
            payload: data.payload || String(ev.data),
            time: Date.now(),
          };
          setLogLines((prev) => [...prev, line].slice(-LOG_LIMIT));
        } catch {
          if (!logPassesFilter("info", level)) return;
          setLogLines((prev) =>
            [
              ...prev,
              { id: ++logIdRef.current, type: "info", payload: String(ev.data), time: Date.now() },
            ].slice(-LOG_LIMIT),
          );
        }
      };
      ws.onerror = () => setLogsError(t("conn.logsError"));
    } catch {
      setLogsError(t("conn.logsError"));
    }
    return () => {
      closed = true;
      ws?.close();
      void closed;
    };
  }, [pageTab, clash.port, clash.secret, clash.unix, logLevel, t]);

  useEffect(() => {
    if (pageTab === "logs" && !logsPaused) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logLines, pageTab, logsPaused]);

  const sourceList = tab === "active" ? activeList : closedList;

  const ipOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of activeList) {
      counts.set(c.sourceIp, (counts.get(c.sourceIp) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  }, [activeList]);

  const filtered = useMemo(() => {
    const host = hostFilter.trim().toLowerCase();
    return sourceList.filter((c) => {
      if (ipFilter && c.sourceIp !== ipFilter) return false;
      if (host && !c.host.toLowerCase().includes(host)) return false;
      return true;
    });
  }, [sourceList, ipFilter, hostFilter]);

  const stats = useMemo(() => {
    let up = 0;
    let down = 0;
    const ips = new Set<string>();
    for (const c of filtered) {
      up += c.upload;
      down += c.download;
      ips.add(c.sourceIp);
    }
    return {
      count: filtered.length,
      upload: tab === "active" && !ipFilter && !hostFilter ? uploadTotal : up,
      download: tab === "active" && !ipFilter && !hostFilter ? downloadTotal : down,
      uniqueIps: ips.size,
    };
  }, [filtered, tab, ipFilter, hostFilter, uploadTotal, downloadTotal]);

  const handleCloseAll = () => {
    const target = ipFilter
      ? activeList.filter((c) => c.sourceIp === ipFilter)
      : activeList;
    if (target.length === 0) return;
    const msg = ipFilter
      ? t("conn.confirmCloseIp", { ip: ipFilter, count: target.length })
      : t("conn.confirmCloseAll", { count: target.length });
    if (mode === "safe" && !window.confirm(msg)) return;

    void (async () => {
      setBusy(true);
      setError("");
      try {
        if (!ipFilter) {
          await clashJson("connections", clashRef.current, { method: "DELETE" }, 10000);
        } else {
          await Promise.all(
            target.map((c) =>
              clashJson(`connections/${encodeURIComponent(c.id)}`, clashRef.current, {
                method: "DELETE",
              }, 10000),
            ),
          );
        }
        pushClosed(target);
        for (const c of target) prevMapRef.current.delete(c.id);
        await loadConnections();
      } catch (err) {
        setError(apiErr(err, "conn.closeError"));
      } finally {
        setBusy(false);
      }
    })();
  };

  const applyLogLevel = async (value: string) => {
    setLogsSaving(true);
    setLogsError("");
    try {
      const loaded = await fetchMihomoConfig();
      if (!loaded) throw new Error(t("config.notFound"));
      const updated = setTopLevelScalar(loaded.content, "log-level", value);
      await saveMihomoConfig(loaded.path, updated, false);
      const conn = await applyMihomoConfigChanges(clash);
      setClash(conn);
      setLogLevel(value);
      setLogLines([]);
    } catch (err) {
      setLogsError(apiErr(err, "conn.logsSaveError"));
    } finally {
      setLogsSaving(false);
    }
  };

  const activeFilteredCount = ipFilter
    ? activeList.filter((c) => c.sourceIp === ipFilter).length
    : activeList.length;

  return (
    <div className="page-enter space-y-4">
      {(error || logsError) && (
        <div className="rounded-xl border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
          {error || logsError}
        </div>
      )}

      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("conn.title")}</h1>
      </div>

      <div className="flex rounded-xl border border-zk-border-soft bg-zk-bg-elevated p-1">
        <button
          type="button"
          onClick={() => setPageTab("connections")}
          className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all sm:px-4 ${
            pageTab === "connections" ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-muted hover:text-zk-text"
          }`}
        >
          {t("conn.pageConnections")}
        </button>
        <button
          type="button"
          onClick={() => setPageTab("logs")}
          className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all sm:px-4 ${
            pageTab === "logs" ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-muted hover:text-zk-text"
          }`}
        >
          {t("conn.pageLogs")}
        </button>
      </div>

      {pageTab === "logs" ? (
        <div className="space-y-3">
          <Card>
            <CardHeader title={t("conn.logLevel")} subtitle={t("conn.logLevelSub")} />
            <div className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
              <div className="min-w-[180px] flex-1">
                <Select
                  label={t("config.qLogLevel")}
                  value={logLevel}
                  onChange={(v) => void applyLogLevel(v)}
                  options={[
                    { value: "silent", label: "silent" },
                    { value: "error", label: "error" },
                    { value: "warning", label: "warning" },
                    { value: "info", label: "info" },
                    { value: "debug", label: "debug" },
                  ]}
                />
              </div>
              {logsSaving && <span className="text-xs text-zk-muted">{t("app.loading")}</span>}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title={t("conn.logsLive")}
              subtitle={t("conn.logsLiveSub", { count: logLines.length })}
              action={
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setLogsPaused((p) => !p)}>
                    {logsPaused ? t("conn.logsResume") : t("conn.logsPause")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setLogLines([])}>
                    {t("conn.logsClear")}
                  </Button>
                </div>
              }
            />
            <div className="scrollbar-thin max-h-[420px] overflow-y-auto bg-zk-bg/40 px-3 py-2 font-mono text-[11px] leading-relaxed sm:px-4">
              {logLines.length === 0 ? (
                <p className="py-8 text-center text-zk-dim">{t("conn.logsEmpty")}</p>
              ) : (
                logLines.map((l) => (
                  <div key={l.id} className="border-b border-zk-border-soft/40 py-1">
                    <span className="text-zk-dim">[{l.type}]</span>{" "}
                    <span className="text-zk-text break-all">{l.payload}</span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </Card>
        </div>
      ) : (
        <>
          <div className="flex rounded-xl border border-zk-border-soft bg-zk-bg-elevated p-1">
            <button
              type="button"
              onClick={() => setTab("active")}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all sm:px-4 ${
                tab === "active" ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-muted hover:text-zk-text"
              }`}
            >
              {t("conn.tabActive")} ({activeList.length})
            </button>
            <button
              type="button"
              onClick={() => setTab("closed")}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all sm:px-4 ${
                tab === "closed" ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-muted hover:text-zk-text"
              }`}
            >
              {t("conn.tabClosed")} ({closedList.length})
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile
              label={t("conn.total")}
              value={loading ? "…" : String(stats.count)}
            />
            <StatTile label={t("conn.uniqueIps")} value={loading ? "…" : String(stats.uniqueIps)} />
            <StatTile label={t("conn.upload")} value={formatBytes(stats.upload)} />
            <StatTile label={t("conn.download")} value={formatBytes(stats.download)} />
          </div>

          <Card>
            <CardHeader title={t("conn.filterTitle")} subtitle={t("conn.filterSub")} />
            <div className="space-y-3 p-4 sm:p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-zk-muted">{t("conn.filterIp")}</label>
                  <IpDropdown
                    value={ipFilter}
                    onChange={setIpFilter}
                    options={ipOptions}
                    placeholder={t("conn.noIpFound")}
                    searchPlaceholder={t("conn.searchIp")}
                    allLabel={t("conn.allIps")}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-zk-muted">{t("conn.filterHost")}</label>
                  <input
                    type="text"
                    value={hostFilter}
                    onChange={(e) => setHostFilter(e.target.value)}
                    placeholder="youtube.com"
                    className="w-full rounded-xl border border-zk-border-soft bg-zk-bg/50 px-3 py-2 text-sm text-zk-text outline-none placeholder:text-zk-dim focus:border-zk-accent/40"
                  />
                </div>
              </div>

              {tab === "active" && activeFilteredCount > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-zk-border-soft pt-3">
                  <Button size="sm" variant="danger" disabled={busy} onClick={handleCloseAll}>
                    {busy
                      ? t("app.loading")
                      : ipFilter
                        ? t("conn.closeForIp", { ip: ipFilter, count: activeFilteredCount })
                        : t("conn.closeAll", { count: activeList.length })}
                  </Button>
                </div>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title={tab === "active" ? t("conn.listActive") : t("conn.listClosed")}
              subtitle={t("conn.listSub", { count: filtered.length })}
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zk-border-soft text-[10px] font-semibold uppercase tracking-widest text-zk-dim">
                    <th className="w-[1%] whitespace-nowrap px-3 py-2.5 sm:px-5">{t("conn.colIp")}</th>
                    <th className="px-3 py-2.5 sm:px-5">{t("conn.colHost")}</th>
                    <th className="hidden px-3 py-2.5 md:table-cell md:px-5">{t("conn.colRule")}</th>
                    <th className="min-w-[200px] px-3 py-2.5 sm:min-w-[240px] sm:px-5">{t("conn.colChain")}</th>
                    <th className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right sm:px-5">{t("conn.colDown")}</th>
                    <th className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right sm:px-5">
                      {tab === "closed" ? t("conn.colClosed") : t("conn.colTime")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zk-border-soft">
                  {loading && filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-zk-muted sm:px-5">
                        {t("app.loading")}
                      </td>
                    </tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-zk-muted sm:px-5">
                        {t("conn.noResults")}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((c) => (
                      <tr key={`${c.id}-${c.closedAt ?? "a"}`} className="hover:bg-zk-bg-elevated/40">
                        <td className="whitespace-nowrap px-3 py-2 sm:px-5">
                          <button
                            type="button"
                            onClick={() => setIpFilter(c.sourceIp)}
                            className="font-mono text-xs text-zk-text hover:text-zk-accent"
                          >
                            {c.sourceIp}
                          </button>
                        </td>
                        <td className="max-w-[120px] truncate px-3 py-2 font-mono text-xs text-zk-muted sm:max-w-[160px] sm:px-5" title={c.host}>
                          {c.host}
                        </td>
                        <td className="hidden px-3 py-2 text-xs md:table-cell md:px-5">{c.rule}</td>
                        <td className="px-3 py-2 text-xs leading-snug text-zk-text sm:px-5">
                          <span className="break-words">{c.chain}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-zk-muted sm:px-5">
                          {formatBytes(c.download)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-zk-dim sm:px-5">
                          {c.closedAt ? formatClosedAgo(c.closedAt) : formatDurationSec(c.durationSec)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
