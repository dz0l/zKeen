import { useState, useRef, useEffect } from "react";
import { Badge, Button, Card, CardHeader, Input, Select } from "../components/ui";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { useMihomoConfig } from "../lib/useMihomoConfig";
import { useSession } from "../lib/session";
import { ApiError } from "../lib/api";
import { DEFAULT_PROVIDER, refreshProxyProvider } from "../lib/config";

type ConfigTab = "editor" | "quick";

export function ConfigPage() {
  const { mode } = useApp();
  const t = useT();
  const cfg = useMihomoConfig();
  const [tab, setTab] = useState<ConfigTab>(mode === "safe" ? "quick" : "editor");
  const [validated, setValidated] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode === "safe" && tab === "editor") {
      setTab("quick");
    }
  }, [mode, tab]);

  if (cfg.loading) {
    return (
      <div className="page-enter py-12 text-center text-sm text-zk-muted">
        {t("app.loading")}
      </div>
    );
  }

  if (!cfg.yaml && cfg.error) {
    return (
      <div className="page-enter space-y-3">
        <p className="text-sm text-zk-coral">{cfg.error}</p>
        <Button size="sm" variant="secondary" onClick={cfg.load}>
          ⟳ {t("config.reload")}
        </Button>
      </div>
    );
  }

  async function handleValidate() {
    setSaving(true);
    setActionError("");
    try {
      await cfg.save(true);
      setValidated(true);
    } catch (err) {
      setValidated(false);
      setActionError(err instanceof ApiError ? err.message : t("config.validateError"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(validate: boolean) {
    setSaving(true);
    setActionError("");
    try {
      await cfg.save(validate);
      setValidated(validate ? true : null);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("config.saveError"));
      if (validate) setValidated(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-enter space-y-4">
      {actionError && (
        <div className="rounded-xl border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
          {actionError}
        </div>
      )}

      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("config.title")}</h1>
          <p className="mt-1 text-sm text-zk-muted">
            {cfg.configPath || t("config.subtitle")}
          </p>
        </div>
        <ImportExportButtons yaml={cfg.yaml} setYaml={cfg.setYaml} />
      </div>

      {mode !== "safe" && (
        <div className="flex rounded-xl bg-zk-bg-elevated p-1 border border-zk-border-soft">
          <button
            type="button"
            onClick={() => setTab("editor")}
            className={`flex-1 rounded-lg px-4 py-2 text-xs font-semibold transition-all ${
              tab === "editor"
                ? "bg-zk-surface text-zk-text shadow-sm"
                : "text-zk-muted hover:text-zk-text"
            }`}
          >
            {t("config.tabEditor")}
          </button>
          <button
            type="button"
            onClick={() => setTab("quick")}
            className={`flex-1 rounded-lg px-4 py-2 text-xs font-semibold transition-all ${
              tab === "quick"
                ? "bg-zk-surface text-zk-text shadow-sm"
                : "text-zk-muted hover:text-zk-text"
            }`}
          >
            {t("config.tabQuick")}
          </button>
        </div>
      )}

      {mode === "safe" && (
        <div className="rounded-xl border border-zk-safe/30 bg-zk-safe/8 px-4 py-3 text-xs text-zk-safe">
          <strong>Safe mode:</strong> {t("config.safeBanner")}
        </div>
      )}

      {(mode !== "safe" ? tab === "editor" : false) && (
        <EditorTab
          yaml={cfg.yaml}
          setYaml={cfg.setYaml}
          validated={validated}
          setValidated={setValidated}
          mode={mode}
          saving={saving}
          onValidate={handleValidate}
          onSave={() => handleSave(mode === "safe")}
        />
      )}
      {(mode === "safe" || tab === "quick") && (
        <QuickSettingsTab
          subscriptionUrl={cfg.subscriptionUrl}
          subscriptionHwid={cfg.subscriptionHwid}
          onSubscriptionChange={cfg.updateSubscriptionUrl}
          onSubscriptionHwidChange={cfg.updateSubscriptionHwid}
          onSaveSubscription={() => handleSave(true)}
          dirty={cfg.dirty}
          saving={saving}
        />
      )}
    </div>
  );
}

function ImportExportButtons({ yaml, setYaml }: { yaml: string; setYaml: (v: string) => void }) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const blob = new Blob([yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "config.yaml";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === "string") setYaml(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div className="flex gap-1.5">
      <Button size="sm" variant="ghost" onClick={handleExport}>
        {t("config.export")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
        {t("config.import")}
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept=".yaml,.yml,.txt"
        className="hidden"
        onChange={handleImport}
      />
    </div>
  );
}

function EditorTab({
  yaml,
  setYaml,
  validated,
  setValidated,
  mode,
  saving,
  onValidate,
  onSave,
}: {
  yaml: string;
  setYaml: (v: string) => void;
  validated: boolean | null;
  setValidated: (v: boolean | null) => void;
  mode: string;
  saving: boolean;
  onValidate: () => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="config.yaml"
        subtitle="/opt/etc/mihomo/config.yaml"
        action={
          <div className="flex gap-2">
            {validated === true && <Badge variant="success">{t("config.valid")}</Badge>}
            {validated === false && <Badge variant="warn">{t("config.error")}</Badge>}
          </div>
        }
      />
      <textarea
        value={yaml}
        onChange={(e) => {
          setYaml(e.target.value);
          setValidated(null);
        }}
        spellCheck={false}
        className="scrollbar-thin min-h-[320px] w-full resize-y border-0 bg-zk-bg/50 px-4 py-3 font-mono text-[13px] leading-relaxed text-zk-text outline-none sm:min-h-[420px] sm:px-5"
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-zk-border-soft px-4 py-3 sm:px-5">
        <Button size="sm" variant="secondary" disabled={saving} onClick={onValidate}>
          {saving ? t("app.loading") : t("config.validate")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={saving || (mode === "safe" && validated !== true)}
          onClick={onSave}
        >
          {saving ? t("app.loading") : t("config.save")}
        </Button>
        {mode === "safe" && validated !== true && (
          <span className="text-[10px] text-zk-muted">{t("config.validateFirst")}</span>
        )}
      </div>
    </Card>
  );
}

function QuickSettingsTab({
  subscriptionUrl,
  subscriptionHwid,
  onSubscriptionChange,
  onSubscriptionHwidChange,
  onSaveSubscription,
  dirty,
  saving,
}: {
  subscriptionUrl: string;
  subscriptionHwid: string;
  onSubscriptionChange: (url: string) => void;
  onSubscriptionHwidChange: (hwid: string) => void;
  onSaveSubscription: () => Promise<void>;
  dirty: boolean;
  saving: boolean;
}) {
  const t = useT();
  const { clash } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState("");

  const handleRefreshProviders = async () => {
    setRefreshing(true);
    setLocalError("");
    try {
      await refreshProxyProvider(DEFAULT_PROVIDER, clash);
    } catch (err) {
      setLocalError(err instanceof ApiError ? err.message : t("config.refreshError"));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-3">
      {localError && (
        <div className="rounded-xl border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
          {localError}
        </div>
      )}

      <Card>
        <CardHeader
          title={t("config.qProviders")}
          subtitle={t("config.qProvidersSub")}
          action={
            <button
              type="button"
              onClick={handleRefreshProviders}
              disabled={refreshing}
              title={t("config.qProvidersRefresh")}
              aria-label={t("config.qProvidersRefresh")}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-zk-border-soft bg-zk-bg-elevated text-zk-muted transition-colors hover:border-zk-accent/40 hover:text-zk-accent disabled:opacity-50"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              >
                <path
                  fillRule="evenodd"
                  d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          }
        />
        <div className="space-y-3 p-4 sm:p-5">
          <Input
            label={t("config.qSubUrl")}
            placeholder="https://..."
            mono
            value={subscriptionUrl}
            onChange={onSubscriptionChange}
          />
          <Input
            label={t("config.qHwid")}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            mono
            value={subscriptionHwid}
            onChange={onSubscriptionHwidChange}
            hint={t("config.qHwidHint")}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={saving || !dirty}
              onClick={onSaveSubscription}
            >
              {saving ? t("app.loading") : t("config.qApply")}
            </Button>
          </div>
        </div>
      </Card>

      <p className="text-center text-[11px] text-zk-dim">{t("config.quickMockNote")}</p>

      {/* Other quick sections — UI preview, edit in YAML editor (Expert) */}
      <Card>
        <CardHeader title={t("config.qCore")} subtitle={t("config.qCoreSub")} />
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 opacity-60 pointer-events-none">
          <Select
            label={t("config.qMode")}
            options={[
              { value: "rule", label: "rule" },
              { value: "global", label: "global" },
              { value: "direct", label: "direct" },
            ]}
            value="rule"
          />
          <Select
            label={t("config.qLogLevel")}
            options={[
              { value: "silent", label: "silent" },
              { value: "info", label: "info" },
            ]}
            value="silent"
          />
        </div>
      </Card>
    </div>
  );
}
