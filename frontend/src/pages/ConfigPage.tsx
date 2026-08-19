import { useState, useRef } from "react";
import { Badge, Button, Card, CardHeader, Input, MockBanner, Select } from "../components/ui";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";

type ConfigTab = "editor" | "quick";

const MOCK_YAML = `redir-port: 1182
tproxy-port: 1181
mixed-port: 1080

tcp-concurrent: true
allow-lan: true
mode: rule
geo-auto-update: true
geo-update-interval: 168
log-level: silent
ipv6: false
external-controller: 0.0.0.0:9090
geodata-mode: true

profile:
  store-selected: true
  tracing: true
find-process-mode: "off"

sniffer:
  enable: true
  force-dns-mapping: true
  sniff:
    HTTP:
      ports: [80]
      override-destination: true
    TLS:
      ports: [443]
    QUIC:
      ports: [443]

dns:
  enable: true
  listen: 0.0.0.0:7874
  ipv6: false
  cache-algorithm: arc
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  ...

proxy-providers:
  subscription:
    type: http
    url: "https://..."
    ...

proxies: []

proxy-groups:
  ...

rules:
  ...
`;

export function ConfigPage() {
  const { mode } = useApp();
  const t = useT();
  const [tab, setTab] = useState<ConfigTab>("editor");
  const [yaml, setYaml] = useState(MOCK_YAML);
  const [validated, setValidated] = useState<boolean | null>(null);

  return (
    <div className="page-enter space-y-4">
      <MockBanner />

      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("config.title")}</h1>
          <p className="mt-1 text-sm text-zk-muted">{t("config.subtitle")}</p>
        </div>
        <ImportExportButtons yaml={yaml} setYaml={setYaml} />
      </div>

      {/* Tab switcher */}
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

      {mode === "safe" && (
        <div className="rounded-xl border border-zk-safe/30 bg-zk-safe/8 px-4 py-3 text-xs text-zk-safe">
          <strong>Safe mode:</strong> {t("config.safeBanner")}
        </div>
      )}

      {tab === "editor" && <EditorTab yaml={yaml} setYaml={setYaml} validated={validated} setValidated={setValidated} mode={mode} />}
      {tab === "quick" && <QuickSettingsTab />}
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
  yaml, setYaml, validated, setValidated, mode,
}: {
  yaml: string;
  setYaml: (v: string) => void;
  validated: boolean | null;
  setValidated: (v: boolean | null) => void;
  mode: string;
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
        onChange={(e) => { setYaml(e.target.value); setValidated(null); }}
        spellCheck={false}
        className="scrollbar-thin min-h-[320px] w-full resize-y border-0 bg-zk-bg/50 px-4 py-3 font-mono text-[13px] leading-relaxed text-zk-text outline-none sm:min-h-[420px] sm:px-5"
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-zk-border-soft px-4 py-3 sm:px-5">
        <Button size="sm" variant="secondary" onClick={() => setValidated(true)}>
          {t("config.validate")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={mode === "safe" && validated !== true}
          onClick={() => { if (mode === "safe" && validated !== true) { setValidated(false); } }}
        >
          {t("config.save")}
        </Button>
        <Button size="sm" variant="ghost">{t("config.format")}</Button>
        {mode === "safe" && validated !== true && (
          <span className="text-[10px] text-zk-muted">{t("config.validateFirst")}</span>
        )}
      </div>
    </Card>
  );
}

