import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, Card, CardHeader, MockBanner, StatTile } from "../components/ui";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";

type ConnTab = "active" | "closed";

interface Connection {
  id: string;
  sourceIp: string;
  host: string;
  network: "TCP" | "UDP";
  rule: string;
  chain: string;
  upload: number;
  download: number;
  durationSec: number;
  closedAt?: number;
}

const HOSTS = [
  "www.youtube.com", "api.telegram.org", "discord.com", "www.google.com",
  "api.openai.com", "netflix.com", "yandex.ru", "steamcommunity.com",
  "scontent.cdninstagram.com", "github.com", "apple.com", "spotify.com",
];

const RULES = ["YouTube", "Telegram", "Discord", "Google", "OpenAI", "Netflix", "RU traffic", "Steam", "Instagram", "DIRECT"];
const CHAINS = ["🇳🇱 NL-Amsterdam-01", "🇩🇪 DE-Frankfurt-02", "🇫🇮 FI-Helsinki-01", "🇺🇸 US-NewYork-03", "DIRECT"];

function buildMockConnections(): { active: Connection[]; closed: Connection[] } {
  const active: Connection[] = [];
  const closed: Connection[] = [];
  let id = 1;

  for (let i = 1; i <= 120; i++) {
    const ip = `192.168.1.${i}`;
    const count = i <= 20 ? (i % 4) + 1 : i % 3 === 0 ? 1 : 0;
    for (let j = 0; j < count; j++) {
      active.push({
        id: String(id++),
        sourceIp: ip,
        host: HOSTS[(i + j) % HOSTS.length],
        network: j % 5 === 0 ? "UDP" : "TCP",
        rule: RULES[(i + j) % RULES.length],
        chain: CHAINS[(i + j) % CHAINS.length],
        upload: 500 + (i * 97 + j * 13) % 50000,
        download: 2000 + (i * 131 + j * 17) % 500000,
        durationSec: 10 + (i * 7 + j * 3) % 3600,
      });
    }
  }

  for (let k = 0; k < 45; k++) {
    const i = (k % 80) + 1;
    closed.push({
      id: `c-${id++}`,
      sourceIp: `192.168.1.${i}`,
      host: HOSTS[k % HOSTS.length],
      network: k % 4 === 0 ? "UDP" : "TCP",
      rule: RULES[k % RULES.length],
      chain: CHAINS[k % CHAINS.length],
      upload: 1000 + k * 200,
      download: 5000 + k * 800,
      durationSec: 30 + k * 12,
      closedAt: Date.now() - k * 60000 - 30000,
    });
  }

  return { active, closed };
}

const INITIAL = buildMockConnections();

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
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
    setMenuPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
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

  const label = value || allLabel;

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
            onClick={() => { onChange(""); setOpen(false); setSearch(""); }}
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
                onClick={() => { onChange(ip); setOpen(false); setSearch(""); }}
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
      {options.length > 0 && (
        <div className="border-t border-zk-border-soft px-3 py-1.5 text-[10px] text-zk-dim">
          {filtered.length} / {options.length}
        </div>
      )}
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
        <span className={`truncate font-mono ${value ? "text-zk-text" : "text-zk-muted"}`}>{label}</span>
        <span className="shrink-0 text-zk-dim">{open ? "▴" : "▾"}</span>
      </button>

      {menu && createPortal(menu, document.body)}
    </div>
  );
}

