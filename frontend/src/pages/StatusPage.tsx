import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Card, CardHeader, StatTile } from "../components/ui";
import { useT } from "../lib/i18n";
import { useSession, type ControlInfo } from "../lib/session";
import { apiJson, clashJson, clashWsUrl } from "../lib/api";
import {
  formatBytes,
  formatTrafficTotal,
  parseConnectionCount,
  parseMemoryBytes,
  type ClashConnectionsResponse,
  type ClashMemoryResponse,
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
  const memorySampleRef = useRef(0);

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
      // Do NOT GET /memory over HTTP — Mihomo streams it and hangs until timeout.
      // RSS comes from the WebSocket below; /connections memory is only a non-zero fallback.
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
        setConnections(trafficData ? String(parseConnectionCount(trafficData)) : "—");
        setTraffic(formatTrafficTotal(trafficData));
        if (memorySampleRef.current === 0) {
          const fallback = parseMemoryBytes(trafficData);
          if (fallback !== undefined) {
            memorySampleRef.current = fallback;
            setMemory(formatBytes(fallback));
          }
        }
      } else {
        memorySampleRef.current = 0;
        setMemory("—");
        setConnections("—");
        setTraffic("—");
      }
    } catch {
      setClashUp(false);
      memorySampleRef.current = 0;
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

  // Live RSS via /memory WebSocket. First frame is always inuse:0 — skip until a real sample.
  // Do not reset the retry budget on browser onopen: /clash-ws accepts before Mihomo is reached.
  useEffect(() => {
    if (!mihomoRunning) return;

    const url = clashWsUrl("memory", clashRef.current);
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: number | undefined;
    let attempts = 0;
    let gotSample = false;
    const MAX_ATTEMPTS = 8;

    const clearTimer = () => {
      if (reconnectTimer === undefined) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };

    const clearStaleMemory = () => {
      memorySampleRef.current = 0;
      setMemory("—");
    };

    const applySample = (raw: ClashMemoryResponse) => {
      const bytes = parseMemoryBytes(raw);
      if (bytes === undefined) return;
      gotSample = true;
      attempts = 0;
      memorySampleRef.current = bytes;
      setMemory(formatBytes(bytes));
    };

    const connect = () => {
      if (closed) return;
      clearTimer();
      try {
        ws = new WebSocket(url);
      } catch {
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
          clearStaleMemory();
          return;
        }
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * attempts, 8000));
        return;
      }
      ws.onmessage = (ev) => {
        try {
          applySample(JSON.parse(String(ev.data)) as ClashMemoryResponse);
        } catch {
          /* ignore non-JSON */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
          clearStaleMemory();
          return;
        }
        // Keep the last good reading while retrying; clear only after the budget is spent.
        if (!gotSample) setMemory("—");
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * attempts, 8000));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimer();
      ws?.close();
    };
  }, [clash.port, clash.secret, clash.unix, mihomoRunning]);

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
          <StatTile label={t("status.memoryRss")} value={memory || "—"} />
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
