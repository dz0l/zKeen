/** String helpers for Mihomo config.yaml: proxy-groups and rules. */

export interface ProxyGroupConfig {
  name: string;
  type: string;
  icon?: string;
  use?: string[];
  proxies?: string[];
  url?: string;
  interval?: number;
  hidden?: boolean;
  /** Raw YAML body lines under the group (excluding `- name:`), for round-trip of unknown fields. */
  rawBody?: string;
}

export const RULE_TYPES = [
  "DOMAIN-SUFFIX",
  "DOMAIN",
  "DOMAIN-KEYWORD",
  "GEOSITE",
  "GEOIP",
  "IP-CIDR",
  "IP-CIDR6",
  "SRC-IP",
  "SRC-PORT",
  "DST-PORT",
  "PROCESS-NAME",
  "PROCESS-PATH",
  "RULE-SET",
  "MATCH",
] as const;

export type RuleType = (typeof RULE_TYPES)[number];

export interface ParsedRule {
  raw: string;
  type: string;
  payload: string;
  target: string;
  extra: string;
}

const HIDDEN_GROUP_NAMES = new Set(["GLOBAL", "COMPATIBLE"]);

function findSectionRange(yaml: string, key: string): { start: number; end: number } | null {
  const re = new RegExp(`^${key}:\\s*(?:#.*)?$`, "m");
  const m = yaml.match(re);
  if (!m || m.index === undefined) return null;
  const start = m.index;
  const after = yaml.slice(start + m[0].length);
  const next = after.search(/^[a-zA-Z0-9_-]+:/m);
  const end = next === -1 ? yaml.length : start + m[0].length + next;
  return { start, end };
}

function extractListItems(sectionBody: string): string[] {
  const items: string[] = [];
  const lines = sectionBody.split("\n");
  let current = "";
  for (const line of lines) {
    if (/^  - /.test(line) || /^  -$/.test(line)) {
      if (current) items.push(current);
      current = line + "\n";
    } else if (current && (/^    /.test(line) || line.trim() === "")) {
      current += line + "\n";
    } else if (current && !line.startsWith(" ")) {
      break;
    }
  }
  if (current) items.push(current);
  return items;
}

