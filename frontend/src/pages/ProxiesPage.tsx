import { useState, useMemo, useCallback } from "react";
import { Badge, Button, Card, CardHeader, MockBanner, Select } from "../components/ui";
import { IconChevron } from "../components/icons";
import { useT } from "../lib/i18n";

interface ProxyNode {
  name: string;
  delay?: number;
}

interface ProxyGroup {
  name: string;
  type: string;
  icon?: string;
  hidden?: boolean;
  nodes: ProxyNode[];
}

const MOCK_NODES: ProxyNode[] = [
  { name: "DIRECT" },
  { name: "🇳🇱 NL-Amsterdam-01", delay: 89 },
  { name: "🇳🇱 NL-Amsterdam-02", delay: 94 },
  { name: "🇩🇪 DE-Frankfurt-01", delay: 112 },
  { name: "🇩🇪 DE-Berlin-02", delay: 118 },
  { name: "🇫🇮 FI-Helsinki-01", delay: 145 },
  { name: "🇸🇪 SE-Stockholm-01", delay: 138 },
  { name: "🇳🇴 NO-Oslo-01", delay: 152 },
  { name: "🇵🇱 PL-Warsaw-01", delay: 130 },
  { name: "🇦🇹 AT-Vienna-01", delay: 125 },
  { name: "🇨🇿 CZ-Prague-01", delay: 128 },
  { name: "🇨🇭 CH-Zurich-01", delay: 135 },
  { name: "🇬🇧 UK-London-01", delay: 167 },
  { name: "🇬🇧 UK-London-02", delay: 172 },
  { name: "🇫🇷 FR-Paris-01", delay: 142 },
  { name: "🇮🇹 IT-Milan-01", delay: 155 },
  { name: "🇪🇸 ES-Madrid-01", delay: 161 },
  { name: "🇺🇸 US-NewYork-01", delay: 201 },
  { name: "🇺🇸 US-LosAngeles-02", delay: 245 },
  { name: "🇺🇸 US-Dallas-03", delay: 218 },
  { name: "🇨🇦 CA-Toronto-01", delay: 210 },
  { name: "🇯🇵 JP-Tokyo-01", delay: 278 },
  { name: "🇸🇬 SG-Singapore-01", delay: 295 },
  { name: "🇦🇺 AU-Sydney-01", delay: 310 },
  { name: "🇧🇷 BR-SaoPaulo-01", delay: 330 },
  { name: "🇹🇷 TR-Istanbul-01", delay: 158 },
];

const MOCK_GROUPS: ProxyGroup[] = [
  { name: "YouTube", type: "select", icon: "https://www.svgrepo.com/show/13671/youtube.svg", nodes: MOCK_NODES },
  { name: "Google", type: "select", icon: "https://www.svgrepo.com/show/475656/google-color.svg", nodes: MOCK_NODES },
  { name: "Google Play", type: "select", icon: "https://www.svgrepo.com/show/353828/google-play-icon.svg", nodes: MOCK_NODES },
  { name: "Gemini", type: "select", icon: "https://www.svgrepo.com/show/331406/gemini.svg", nodes: MOCK_NODES },
  { name: "OpenAI", type: "select", icon: "https://www.svgrepo.com/show/306500/openai.svg", nodes: MOCK_NODES },
  { name: "Telegram", type: "select", icon: "https://www.svgrepo.com/show/354443/telegram.svg", nodes: MOCK_NODES },
  { name: "Discord", type: "select", icon: "https://www.svgrepo.com/show/331368/discord-v2.svg", nodes: MOCK_NODES },
  { name: "Whatsapp", type: "select", icon: "https://www.svgrepo.com/show/349511/spotify.svg", nodes: MOCK_NODES },
  { name: "Instagram", type: "select", icon: "https://www.svgrepo.com/show/452229/instagram-1.svg", nodes: MOCK_NODES },
  { name: "Facebook", type: "select", icon: "https://www.svgrepo.com/show/475647/facebook-color.svg", nodes: MOCK_NODES },
  { name: "Twitter", type: "select", icon: "https://www.svgrepo.com/show/452121/twitter-1.svg", nodes: MOCK_NODES },
  { name: "TikTok", type: "select", icon: "https://www.svgrepo.com/show/349530/tiktok.svg", nodes: MOCK_NODES },
  { name: "Spotify", type: "select", icon: "https://www.svgrepo.com/show/349511/spotify.svg", nodes: MOCK_NODES },
  { name: "Netflix", type: "select", icon: "https://www.svgrepo.com/show/303341/netflix-1-logo.svg", nodes: MOCK_NODES },
  { name: "Twitch", type: "select", icon: "https://www.svgrepo.com/show/448251/twitch.svg", nodes: MOCK_NODES },
  { name: "Steam", type: "select", icon: "https://www.svgrepo.com/show/452107/steam.svg", nodes: MOCK_NODES },
  { name: "Microsoft", type: "select", icon: "https://www.svgrepo.com/show/452062/microsoft.svg", nodes: MOCK_NODES },
  { name: "GitHub", type: "select", icon: "https://www.svgrepo.com/show/344880/github.svg", nodes: MOCK_NODES },
  { name: "Apple", type: "select", icon: "https://www.svgrepo.com/show/501448/apple.svg", nodes: MOCK_NODES },
  { name: "Roblox", type: "select", icon: "https://www.svgrepo.com/show/443377/brand-roblox.svg", nodes: MOCK_NODES },
  { name: "Linkedin", type: "select", icon: "https://www.svgrepo.com/show/448234/linkedin.svg", nodes: MOCK_NODES },
  { name: "Tidal", type: "select", icon: "https://www.svgrepo.com/show/504993/tidal.svg", nodes: MOCK_NODES },
  { name: "Viber", type: "select", icon: "https://www.svgrepo.com/show/125448/viber.svg", nodes: MOCK_NODES },
  { name: "Notion", type: "select", icon: "https://www.svgrepo.com/show/361558/notion-logo.svg", nodes: MOCK_NODES },
  { name: "Fastly", type: "select", icon: "https://www.svgrepo.com/show/353730/fastly.svg", nodes: MOCK_NODES },
  { name: "Speedtest", type: "select", icon: "https://www.svgrepo.com/show/355484/speed.svg", nodes: MOCK_NODES },
  { name: "Oculus", type: "select", icon: "https://www.svgrepo.com/show/293111/maps-and-flags-global.svg", nodes: MOCK_NODES },
  { name: "2IP.IO", type: "select", icon: "https://www.svgrepo.com/show/415672/address-location-map.svg", nodes: MOCK_NODES },
  { name: "intel", type: "select", icon: "https://www.svgrepo.com/show/349412/intel.svg", nodes: MOCK_NODES },
  { name: "18+", type: "select", icon: "https://www.svgrepo.com/show/530357/peach.svg", nodes: MOCK_NODES },
  { name: "other", type: "select", icon: "https://www.svgrepo.com/show/462111/netflix.svg", nodes: MOCK_NODES },
  { name: "RU traffic", type: "select", icon: "https://www.svgrepo.com/show/508628/flag-ru.svg", nodes: MOCK_NODES },
  { name: "Other traffic", type: "select", icon: "https://www.svgrepo.com/show/293111/maps-and-flags-global.svg", nodes: MOCK_NODES },
  { name: "Блокировка рекламы", type: "select", icon: "https://www.svgrepo.com/show/300290/sign-roadblock.svg", nodes: [...MOCK_NODES.filter(n => n.name !== "DIRECT"), { name: "REJECT" }, { name: "DIRECT" }] },
];

