import { useState, useEffect } from "react";
import { Card, CardHeader, Input, Select, Button, Badge } from "../components/ui";
import { useI18n, useT, AVAILABLE_LOCALES } from "../lib/i18n";
import { useSession, type VersionEntry, type VersionInfo } from "../lib/session";
import { apiJson, type ClashConnection } from "../lib/api";
import { displayApiError, useApiError } from "../lib/errors";

function stripV(v?: string): string {
  if (!v) return "—";
  return v.replace(/^v/i, "");
}

function displayLatest(entry?: VersionEntry): string {
  if (!entry) return "—";
  return stripV(entry.latest || entry.version);
}

export function SettingsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const apiErr = useApiError();
  const { clash, setClash, versions, setVersions, logout, loginInfo } = useSession();
  const [draft, setDraft] = useState<ClashConnection>(clash);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [updating, setUpdating] = useState("");

  useEffect(() => {
    setDraft(clash);
  }, [clash]);

  function saveClash() {
    setClash(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function checkUpdates() {
    setChecking(true);
    setCheckError("");
    try {
      const res = await apiJson<
        VersionInfo & { success?: boolean; check_ok?: boolean; check_error?: string }
      >("/api/version/check", {
        method: "POST",
      });
      setVersions(res);
      if (res.check_ok === false) {
        setCheckError(
          displayApiError(res.check_error || "", t, "settings.checkError", locale),
        );
      }
    } catch (err) {
      setCheckError(apiErr(err, "settings.checkError"));
    } finally {
      setChecking(false);
    }
  }

  async function runUpdate(core: string, version: string) {
    if (!version || version === "—") return;
    setUpdating(core);
    setCheckError("");
    try {
      await apiJson("/api/update", {
        method: "POST",
        body: JSON.stringify({
          core,
          version,
          backup_core: true,
          assets: [],
        }),
      });
      await checkUpdates();
    } catch (err) {
      setCheckError(apiErr(err, "settings.updateError"));
    } finally {
      setUpdating("");
    }
  }

  const ui = versions?.["zkeen-ui"];
  const mihomo = versions?.mihomo;
  const xray = versions?.xray;

  return (
    <div className={embedded ? "space-y-4" : "page-enter space-y-4"}>
      {!embedded && (
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("settings.title")}</h1>
          <p className="mt-1 text-sm text-zk-muted">{t("settings.subtitle")}</p>
        </div>
      )}

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
        <CardHeader
          title={t("settings.updates")}
          subtitle={t("settings.updatesSub")}
          action={
            <Button size="sm" variant="secondary" disabled={checking} onClick={() => void checkUpdates()}>
              {checking ? t("settings.checking") : t("settings.checkUpdates")}
            </Button>
          }
        />
        <div className="space-y-4 p-4 sm:p-5">
          {checkError && (
            <p className="rounded-lg border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
              {checkError}
            </p>
          )}
          <div className="space-y-2">
            <UpdateRow
              name="zkeen-ui"
              version={stripV(ui?.version)}
              latest={displayLatest(ui)}
              outdated={!!ui?.outdated || (stripV(ui?.version) !== displayLatest(ui) && displayLatest(ui) !== "—")}
              updating={updating === "self"}
              onUpdate={() => void runUpdate("self", displayLatest(ui))}
            />
            <UpdateRow
              name="mihomo"
              version={stripV(mihomo?.version)}
              latest={displayLatest(mihomo)}
              outdated={
                !!mihomo?.outdated ||
                (stripV(mihomo?.version) !== displayLatest(mihomo) && displayLatest(mihomo) !== "—")
              }
              updating={updating === "mihomo"}
              onUpdate={() => void runUpdate("mihomo", displayLatest(mihomo))}
            />
            <UpdateRow
              name="xray"
              version={stripV(xray?.version)}
              latest={displayLatest(xray)}
              outdated={
                !!xray?.outdated || (stripV(xray?.version) !== displayLatest(xray) && displayLatest(xray) !== "—")
              }
              updating={updating === "xray"}
              onUpdate={() => void runUpdate("xray", displayLatest(xray))}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

function UpdateRow({
  name,
  version,
  latest,
  outdated,
  updating,
  onUpdate,
}: {
  name: string;
  version: string;
  latest: string;
  outdated: boolean;
  updating?: boolean;
  onUpdate?: () => void;
}) {
  const t = useT();
  const hasUpdate = outdated && version !== "—" && latest !== "—" && version !== latest;
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
      <Button
        size="sm"
        variant={hasUpdate ? "primary" : "ghost"}
        disabled={!hasUpdate || updating}
        onClick={onUpdate}
      >
        {updating ? t("app.loading") : hasUpdate ? t("settings.update") : t("settings.upToDate")}
      </Button>
    </div>
  );
}