function parseScalarList(body: string, field: string): string[] | undefined {
  const inline = body.match(new RegExp(`^    ${field}:\\s*\\[(.*)\\]\\s*$`, "m"));
  if (inline) {
    return inline[1]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  const block = body.match(new RegExp(`^    ${field}:\\s*\\n((?:      - .+\\n?)+)`, "m"));
  if (block) {
    return block[1]
      .split("\n")
      .map((l) => l.match(/^\s+- ['"]?(.+?)['"]?\s*$/)?.[1]?.trim())
      .filter((x): x is string => Boolean(x));
  }
  return undefined;
}

function parseGroupItem(item: string): ProxyGroupConfig | null {
  const name =
    item.match(/^  - name:\s*['"]?([^'"\n#]+)/)?.[1]?.trim() ??
    item.match(/^  -\s*\n\s+name:\s*['"]?([^'"\n#]+)/)?.[1]?.trim();
  if (!name) return null;

  const type = item.match(/^\s+type:\s*['"]?([^'"\n#]+)/m)?.[1]?.trim() || "select";
  const icon = item.match(/^\s+icon:\s*['"]?([^'"\n#]+)/m)?.[1]?.trim();
  const url = item.match(/^\s+url:\s*['"]?([^'"\n#]+)/m)?.[1]?.trim();
  const intervalRaw = item.match(/^\s+interval:\s*(\d+)/m)?.[1];
  const hidden = /^\s+hidden:\s*true\b/m.test(item);

  return {
    name,
    type,
    icon,
    url,
    interval: intervalRaw ? Number(intervalRaw) : undefined,
    hidden,
    use: parseScalarList(item, "use"),
    proxies: parseScalarList(item, "proxies"),
    rawBody: item,
  };
}

export function parseProxyGroups(yaml: string): ProxyGroupConfig[] {
  const range = findSectionRange(yaml, "proxy-groups");
  if (!range) return [];
  const body = yaml.slice(range.start, range.end);
  return extractListItems(body)
    .map(parseGroupItem)
    .filter((g): g is ProxyGroupConfig => Boolean(g));
}

export function listUserProxyGroups(yaml: string): ProxyGroupConfig[] {
  return parseProxyGroups(yaml).filter((g) => !HIDDEN_GROUP_NAMES.has(g.name) && !g.hidden);
}

export function parseRules(yaml: string): ParsedRule[] {
  const range = findSectionRange(yaml, "rules");
  if (!range) return [];
  const body = yaml.slice(range.start, range.end);
  const rules: ParsedRule[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s+- (.+)$/);
    if (!m) continue;
    const raw = m[1].trim();
    // Skip complex OR/AND for parser simplicity — keep as opaque with empty target
    if (raw.startsWith("OR,") || raw.startsWith("AND,") || raw.startsWith("NOT,")) {
      rules.push({ raw, type: "COMPLEX", payload: raw, target: "", extra: "" });
      continue;
    }
    const parts = raw.split(",");
    const type = parts[0]?.trim() || "";
    if (type === "MATCH") {
      rules.push({
        raw,
        type,
        payload: "",
        target: parts[1]?.trim() || "",
        extra: parts.slice(2).join(","),
      });
      continue;
    }
    // Last segment that isn't no-resolve is target
    let targetIdx = parts.length - 1;
    if (parts[targetIdx]?.trim() === "no-resolve") targetIdx -= 1;
    const tgt = parts[targetIdx]?.trim() || "";
    const payload = parts.slice(1, targetIdx).join(",");
    const extra = parts.slice(targetIdx + 1).join(",");
    rules.push({ raw, type, payload, target: tgt, extra });
  }
  return rules;
}

export function rulesForGroup(yaml: string, groupName: string): ParsedRule[] {
  return parseRules(yaml).filter((r) => r.target === groupName && r.type !== "COMPLEX");
}

function formatList(field: string, values: string[]): string {
  if (!values.length) return "";
  return `    ${field}:\n${values.map((v) => `      - ${needsQuote(v) ? `'${v}'` : v}`).join("\n")}\n`;
}

function needsQuote(v: string): boolean {
  return /[:#{}[\],&*?|>!%@`]/.test(v) || /\s/.test(v) || /[^\x20-\x7E]/.test(v);
}

function formatGroupYaml(g: ProxyGroupConfig): string {
  const name = needsQuote(g.name) ? `'${g.name}'` : g.name;
  let out = `  - name: ${name}\n    type: ${g.type}\n`;
  if (g.hidden) out += `    hidden: true\n`;
  if (g.use?.length) out += formatList("use", g.use);
  if (g.proxies?.length) out += formatList("proxies", g.proxies);
  if (g.url) out += `    url: ${needsQuote(g.url) ? `"${g.url}"` : g.url}\n`;
  if (g.interval != null) out += `    interval: ${g.interval}\n`;
  if (g.icon) out += `    icon: "${g.icon}"\n`;
  return out;
}

function replaceSection(yaml: string, key: string, newBody: string): string {
  const range = findSectionRange(yaml, key);
  const block = `${key}:\n${newBody}`;
  if (!range) {
    // insert before rules if present, else append
    const rules = findSectionRange(yaml, "rules");
    if (rules) {
      return yaml.slice(0, rules.start) + block + "\n" + yaml.slice(rules.start);
    }
    return `${yaml.trimEnd()}\n\n${block}\n`;
  }
  const before = yaml.slice(0, range.start);
  const after = yaml.slice(range.end);
  return before + block + (after.startsWith("\n") ? "" : "\n") + after;
}

export function upsertProxyGroup(yaml: string, group: ProxyGroupConfig): string {
  const groups = parseProxyGroups(yaml);
  const idx = groups.findIndex((g) => g.name === group.name);
  if (idx >= 0) {
    groups[idx] = { ...groups[idx], ...group, name: group.name };
  } else {
    // Insert before GLOBAL if present
    const globalIdx = groups.findIndex((g) => g.name === "GLOBAL");
    if (globalIdx >= 0) groups.splice(globalIdx, 0, group);
    else groups.push(group);
  }

  // Also ensure GLOBAL lists the group
  const global = groups.find((g) => g.name === "GLOBAL");
  if (global && group.name !== "GLOBAL") {
    const proxies = [...(global.proxies ?? [])];
    if (!proxies.includes(group.name) && !proxies.includes(`'${group.name}'`)) {
      const directIdx = proxies.findIndex((p) => p === "DIRECT");
      if (directIdx >= 0) proxies.splice(directIdx, 0, group.name);
      else proxies.push(group.name);
      global.proxies = proxies;
    }
  }

  const body = groups.map(formatGroupYaml).join("\n");
  return replaceSection(yaml, "proxy-groups", body.endsWith("\n") ? body : body + "\n");
}

export function deleteProxyGroup(yaml: string, name: string): string {
  let next = yaml;
  const groups = parseProxyGroups(next).filter((g) => g.name !== name);
  const global = groups.find((g) => g.name === "GLOBAL");
  if (global?.proxies) {
    global.proxies = global.proxies.filter((p) => p !== name && p !== `'${name}'`);
  }
  const body = groups.map(formatGroupYaml).join("\n");
  next = replaceSection(next, "proxy-groups", body.endsWith("\n") ? body : body + "\n");
  next = setGroupRules(next, name, []);
  return next;
}

function ruleLineTarget(line: string): string | null {
  const raw = line.replace(/^\s+- /, "").trim();
  if (raw.startsWith("OR,") || raw.startsWith("AND,") || raw.startsWith("NOT,")) return null;
  const parts = raw.split(",");
  if (parts[0] === "MATCH") return parts[1]?.trim() || null;
  let i = parts.length - 1;
  if (parts[i]?.trim() === "no-resolve") i -= 1;
  return parts[i]?.trim() || null;
}

/** Replace all simple rules targeting groupName with given rule lines (full rule text without `- `). */
export function setGroupRules(yaml: string, groupName: string, rulePayloads: string[]): string {
  const range = findSectionRange(yaml, "rules");
  const existingLines = range
    ? yaml
        .slice(range.start, range.end)
        .split("\n")
        .filter((l) => /^\s+- /.test(l))
    : [];

  const kept: string[] = [];
  let insertAt = -1;
  for (const line of existingLines) {
    const tgt = ruleLineTarget(line);
    if (tgt === groupName) {
      if (insertAt < 0) insertAt = kept.length;
      continue;
    }
    kept.push(line);
  }

  const newLines = rulePayloads.map((r) => `  - ${r}`);
  if (insertAt < 0) {
    let idx = kept.findIndex((l) => l.replace(/^\s+- /, "").startsWith("MATCH,"));
    if (idx < 0) idx = kept.length;
    kept.splice(idx, 0, ...newLines);
  } else {
    kept.splice(insertAt, 0, ...newLines);
  }

  const content = kept.join("\n") + (kept.length ? "\n" : "");
  return replaceSection(yaml, "rules", content);
}

export function buildRuleLine(type: string, value: string, groupName: string): string {
  if (type === "MATCH") return `MATCH,${groupName}`;
  return `${type},${value},${groupName}`;
}

export interface IpPolicy {
  id: string;
  ip: string;
  target: string;
  raw: string;
}

export function parseIpPolicies(yaml: string): IpPolicy[] {
  const out: IpPolicy[] = [];
  for (const rule of parseRules(yaml)) {
    if (rule.type === "SRC-IP") {
      out.push({
        id: `src:${rule.payload}:${rule.target}`,
        ip: rule.payload,
        target: rule.target,
        raw: rule.raw,
      });
    } else if (rule.type === "IP-CIDR" && /\/32$/.test(rule.payload)) {
      out.push({
        id: `cidr:${rule.payload}:${rule.target}`,
        ip: rule.payload.replace(/\/32$/, ""),
        target: rule.target,
        raw: rule.raw,
      });
    }
  }
  return out;
}

/** Insert SRC-IP policy at the top of rules. */
export function addIpPolicy(yaml: string, ip: string, target: string): string {
  const line = `  - SRC-IP,${ip},${target}`;
  const range = findSectionRange(yaml, "rules");
  if (!range) {
    return replaceSection(yaml, "rules", `${line}\n`);
  }
  const existing = yaml
    .slice(range.start, range.end)
    .split("\n")
    .filter((l) => /^\s+- /.test(l));
  // Avoid duplicates
  const raw = `SRC-IP,${ip},${target}`;
  const filtered = existing.filter((l) => l.replace(/^\s+- /, "").trim() !== raw);
  const content = [line, ...filtered].join("\n") + "\n";
  return replaceSection(yaml, "rules", content);
}

export function removeIpPolicy(yaml: string, rawRule: string): string {
  const range = findSectionRange(yaml, "rules");
  if (!range) return yaml;
  const lines = yaml
    .slice(range.start, range.end)
    .split("\n")
    .filter((l) => {
      if (!/^\s+- /.test(l)) return true;
      return l.replace(/^\s+- /, "").trim() !== rawRule.trim();
    });
  const content =
    lines
      .filter((l) => /^\s+- /.test(l))
      .join("\n") + "\n";
  return replaceSection(yaml, "rules", content);
}

export function defaultNewGroup(name: string): ProxyGroupConfig {
  return {
    name,
    type: "select",
    use: ["subscription"],
    proxies: ["DIRECT"],
  };
}
