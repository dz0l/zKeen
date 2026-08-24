import { useEffect, useState } from "react";
import { Card, CardHeader, Select, Button, Badge, Input } from "../components/ui";
import { useI18n, useT, AVAILABLE_LOCALES } from "../lib/i18n";
import { useApp } from "../lib/store";
import { useSession, type VersionEntry, type VersionInfo } from "../lib/session";
import { apiJson, ApiError } from "../lib/api";
import { displayApiError, useApiError } from "../lib/errors";
import {
  applyMihomoConfigChanges,
  ensureZkeenMihomoConfig,
  fetchMihomoConfig,
  isZkeenReadyConfig,
} from "../lib/config";
import { waitForPanelAndHardReload } from "../lib/panelReload";

function stripV(v?: string): string {
  if (!v) return "—";
  return v.replace(/^v/i, "");
}

function displayLatest(entry?: VersionEntry): string {
  if (!entry) return "—";
  return stripV(entry.latest || entry.version);
}

function IconRestart({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path
        d="M21 12a9 9 0 1 1-2.6-6.2M21 3v6h-6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SettingsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const { mode } = useApp();
  const { locale, setLocale } = useI18n();
  const apiErr = useApiError();
  const { clash, setClash, versions, setVersions, logout, loginInfo, refreshSession } = useSession();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [updating, setUpdating] = useState("");
  const [restarting, setRestarting] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState("");
  const [password, setPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState("");
  const [panelPort, setPanelPort] = useState(
    () => window.location.port || "7220",
  );
  const [portBusy, setPortBusy] = useState(false);
  const [portMsg, setPortMsg] = useState("");

  useEffect(() => {
    void apiJson<{ success?: boolean; port?: number }>("/api/panel")
      .then((res) => {
        if (res.port) setPanelPort(String(res.port));
      })
      .catch(() => {
        /* keep location.port */
      });
  }, []);

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
      if (core === "self") {
        setCheckError(t("settings.reloadingPanel"));
        await waitForPanelAndHardReload({ initialDelayMs: 1200 });
        return;
      }
      await checkUpdates();
    } catch (err) {
      setCheckError(apiErr(err, "settings.updateError"));
    } finally {
      setUpdating("");
    }
  }

  async function runRestart(action: string, key: string) {
    if (mode === "safe" && !window.confirm(t("settings.restartConfirm", { name: key }))) return;
    setRestarting(key);
    setCheckError("");
    try {
      await apiJson("/api/control", {
        method: "POST",
        body: JSON.stringify({ action, core: "mihomo" }),
      });
      if (action === "restartPanel") {
        setCheckError(t("settings.reloadingPanel"));
        await waitForPanelAndHardReload({ initialDelayMs: 800 });
        return;
      }
      await refreshSession();
    } catch (err) {
      setCheckError(apiErr(err, "status.actionError"));
    } finally {
      setRestarting("");
    }
  }

  async function setPanelPassword() {
    const pwd = password.trim();
    if (pwd.length < 4) {
      setCheckError(t("settings.passwordTooShort"));
      return;
    }
    setPasswordBusy(true);
    setPasswordMsg("");
    setCheckError("");
    try {
      await apiJson("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ password: pwd, remember: true }),
      });
      setPassword("");
      setPasswordMsg(t("settings.passwordSet"));
      await refreshSession();
    } catch (err) {
      setCheckError(apiErr(err, "settings.passwordError"));
    } finally {
      setPasswordBusy(false);
    }
  }

  async function applyPanelPort() {
    const port = Number(panelPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setCheckError(t("settings.portInvalid"));
      return;
    }
    if (!window.confirm(t("settings.portConfirm", { port }))) return;
    setPortBusy(true);
    setPortMsg("");
    setCheckError("");
    try {
      const res = await apiJson<{ success?: boolean; port?: number; restarted?: boolean }>(
        "/api/panel/port",
        {
          method: "POST",
          body: JSON.stringify({ port }),
        },
      );
      if (res.restarted === false) {
        setPortMsg(t("settings.portUnchanged"));
        return;
      }
      setPortMsg(t("settings.reloadingPanel"));
      await waitForPanelAndHardReload({ port, initialDelayMs: 1000 });
    } catch (err) {
      setCheckError(apiErr(err, "settings.portError"));
    } finally {
      setPortBusy(false);
    }
  }

  async function resetConfig() {
    setResetMsg("");
    setCheckError("");
    if (!window.confirm(t("settings.resetConfigConfirm"))) return;

    try {
      const current = await fetchMihomoConfig();
      if (current?.content) {
        const wantExport = window.confirm(t("settings.resetConfigExport"));
        if (wantExport) {
          const blob = new Blob([current.content], { type: "text/yaml" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "config.yaml";
          a.click();
          URL.revokeObjectURL(url);
        }
      }
    } catch {
      /* export optional */
    }

    setResetting(true);
    try {
      await ensureZkeenMihomoConfig(true);
      const loaded = await fetchMihomoConfig();
      if (!loaded?.content || !isZkeenReadyConfig(loaded.content)) {
        throw new ApiError(500, t("settings.resetConfigError"));
      }
      const conn = await applyMihomoConfigChanges(clash, { hardRestart: true });
      setClash(conn);
      await refreshSession();
      setResetMsg(t("settings.resetConfigDone"));
    } catch (err) {
      setCheckError(apiErr(err, "settings.resetConfigError"));
    } finally {
      setResetting(false);
    }
  }

  const ui = versions?.["zkeen-ui"];
  const mihomo = versions?.mihomo;
  const xray = versions?.xray;
  const xrayInstalled = Boolean(xray?.version && stripV(xray.version) !== "—");

  return (
    <div className={embedded ? "space-y-4" : "page-enter space-y-4"}>
      {!embedded && (
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("settings.title")}</h1>
          <p className="mt-1 text-sm text-zk-muted">{t("settings.subtitle")}</p>
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <span className="shrink-0 text-sm font-semibold text-zk-text">{t("settings.language")}</span>
          <Select
            inline
            compact
            className="min-w-0 max-w-[200px] flex-1 justify-end"
            label=""
            value={locale}
            onChange={(v) => setLocale(v as "ru" | "en")}
            options={AVAILABLE_LOCALES}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settings.password")} subtitle={t("settings.passwordSub")} />
        <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-end sm:p-4">
          <div className="min-w-0 flex-1">
            <Input
              label={t("settings.password")}
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={setPassword}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={passwordBusy || password.trim().length < 4}
            onClick={() => void setPanelPassword()}
          >
            {passwordBusy ? t("app.loading") : t("settings.passwordSetBtn")}
          </Button>
        </div>
        {passwordMsg && (
          <p className="border-t border-zk-border-soft px-3 py-2 text-xs text-zk-accent sm:px-4">
            {passwordMsg}
          </p>
        )}
        {loginInfo?.enabled && loginInfo.authenticated && (
          <div className="flex justify-end border-t border-zk-border-soft px-3 py-2 sm:px-4">
            <Button size="sm" variant="ghost" onClick={() => logout()}>
              {t("auth.logout")}
            </Button>
          </div>
        )}
      </Card>

      {mode === "expert" && (
        <Card>
          <CardHeader title={t("settings.port")} subtitle={t("settings.portSub")} />
          <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-end sm:p-4">
            <div className="min-w-0 flex-1">
              <Input
                label={t("settings.port")}
                mono
                placeholder="7220"
                value={panelPort}
                onChange={setPanelPort}
                hint={t("settings.portHint")}
              />
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={portBusy}
              onClick={() => void applyPanelPort()}
            >
              {portBusy ? t("app.loading") : t("settings.portApply")}
            </Button>
          </div>
          {portMsg && (
            <p className="border-t border-zk-border-soft px-3 py-2 text-xs text-zk-accent sm:px-4">
              {portMsg}
            </p>
          )}
        </Card>
      )}

      {mode === "expert" && (
        <Card>
          <CardHeader title={t("settings.resetConfig")} subtitle={t("settings.resetConfigSub")} />
          <div className="space-y-3 p-4 sm:p-5">
            {resetMsg && (
              <p className="rounded-lg border border-zk-accent/25 bg-zk-accent/10 px-3 py-2 text-xs text-zk-accent">
                {resetMsg}
              </p>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={resetting}
              onClick={() => void resetConfig()}
            >
              {resetting ? t("app.loading") : t("settings.resetConfig")}
            </Button>
          </div>
        </Card>
      )}

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
              restarting={restarting === "zkeen-ui"}
              onUpdate={() => void runUpdate("self", displayLatest(ui))}
              onRestart={() => void runRestart("restartPanel", "zkeen-ui")}
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
              restarting={restarting === "mihomo"}
              onUpdate={() => void runUpdate("mihomo", displayLatest(mihomo))}
              onRestart={() => void runRestart("hardRestart", "mihomo")}
            />
            <UpdateRow
              name="xkeen"
              version="—"
              latest="—"
              outdated={false}
              restartOnly
              restarting={restarting === "xkeen"}
              onRestart={() => void runRestart("restartXkeen", "xkeen")}
            />
            {xrayInstalled && (
              <UpdateRow
                name="xray"
                version={stripV(xray?.version)}
                latest={displayLatest(xray)}
                outdated={
                  !!xray?.outdated ||
                  (stripV(xray?.version) !== displayLatest(xray) && displayLatest(xray) !== "—")
                }
                updating={updating === "xray"}
                onUpdate={() => void runUpdate("xray", displayLatest(xray))}
              />
            )}
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
  restarting,
  restartOnly,
  onUpdate,
  onRestart,
}: {
  name: string;
  version: string;
  latest: string;
  outdated: boolean;
  updating?: boolean;
  restarting?: boolean;
  restartOnly?: boolean;
  onUpdate?: () => void;
  onRestart?: () => void;
}) {
  const t = useT();
  const hasUpdate = !restartOnly && outdated && version !== "—" && latest !== "—" && version !== latest;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zk-border-soft bg-zk-bg-elevated/60 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{name}</span>
          {hasUpdate && <Badge variant="success">{t("settings.updateAvailable")}</Badge>}
        </div>
        {!restartOnly && (
          <p className="mt-0.5 text-xs text-zk-muted">
            {t("settings.installed")}: <span className="font-mono">{version}</span>
            {" · "}
            {t("settings.latest")}: <span className="font-mono">{latest}</span>
          </p>
        )}
        {restartOnly && (
          <p className="mt-0.5 text-xs text-zk-muted">{t("settings.restartService")}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onRestart && (
          <button
            type="button"
            title={t("settings.restart")}
            disabled={!!restarting || !!updating}
            onClick={onRestart}
            className="rounded-lg border border-zk-border-soft p-2 text-zk-muted transition-colors hover:border-zk-accent/40 hover:text-zk-accent disabled:opacity-40"
          >
            {restarting ? (
              <span className="block h-4 w-4 animate-pulse rounded-full bg-zk-dim" />
            ) : (
              <IconRestart className="h-4 w-4" />
            )}
          </button>
        )}
        {!restartOnly && (
          <Button
            size="sm"
            variant={hasUpdate ? "primary" : "ghost"}
            disabled={!hasUpdate || updating}
            onClick={onUpdate}
          >
            {updating ? t("app.loading") : hasUpdate ? t("settings.update") : t("settings.upToDate")}
          </Button>
        )}
      </div>
    </div>
  );
}