const SERVER_OPTIONS = MOCK_NODES.map((n) => ({ value: n.name, label: n.name }));

function delayColor(ms: number) {
  if (ms <= 100) return "text-zk-accent";
  if (ms <= 200) return "text-zk-amber";
  return "text-zk-coral";
}

function GroupIcon({ src, name }: { src?: string; name: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="h-6 w-6 shrink-0 rounded-md object-contain"
        loading="lazy"
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zk-surface-hover text-[11px] font-bold text-zk-muted">
      {name[0]?.toUpperCase()}
    </span>
  );
}

export function ProxiesPage() {
  const t = useT();
  const [expanded, setExpanded] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const g of MOCK_GROUPS) {
      init[g.name] = "DIRECT";
    }
    return init;
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return MOCK_GROUPS;
    const q = search.toLowerCase();
    return MOCK_GROUPS.filter((g) => g.name.toLowerCase().includes(q));
  }, [search]);

  const applyToAll = useCallback((server: string) => {
    setSelected(() => {
      const next: Record<string, string> = {};
      for (const g of MOCK_GROUPS) {
        next[g.name] = server;
      }
      return next;
    });
  }, []);

  return (
    <div className="page-enter space-y-4">
      <MockBanner />

      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("proxies.title")}</h1>
          <p className="mt-1 text-sm text-zk-muted">
            {t("proxies.subtitle", { count: MOCK_GROUPS.length })}
          </p>
        </div>
        <Button size="sm" variant="secondary">⟳ {t("proxies.testAll")}</Button>
      </div>

      {/* Quick apply to all groups */}
      <Card>
        <CardHeader title={t("proxies.quickSelect")} subtitle={t("proxies.quickSelectSub")} />
        <div className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
          <div className="min-w-[200px] flex-1">
            <Select
              label={t("proxies.serverForAll")}
              options={SERVER_OPTIONS}
              value="DIRECT"
              onChange={applyToAll}
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => applyToAll("DIRECT")}>
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
          const currentNode = group.nodes.find((n) => n.name === selected[group.name]);
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
                <GroupIcon src={group.icon} name={group.name} />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold">{group.name}</span>
                  <p className="truncate text-[11px] text-zk-muted">
                    <span className={selected[group.name] === "DIRECT" ? "text-zk-dim" : "text-zk-accent"}>
                      {selected[group.name] || "—"}
                    </span>
                    {currentNode?.delay !== undefined && (
                      <span className={`ml-2 font-mono ${delayColor(currentNode.delay)}`}>
                        {currentNode.delay}ms
                      </span>
                    )}
                  </p>
                </div>
                <Badge variant={selected[group.name] === "DIRECT" ? "muted" : "default"}>
                  {selected[group.name] === "DIRECT" ? "DIRECT" : group.type}
                </Badge>
              </button>

              {open && (
                <div className="border-t border-zk-border-soft px-2 pb-2 sm:px-3">
                  <div className="mt-1 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {group.nodes.map((node) => {
                      const isActive = selected[group.name] === node.name;
                      const isDirect = node.name === "DIRECT";
                      const isReject = node.name === "REJECT";
                      return (
                        <button
                          key={node.name}
                          type="button"
                          onClick={() => setSelected((s) => ({ ...s, [group.name]: node.name }))}
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
                          {node.delay !== undefined && (
                            <span className={`ml-2 shrink-0 font-mono text-xs ${delayColor(node.delay)}`}>
                              {node.delay}ms
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
