import { Card, CardHeader, Input, MockBanner, Select, Button, Badge } from "../components/ui";
import { useI18n, useT, AVAILABLE_LOCALES } from "../lib/i18n";

export function SettingsPage() {
  const t = useT();
  const { locale, setLocale } = useI18n();

  return (
    <div className="page-enter space-y-4">
      <MockBanner />

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

      <Card>
        <CardHeader title={t("settings.auth")} />
        <div className="space-y-3 p-4 sm:p-5">
          <Input label={t("settings.login")} placeholder="admin" />
          <Input label={t("settings.password")} placeholder="••••••••" />
          <Button size="sm" variant="secondary">{t("settings.changePassword")}</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settings.updates")} subtitle={t("settings.updatesSub")} />
        <div className="space-y-4 p-4 sm:p-5">
          <Select
            label={t("settings.downloadMethod")}
            options={[
              { value: "direct", label: t("settings.direct") },
              { value: "proxy", label: t("settings.proxy") },
            ]}
          />

          <div className="space-y-2">
            <UpdateRow name="zkeen-ui" version="0.0.1-proto" latest="0.0.1" />
            <UpdateRow name="mihomo" version="1.19.2" latest="1.19.4" hasUpdate />
            <UpdateRow name="xkeen" version="1.2.0" latest="1.2.0" />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settings.clashApi")} subtitle={t("settings.clashApiSub")} />
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <Input label="Host" placeholder="0.0.0.0" />
          <Input label="Port" placeholder="9090" mono />
          <div className="sm:col-span-2">
            <Input label="Secret" placeholder="••••••••" />
          </div>
        </div>
      </Card>
    </div>
  );
}

function UpdateRow({ name, version, latest, hasUpdate }: {
  name: string;
  version: string;
  latest: string;
  hasUpdate?: boolean;
}) {
  const t = useT();
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