export function ConnectionsPage() {
  const t = useT();
  const { mode } = useApp();
  const [tab, setTab] = useState<ConnTab>("active");
  const [activeList, setActiveList] = useState(INITIAL.active);
  const [closedList, setClosedList] = useState(INITIAL.closed);
  const [ipFilter, setIpFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");

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
    return { count: filtered.length, upload: up, download: down, uniqueIps: ips.size };
  }, [filtered]);

  const closeMatching = (match: (c: Connection) => boolean) => {
    const toClose = activeList.filter(match);
    if (toClose.length === 0) return;
    const now = Date.now();
    setActiveList((prev) => prev.filter((c) => !match(c)));
    setClosedList((prev) => [
      ...toClose.map((c) => ({ ...c, closedAt: now })),
      ...prev,
    ]);
  };

  const confirmClose = (message: string, action: () => void) => {
    if (mode === "safe" && !window.confirm(message)) return;
    action();
  };

  const handleCloseAll = () => {
    const target = ipFilter
      ? activeList.filter((c) => c.sourceIp === ipFilter)
      : activeList;
    if (target.length === 0) return;
    const msg = ipFilter
      ? t("conn.confirmCloseIp", { ip: ipFilter, count: target.length })
      : t("conn.confirmCloseAll", { count: target.length });
    confirmClose(msg, () => {
      if (ipFilter) closeMatching((c) => c.sourceIp === ipFilter);
      else closeMatching(() => true);
    });
  };

  const activeFilteredCount = ipFilter
    ? activeList.filter((c) => c.sourceIp === ipFilter).length
    : activeList.length;

  return (
    <div className="page-enter space-y-4">
      <MockBanner />

      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("conn.title")}</h1>
        <p className="mt-1 text-sm text-zk-muted">{t("conn.subtitle")}</p>
      </div>

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
          value={String(stats.count)}
          hint={tab === "active" ? t("conn.ofTotal", { total: activeList.length }) : undefined}
        />
        <StatTile label={t("conn.uniqueIps")} value={String(stats.uniqueIps)} />
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
              <Button size="sm" variant="danger" onClick={handleCloseAll}>
                {ipFilter
                  ? t("conn.closeForIp", { ip: ipFilter, count: activeFilteredCount })
                  : t("conn.closeAll", { count: activeList.length })}
              </Button>
              {mode === "safe" && (
                <span className="self-center text-[10px] text-zk-safe">{t("conn.safeCloseHint")}</span>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title={tab === "active" ? t("conn.listActive") : t("conn.listClosed")}
          subtitle={t("conn.listSub", { count: filtered.length })}
          action={
            ipFilter ? (
              <Badge variant="default">
                {ipFilter}
                <button type="button" onClick={() => setIpFilter("")} className="ml-1 opacity-70 hover:opacity-100">✕</button>
              </Badge>
            ) : undefined
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-zk-border-soft text-[10px] font-semibold uppercase tracking-widest text-zk-dim">
                <th className="px-3 py-2.5 sm:px-5">{t("conn.colIp")}</th>
                <th className="px-3 py-2.5 sm:px-5">{t("conn.colHost")}</th>
                <th className="hidden px-3 py-2.5 sm:table-cell sm:px-5">{t("conn.colNetwork")}</th>
                <th className="hidden px-3 py-2.5 md:table-cell md:px-5">{t("conn.colRule")}</th>
                <th className="hidden px-3 py-2.5 lg:table-cell lg:px-5">{t("conn.colChain")}</th>
                <th className="px-3 py-2.5 text-right sm:px-5">{t("conn.colDown")}</th>
                <th className="px-3 py-2.5 text-right sm:px-5">
                  {tab === "closed" ? t("conn.colClosed") : t("conn.colTime")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zk-border-soft">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-zk-muted sm:px-5">
                    {t("conn.noResults")}
                  </td>
                </tr>
              ) : (
                filtered.map((c) => (
                  <tr key={c.id} className="hover:bg-zk-bg-elevated/40">
                    <td className="px-3 py-2 sm:px-5">
                      <button
                        type="button"
                        onClick={() => setIpFilter(c.sourceIp)}
                        className={`font-mono text-xs transition-colors ${
                          ipFilter === c.sourceIp ? "font-semibold text-zk-accent" : "text-zk-text hover:text-zk-accent"
                        }`}
                      >
                        {c.sourceIp}
                      </button>
                    </td>
                    <td className="max-w-[120px] truncate px-3 py-2 font-mono text-xs text-zk-muted sm:max-w-[180px] sm:px-5" title={c.host}>
                      {c.host}
                    </td>
                    <td className="hidden px-3 py-2 sm:table-cell sm:px-5">
                      <Badge variant="muted">{c.network}</Badge>
                    </td>
                    <td className="hidden px-3 py-2 text-xs md:table-cell md:px-5">{c.rule}</td>
                    <td className="hidden max-w-[120px] truncate px-3 py-2 text-xs lg:table-cell lg:px-5" title={c.chain}>
                      {c.chain}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-zk-muted sm:px-5">{formatBytes(c.download)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-zk-dim sm:px-5">
                      {c.closedAt ? formatClosedAgo(c.closedAt) : formatDuration(c.durationSec)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
