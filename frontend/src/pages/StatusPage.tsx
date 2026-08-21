import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Card, CardHeader, StatTile } from "../components/ui";
import { useT } from "../lib/i18n";
import { useSession } from "../lib/session";
import { clashJson } from "../lib/api";
import {
  formatBytes,
  formatTrafficTotal,
  parseConnectionCount,
  parseMemoryBytes,
  type ClashConnectionsResponse,
  type ClashVersionResponse,
} from "../lib/clash";

export function StatusPage() {
  const t = useT();
  const { control, versions, clash } = useSession();
  const [clashVersion, setClashVersion] = useState("");
  const [memory, setMemory] = useState("—");
  const [connections, setConnections] = useState("—");
  const [traffic, setTraffic] = useState("—");
  const clashRef = useRef(clash);
  clashRef.current = clash;

  const running = control?.running ?? false;
  const panelPort = typeof window !== "undefined" && window.location.port ? window.location.port : "7220";

  const loadClashStats = useCallback(async () => {
    const conn = clashRef.current;
    try {
      // Do NOT GET /memory — Mihomo streams it and hangs HTTP until timeout.
      const [ver, trafficData] = await Promise.all([
        clashJson<ClashVersionResponse>("version", conn, undefined, 8000).catch(() => null),
        clashJson<ClashConnectionsResponse>("connections", conn, undefined, 8000).catch(() => null),
      ]);

      if (ver?.version) {
        setClashVersion(ver.version.replace(/^v/i, ""));
      }

      const memBytes = parseMemoryBytes(trafficData);
      setMemory(memBytes !== undefined ? formatBytes(memBytes) : "—");
      setConnections(trafficData ? String(parseConnectionCount(trafficData)) : "—");
      setTraffic(formatTrafficTotal(trafficData));
    } catch {
      setMemory("—");
      setConnections("—");
      setTraffic("—");
    }
  }, []);

  useEffect(() => {
    loadClashStats();
    const id = setInterval(loadClashStats, 5000);
    return () => clearInterval(id);
  }, [loadClashStats, clash.port, clash.secret, clash.unix]);

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("status.title")}</h1>
        <p className="mt-1 text-sm text-zk-muted">{t("status.subtitle")}</p>
      </div>

      <Card glow className="overflow-hidden">
        <CardHeader
          title="Mihomo"
          subtitle={t("status.core")}
          action={
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${running ? "bg-zk-accent animate-pulse-dot" : "bg-zk-dim"}`}
              />
              <Badge variant={running ? "success" : "muted"}>
                {running ? t("status.running") : t("status.stopped")}
              </Badge>
            </div>
          }
        />
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 sm:p-5">
          <StatTile label={t("status.traffic")} value={traffic || "—"} />
          <StatTile
            label={t("status.connections")}
            value={connections || "—"}
            hint={t("status.active")}
          />
          <StatTile label={t("status.memory")} value={memory || "—"} />
          <StatTile
            label={t("status.version")}
            value={clashVersion || versions?.mihomo?.version?.replace(/^v/i, "") || "—"}
          />
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader title="XKeen" subtitle={t("status.xkeen")} />
          <div className="space-y-2 p-4 sm:p-5">
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.statusLabel")}</span>
              <span className={`font-medium ${running ? "text-zk-accent" : "text-zk-dim"}`}>
                {running ? "Active" : "Stopped"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.coreLabel")}</span>
              <span className="font-medium">{control?.currentCore || "—"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.clashApi")}</span>
              <span className="font-mono text-xs">
                {clash.unix ? `unix:${clash.unix}` : `127.0.0.1:${clash.port || "9090"}`}
              </span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="zKeen UI" subtitle={t("status.panel")} />
          <div className="space-y-2 p-4 sm:p-5">
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.versionLabel")}</span>
              <span className="font-mono text-xs">{versions?.["zkeen-ui"]?.version || "—"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.portLabel")}</span>
              <span className="font-mono text-xs">{panelPort}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
