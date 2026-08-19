import { useState } from "react";
import { Badge, Button, Card, CardHeader, Input, MockBanner, Select } from "../components/ui";
import { useT } from "../lib/i18n";

type PolicyType = "group" | "rule";

interface Policy {
  id: string;
  ip: string;
  type: PolicyType;
  target: string;
  note?: string;
}

const MOCK_POLICIES: Policy[] = [
  { id: "1", ip: "192.168.1.50", type: "group", target: "PROXY", note: "Smart TV" },
  { id: "2", ip: "192.168.1.105", type: "rule", target: "GEOIP,RU,DIRECT", note: "PC" },
];

export function PoliciesPage() {
  const t = useT();
  const [policies] = useState(MOCK_POLICIES);
  const [ip, setIp] = useState("");
  const [type, setType] = useState<PolicyType>("group");
  const [target, setTarget] = useState("PROXY");

  return (
    <div className="page-enter space-y-4">
      <MockBanner />

      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t("policies.title")}</h1>
        <p className="mt-1 text-sm text-zk-muted">{t("policies.subtitle")}</p>
      </div>

      <Card>
        <CardHeader title={t("policies.newPolicy")} subtitle={t("policies.newPolicySub")} />
        <div className="space-y-4 p-4 sm:p-5">
          <Input
            label={t("policies.ip")}
            placeholder={t("policies.ipPlaceholder")}
            value={ip}
            onChange={setIp}
            mono
            hint={t("policies.ipHint")}
          />
          <Select
            label={t("policies.policyType")}
            value={type}
            onChange={(v) => setType(v as PolicyType)}
            options={[
              { value: "group", label: t("policies.typeGroup") },
              { value: "rule", label: t("policies.typeRule") },
            ]}
          />
          {type === "group" ? (
            <Select
              label={t("policies.proxyGroup")}
              value={target}
              onChange={setTarget}
              options={[
                { value: "PROXY", label: "PROXY" },
                { value: "AUTO", label: "AUTO" },
                { value: "DIRECT", label: "DIRECT" },
              ]}
            />
          ) : (
            <Input
              label={t("policies.ruleTarget")}
              placeholder="GEOIP,RU,DIRECT"
              value={target}
              onChange={setTarget}
              mono
            />
          )}
          <Button size="md" variant="primary" className="w-full sm:w-auto">
            {t("policies.add")}
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title={t("policies.activeTitle")}
          subtitle={t("policies.rules", { count: policies.length })}
        />
        <div className="divide-y divide-zk-border-soft">
          {policies.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{p.ip}</span>
                  <Badge variant="muted">{p.type === "group" ? t("policies.group") : t("policies.rule")}</Badge>
                  {p.note && <span className="text-xs text-zk-dim">{p.note}</span>}
                </div>
                <p className="mt-1 font-mono text-xs text-zk-accent">
                  IP-CIDR,{p.ip}/32,{p.target}
                </p>
              </div>
              <Button size="sm" variant="ghost">✕</Button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
