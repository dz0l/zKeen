import { Badge, Button, Card, CardHeader, MockBanner, StatTile } from "../components/ui";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";

export function StatusPage() {
  const { mode } = useApp();
  const t = useT();

  return (
    <div className="page-enter space-y-4">
      <MockBanner />

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
              <span className="h-2 w-2 rounded-full bg-zk-accent animate-pulse-dot" />
              <Badge variant="success">{t("status.running")}</Badge>
            </div>
          }
        />
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 sm:p-5">
          <StatTile label={t("status.uptime")} value="2д 14ч" />
          <StatTile label={t("status.connections")} value="37" hint={t("status.active")} />
          <StatTile label={t("status.memory")} value="42 MB" />
          <StatTile label={t("status.version")} value="1.19.2" />
        </div>
        <div className="flex flex-wrap gap-2 border-t border-zk-border-soft px-4 py-3 sm:px-5">
          <Button size="sm" variant="secondary">{t("status.restart")}</Button>
          <Button size="sm" variant="ghost">{t("status.stop")}</Button>
          {mode === "safe" && (
            <span className="ml-auto self-center text-[10px] text-zk-safe">
              {t("status.safeRestart")}
            </span>
          )}
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader title="XKeen" subtitle={t("status.xkeen")} />
          <div className="space-y-2 p-4 sm:p-5">
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.statusLabel")}</span>
              <span className="font-medium text-zk-accent">Active</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.coreLabel")}</span>
              <span className="font-medium">mihomo</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.clashApi")}</span>
              <span className="font-mono text-xs">0.0.0.0:9090</span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="zkeen-ui" subtitle={t("status.panel")} />
          <div className="space-y-2 p-4 sm:p-5">
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.versionLabel")}</span>
              <span className="font-medium">0.0.1-proto</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.modeLabel")}</span>
              <Badge variant={mode === "safe" ? "safe" : "expert"}>{mode}</Badge>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zk-muted">{t("status.portLabel")}</span>
              <span className="font-mono text-xs">:1000</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
