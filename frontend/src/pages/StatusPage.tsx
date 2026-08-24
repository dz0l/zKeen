import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Card, CardHeader, StatTile } from "../components/ui";
import { useT } from "../lib/i18n";
import { useSession, type ControlInfo } from "../lib/session";
import { apiJson, clashJson } from "../lib/api";
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
  const [liveControl, setLiveControl] = useState<ControlInfo | null>(control);
  const [clashUp, setClashUp] = useState<boolean | null>(null);
  const [clashVersion, setClashVersion] = useState("");
  const [memory, setMemory] = useState("—");
  const [connections, setConnections] = useState("—");
  const [traffic, setTraffic] = useState("—");
  const clashRef = useRef(clash);
  clashRef.current = clash;

  // Prefer live /api/control; fall back to session snapshot until first poll.
  const ctrl = liveControl ?? control;
  const mihomoRunning =
    clashUp === true
      ? true
      : clashUp === false
        ? false
        : (ctrl?.mihomoRunning ?? ctrl?.running ?? false);
  const xkeenRunning = ctrl?.xkeenRunning ?? mihomoRunning;

  const loadControl = useCallback(async () => {
    try {
      const res = await apiJson<ControlInfo & { success: boolean }>("/api/control");
      setLiveControl({
        cores: res.cores,
        currentCore: res.currentCore,
        running: res.running,
        mihomoRunning: res.mihomoRunning,
        xrayRunning: res.xrayRunning,
        xkeenRunning: res.xkeenRunning,
      });
    } catch {
      /* keep previous */
    }
  }, []);

  const loadClashStats = useCallback(async () => {
    const conn = clashRef.current;
    try {
      // Do NOT GET /memory — Mihomo streams it and hangs HTTP until timeout.
      const [ver, trafficData] = await Promise.all([
        clashJson<ClashVersionResponse>("version", conn, undefined, 8000).catch(() => null),
        clashJson<ClashConnectionsResponse>("connections", conn, undefined, 8000).catch(() => null),
      ]);

      const up = Boolean(ver?.version || trafficData);
      setClashUp(up);

      if (ver?.version) {
        setClashVersion(ver.version.replace(/^v/i, ""));
      }

      if (up) {
        const memBytes = parseMemoryBytes(trafficData);
        setMemory(memBytes !== undefined ? formatBytes(memBytes) : "—");
        setConnections(trafficData ? String(parseConnectionCount(trafficData)) : "—");
        setTraffic(formatTrafficTotal(trafficData));
      } else {
        setMemory("—");
        setConnections("—");
        setTraffic("—");
      }
    } catch {
      setClashUp(false);
      setMemory("—");
      setConnections("—");
      setTraffic("—");
    }
  }, []);

  useEffect(() => {
    void loadControl();
    void loadClashStats();
    const id = setInterval(() => {
      void loadControl();
      void loadClashStats();
    }, 5000);
    return () => clearInterval(id);
  }, [loadControl, loadClashStats, clash.port, clash.secret, clash.unix]);

  const panelPort =
    typeof window !== "undefined" && window.location.port ? window.location.port : "7220";

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
                className={`h-2 w-2 rounded-full ${mihomoRunning ? "bg-zk-accent animate-pulse-dot" : "bg-zk-dim"}`}
              />
              <Badge variant={mihomoRunning ? "success" : "muted"}>
                {mihomoRunning ? t("status.running") : t("status.stopped")}
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
              <span className={`font-medium ${xkeenRunning ? "text-zk-accent" : "text-zk-dim"}`}>
                {xkeenRunning ? "Active" : "Stopped"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.coreLabel")}</span>
              <span className="font-medium">{ctrl?.currentCore || "—"}</span>
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