function QuickSettingsTab() {
  const t = useT();

  return (
    <div className="space-y-3">
      {/* Core settings */}
      <Card>
        <CardHeader title={t("config.qCore")} subtitle={t("config.qCoreSub")} />
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
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
              { value: "error", label: "error" },
              { value: "warning", label: "warning" },
              { value: "info", label: "info" },
              { value: "debug", label: "debug" },
            ]}
            value="silent"
          />
          <Input label="mixed-port" placeholder="1080" value="1080" mono />
          <Input label="redir-port" placeholder="1182" value="1182" mono />
          <Input label="tproxy-port" placeholder="1181" value="1181" mono />
          <Select
            label="ipv6"
            options={[
              { value: "false", label: "false" },
              { value: "true", label: "true" },
            ]}
            value="false"
          />
          <Select
            label="allow-lan"
            options={[
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
            value="true"
          />
          <Select
            label="tcp-concurrent"
            options={[
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
            value="true"
          />
        </div>
      </Card>

      {/* External Controller */}
      <Card>
        <CardHeader title={t("config.qExtUI")} subtitle={t("config.qExtUISub")} />
        <div className="space-y-3 p-4 sm:p-5">
          <Input label="external-controller" placeholder="0.0.0.0:9090" value="0.0.0.0:9090" mono />
          <Input label="secret" placeholder="••••••••" />
        </div>
      </Card>

      {/* Sniffer */}
      <Card>
        <CardHeader title={t("config.qSniffer")} subtitle={t("config.qSnifferSub")} />
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <Select
            label="sniffer.enable"
            options={[
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
            value="true"
          />
          <Select
            label="force-dns-mapping"
            options={[
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
            value="true"
          />
        </div>
      </Card>

      {/* Proxy providers */}
      <Card>
        <CardHeader title={t("config.qProviders")} subtitle={t("config.qProvidersSub")} />
        <div className="space-y-3 p-4 sm:p-5">
          <Input label={t("config.qSubUrl")} placeholder="https://..." mono />
          <Input label="User-Agent" placeholder="Mihomo" value="Mihomo" />
          <Input
            label="x-hwid"
            placeholder="b3f1c2a0-7e44-4c19-..."
            mono
            hint={t("config.qHwidHint")}
          />
          <Input label={t("config.qHealthUrl")} placeholder="http://www.msftncsi.com/ncsi.txt" value="http://www.msftncsi.com/ncsi.txt" mono />
          <Input label={t("config.qHealthInterval")} placeholder="3000" value="3000" mono />
        </div>
      </Card>

      {/* DNS */}
      <Card>
        <CardHeader title={t("config.qDNS")} subtitle={t("config.qDNSSub")} />
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <Select
            label="dns.enable"
            options={[
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
            value="true"
          />
          <Select
            label="enhanced-mode"
            options={[
              { value: "fake-ip", label: "fake-ip" },
              { value: "redir-host", label: "redir-host" },
            ]}
            value="fake-ip"
          />
          <Input label="listen" placeholder="0.0.0.0:7874" value="0.0.0.0:7874" mono />
          <Input label="fake-ip-range" placeholder="198.18.0.1/16" value="198.18.0.1/16" mono />
          <Select
            label="cache-algorithm"
            options={[
              { value: "arc", label: "arc" },
              { value: "lru", label: "lru" },
            ]}
            value="arc"
          />
        </div>
      </Card>

      {/* GEO data + URLs */}
      <Card>
        <CardHeader title={t("config.qGeo")} subtitle={t("config.qGeoSub")} />
        <div className="space-y-3 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="geo-auto-update"
              options={[
                { value: "true", label: "true" },
                { value: "false", label: "false" },
              ]}
              value="true"
            />
            <Input label="geo-update-interval" placeholder="168" value="168" mono hint={t("config.qGeoHint")} />
          </div>
          <Select
            label="geodata-mode"
            options={[
              { value: "true", label: "true — dat format" },
              { value: "false", label: "false — mmdb format" },
            ]}
            value="true"
          />
          <Input
            label={t("config.qGeoSiteUrl")}
            placeholder="https://..."
            value="https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat"
            mono
            hint={t("config.qGeoSiteHint")}
          />
          <Input
            label={t("config.qGeoIpUrl")}
            placeholder="https://..."
            value="https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.dat"
            mono
            hint={t("config.qGeoIpHint")}
          />
        </div>
      </Card>

      <div className="flex gap-2">
        <Button size="md" variant="primary">{t("config.qApply")}</Button>
        <Button size="md" variant="ghost">{t("config.qReset")}</Button>
      </div>
    </div>
  );
}
