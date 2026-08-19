import { useState, useEffect } from "react";
import { Card, CardHeader, Input, Select, Button, Badge } from "../components/ui";
import { useI18n, useT, AVAILABLE_LOCALES } from "../lib/i18n";
import { useSession } from "../lib/session";
import { useMihomoConfig } from "../lib/useMihomoConfig";
import { DEFAULT_PROVIDER, refreshProxyProvider, setSubscriptionUrl, saveMihomoConfig } from "../lib/config";
import type { ClashConnection } from "../lib/api";
import { ApiError } from "../lib/api";

export function SettingsPage() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { clash, setClash, versions, logout, loginInfo } = useSession();
  const cfg = useMihomoConfig();
  const [draft, setDraft] = useState<ClashConnection>(clash);
  const [subUrl, setSubUrl] = useState("");
  const [saved, setSaved] = useState(false);
  const [subSaving, setSubSaving] = useState(false);
  const [subError, setSubError] = useState("");

  useEffect(() => {
    setDraft(clash);
  }, [clash]);

  useEffect(() => {
    setSubUrl(cfg.subscriptionUrl);
  }, [cfg.subscriptionUrl]);

  function saveClash() {
    setClash(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function saveSubscription() {
    if (!cfg.configPath) return;
    setSubSaving(true);
    setSubError("");
    try {
      const updated = setSubscriptionUrl(cfg.yaml, subUrl);
      cfg.setYaml(updated);
      await saveMihomoConfig(cfg.configPath, updated, true);
      try {
        await refreshProxyProvider(DEFAULT_PROVIDER, clash);
      } catch {
        /* optional */
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSubError(err instanceof ApiError ? err.message : t("config.saveError"));
    } finally {
      setSubSaving(false);
    }
  }

  return (
    <div className="page-enter space-y-4">

      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-zk-muted">{t("settings.subtitle")}</p>
      </div>

      <Card>
        <CardHeader title={t("settings.language")} />
        <div className="p-4 sm:p-5">
          <Select
            label={t("settings.language")}
            value={locale}
            onChange={(v) => setLocale(v as "ru" | "en")}
            options={AVAILABLE_LOCALES}
          />
        </div>
      </Card>

      {loginInfo?.enabled && loginInfo.authenticated && (
        <Card>
          <CardHeader title={t("settings.auth")} />
          <div className="p-4 sm:p-5">
            <Button size="sm" variant="secondary" onClick={() => logout()}>
              {t("auth.logout")}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title={t("settings.subscription")} subtitle={t("settings.subscriptionSub")} />
        <div className="space-y-3 p-4 sm:p-5">
          <Input
            label={t("config.qSubUrl")}
            placeholder="https://..."
            mono
            value={subUrl}
            onChange={setSubUrl}
          />
          {subError && <p className="text-xs text-zk-coral">{subError}</p>}
          <Button size="sm" variant="primary" disabled={subSaving || !subUrl.trim()} onClick={saveSubscription}>
            {subSaving ? t("app.loading") : t("settings.saveSubscription")}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settings.clashApi")} subtitle={t("settings.clashApiSub")} />
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <Input
            label="Port"
            placeholder="9090"
            mono
            value={draft.port}
            onChange={(v) => setDraft((d) => ({ ...d, port: v, unix: "" }))}
          />
          <Input
            label="Unix socket"
            placeholder="controller.sock"
            mono
            value={draft.unix}
            onChange={(v) => setDraft((d) => ({ ...d, unix: v, port: v ? "" : d.port || "9090" }))}
            hint={t("settings.unixHint")}
          />
          <div className="sm:col-span-2">
            <Input
              label="Secret"
              type="password"
              placeholder="••••••••"
              value={draft.secret}
              onChange={(v) => setDraft((d) => ({ ...d, secret: v }))}
            />
          </div>
          <div className="sm:col-span-2 flex items-center gap-3">
            <Button size="sm" variant="primary" onClick={saveClash}>
              {saved ? t("settings.saved") : t("settings.saveClash")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settings.updates")} subtitle={t("settings.updatesSub")} />
        <div className="space-y-4 p-4 sm:p-5">
          <div className="space-y-2">
            <UpdateRow
              name="zkeen-ui"
              version={versions?.["zkeen-ui"]?.version || "—"}
              latest={versions?.["zkeen-ui"]?.version || "—"}
            />
            <UpdateRow
              name="mihomo"
              version={versions?.mihomo?.version?.replace(/^v/, "") || "—"}
              latest={versions?.mihomo?.version?.replace(/^v/, "") || "—"}
            />
            <UpdateRow
              name="xray"
              version={versions?.xray?.version?.replace(/^v/, "") || "—"}
              latest={versions?.xray?.version?.replace(/^v/, "") || "—"}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

function UpdateRow({ name, version, latest }: { name: string; version: string; latest: string }) {
  const t = useT();
  const hasUpdate = version !== "—" && latest !== "—" && version !== latest;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zk-border-soft bg-zk-bg-elevated/60 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{name}</span>
          {hasUpdate && <Badge variant="success">{t("settings.updateAvailable")}</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-zk-muted">
          {t("settings.installed")}: <span className="font-mono">{version}</span>
          {" · "}
          {t("settings.latest")}: <span className="font-mono">{latest}</span>
        </p>
      </div>
      <Button size="sm" variant={hasUpdate ? "primary" : "ghost"} disabled={!hasUpdate}>
        {hasUpdate ? t("settings.update") : t("settings.upToDate")}
      </Button>
    </div>
  );
}
