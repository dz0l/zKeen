import { useState, useRef } from "react";
import { Badge, Button, Card, CardHeader } from "../components/ui";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { useMihomoConfig } from "../lib/useMihomoConfig";
import { useApiError } from "../lib/errors";

export function ConfigPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { mode } = useApp();
  const t = useT();
  const apiErr = useApiError();
  const cfg = useMihomoConfig();
  const [validated, setValidated] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);

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
      setActionError(apiErr(err, "config.validateError"));
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
      setActionError(apiErr(err, "config.saveError"));
      if (validate) setValidated(false);
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

      {!embedded && (
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("config.title")}</h1>
            <p className="mt-1 text-sm text-zk-muted">
              {cfg.configPath || t("config.subtitle")}
            </p>
          </div>
          <ImportExportButtons yaml={cfg.yaml} setYaml={cfg.setYaml} />
        </div>
      )}

      {embedded && (
        <div className="flex justify-end">
          <ImportExportButtons yaml={cfg.yaml} setYaml={cfg.setYaml} />
        </div>
      )}

      <EditorTab
        yaml={cfg.yaml}
        setYaml={cfg.setYaml}
        validated={validated}
        setValidated={setValidated}
        mode={mode}
        saving={saving}
        onValidate={handleValidate}
        onSave={() => handleSave(false)}
      />
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
