import { useState, useRef } from "react";
import { Badge, Button, Card, CardHeader } from "../components/ui";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { useMihomoConfig } from "../lib/useMihomoConfig";
import { useApiError } from "../lib/errors";
import { useSession } from "../lib/session";
import { ConfigApplyError, validateMihomoConfig } from "../lib/config";

/** Result of the last validation, bound to the exact text that was checked. */
interface CheckResult {
  text: string;
  ok: boolean;
}

export function ConfigPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { mode } = useApp();
  const t = useT();
  const apiErr = useApiError();
  const { clash, setClash } = useSession();
  const cfg = useMihomoConfig();
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Any edit or import changes the text and therefore drops the old result.
  const validated = check && check.text === cfg.yaml ? check.ok : null;

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
    const snapshot = cfg.yaml;
    setSaving(true);
    setActionError("");
    setNotice(null);
    try {
      await validateMihomoConfig(cfg.configPath, snapshot);
      setCheck({ text: snapshot, ok: true });
    } catch (err) {
      setCheck({ text: snapshot, ok: false });
      setActionError(apiErr(err, "config.validateError"));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Safe mode: the server validates this exact snapshot before the atomic write.
   * A config the core does not accept is replaced by the previous file automatically.
   */
  async function saveAndApply(snapshot: string) {
    const safe = mode === "safe";
    if (safe && !window.confirm(t("groups.confirmApply"))) return;
    setSaving(true);
    setActionError("");
    setNotice(null);
    try {
      const res = await cfg.commit(clash, snapshot, safe);
      if (safe) setCheck({ text: snapshot, ok: true });
      setClash(res.clash);
      setNotice({ ok: true, text: t("config.savedApplied") });
    } catch (err) {
      if (err instanceof ConfigApplyError) {
        setNotice({ ok: false, text: apiErr(err, "config.applyError") });
      } else {
        setActionError(apiErr(err, "config.saveError"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={embedded ? "space-y-4" : "page-enter space-y-4"}>
      {actionError && (
        <div className="rounded-xl border border-zk-coral/25 bg-zk-coral/10 px-3 py-2 text-xs text-zk-coral">
          {actionError}
        </div>
      )}

      {notice && (
        <div
          className={`flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-xs ${
            notice.ok
              ? "border-zk-accent/25 bg-zk-accent/10 text-zk-accent"
              : "border-zk-amber/30 bg-zk-amber/10 text-zk-amber"
          }`}
        >
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
        </div>
      )}

      {!embedded && (
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("config.title")}</h1>
            <p className="mt-1 text-sm text-zk-muted">
              {cfg.configPath || t("config.subtitle")}
            </p>
          </div>
          <ImportExportButtons yaml={cfg.yaml} setYaml={cfg.setYaml} disabled={saving} />
        </div>
      )}

      {embedded && (
        <div className="flex justify-end">
          <ImportExportButtons yaml={cfg.yaml} setYaml={cfg.setYaml} disabled={saving} />
        </div>
      )}

      <EditorTab
        yaml={cfg.yaml}
        setYaml={cfg.setYaml}
        validated={validated}
        mode={mode}
        saving={saving}
        onValidate={handleValidate}
        configPath={cfg.configPath}
        onSave={() => void saveAndApply(cfg.yaml)}
      />
    </div>
  );
}

function ImportExportButtons({
  yaml,
  setYaml,
  disabled,
}: {
  yaml: string;
  setYaml: (v: string) => void;
  disabled: boolean;
}) {
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
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => fileRef.current?.click()}>
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
  mode,
  saving,
  configPath,
  onValidate,
  onSave,
}: {
  yaml: string;
  setYaml: (v: string) => void;
  validated: boolean | null;
  mode: string;
  saving: boolean;
  configPath: string;
  onValidate: () => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={configPath.split("/").pop() || "config.yaml"}
        subtitle={configPath}
        action={
          <div className="flex gap-2">
            {validated === true && <Badge variant="success">{t("config.valid")}</Badge>}
            {validated === false && <Badge variant="warn">{t("config.error")}</Badge>}
          </div>
        }
      />
      <textarea
        value={yaml}
        readOnly={saving}
        onChange={(e) => setYaml(e.target.value)}
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
