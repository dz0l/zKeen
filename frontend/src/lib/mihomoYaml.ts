/**
 * String helpers for Mihomo config.yaml: proxy-groups and rules.
 *
 * Every edit is a splice of the lines it owns: unknown group fields, comments, anchors,
 * rule order, `no-resolve` and MATCH stay byte-identical. Layouts the parser does not
 * understand (flow-style sections, mappings instead of lists) raise YamlLayoutError
 * instead of being silently rewritten.
 */

export interface ProxyGroupConfig {
  name: string;
  type: string;
  icon?: string;
  use?: string[];
  proxies?: string[];
  url?: string;
  interval?: number;
  hidden?: boolean;
  /** Raw YAML lines of the group item. */
  rawBody?: string;
}

/**
 * Group update: `undefined` keeps the field as is; `""`, `[]` or `null` removes it.
 * Fields the panel does not manage (filter, lazy, strategy, …) are never touched.
 */
export interface ProxyGroupPatch {
  name: string;
  type?: string;
  icon?: string;
  use?: string[];
  proxies?: string[];
  url?: string;
  interval?: number | null;
  hidden?: boolean;
}

export class YamlLayoutError extends Error {
  constructor(section: string) {
    super(`unsupported_yaml_layout:${section}`);
    this.name = "YamlLayoutError";
  }
}

export const RULE_TYPES = [
  "DOMAIN-SUFFIX",
  "DOMAIN",
  "DOMAIN-KEYWORD",
  "GEOSITE",
  "GEOIP",
  "IP-CIDR",
  "IP-CIDR6",
  "SRC-IP-CIDR",
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
  /** Inside the panel policy marker block. */
  inPolicyBlock?: boolean;
}

/** Rule row of the group editor; `raw` identifies a rule that already exists in the file. */
export interface GroupRuleDraft {
  type: string;
  value: string;
  raw?: string;
}

const HIDDEN_GROUP_NAMES = new Set(["GLOBAL", "COMPATIBLE"]);
const LIST_KEYS = new Set(["use", "proxies"]);
const RULE_PARAMS = new Set(["no-resolve", "src"]);

// ---------------------------------------------------------------------------
// Line primitives

function withLf(yaml: string, edit: (text: string) => string): string {
  const crlf = yaml.includes("\r\n");
  const out = edit(crlf ? yaml.replace(/\r\n/g, "\n") : yaml);
  return crlf ? out.replace(/\r?\n/g, "\r\n") : out;
}

function toLines(yaml: string): string[] {
  return yaml.replace(/\r\n/g, "\n").split("\n");
}

function splice(lines: string[], start: number, end: number, insert: string[]): string[] {
  return [...lines.slice(0, start), ...insert, ...lines.slice(end)];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop a trailing `# comment` outside quotes. */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if ((c === "'" || c === '"') && (i === 0 || /[\s,[]/.test(s[i - 1]))) quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\(.)/g, "$1");
  }
  return t;
}

function scalar(s: string): string {
  return unquote(stripComment(s));
}

function splitFlowList(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (quote === '"' && c === "\\" && i + 1 < inner.length) cur += inner[++i];
      else if (c === quote) {
        if (quote === "'" && inner[i + 1] === "'") cur += inner[++i];
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    if (c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(unquote).filter(Boolean);
}

function needsQuote(v: string): boolean {
  return /[:#{}[\],&*?|>!%@`]/.test(v) || /\s/.test(v) || /[^\x20-\x7E]/.test(v);
}

function formatScalar(v: string): string {
  const risky =
    v === "" ||
    needsQuote(v) ||
    /^[-'"]/.test(v) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(v) ||
    /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(v) ||
    /^0x[0-9a-f]+$/i.test(v);
  return risky ? `'${v.replace(/'/g, "''")}'` : v;
}

function doubleQuoted(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Insert lines before the final empty line of a file that ends with a newline. */
function appendLines(lines: string[], add: string[]): string[] {
  const at = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return splice(lines, at, at, add);
}

// ---------------------------------------------------------------------------
// Top-level sections and block sequences

interface Section {
  header: number;
  start: number;
  /** Exclusive; trailing blank lines and column-0 comments belong to the next key. */
  end: number;
  inline: string;
}

function findSection(lines: string[], key: string): Section | null {
  const re = new RegExp(`^${escapeRe(key)}:(?:\\s+(.*))?$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (/^(---|\.\.\.)(\s|$)/.test(l)) break;
      if (l !== "" && /^[^\s#-]/.test(l)) break;
      end++;
    }
    while (end > i + 1 && (isBlank(lines[end - 1]) || lines[end - 1].startsWith("#"))) end--;
    return { header: i, start: i + 1, end, inline: stripComment(m[1] ?? "").trim() };
  }
  return null;
}

interface SeqItem {
  start: number;
  end: number;
  /** Exclusive; trailing blanks and outer-level comments (they describe the next item) excluded. */
  contentEnd: number;
}

interface SeqView {
  sec: Section;
  ind: number;
  items: SeqItem[];
}

/** Block sequence under a top-level key; `null` when the key is absent. */
function viewSeq(lines: string[], key: string, strict: boolean): SeqView | null {
  const sec = findSection(lines, key);
  if (!sec) return null;
  if (sec.inline && sec.inline !== "[]") {
    if (strict) throw new YamlLayoutError(key);
    return null;
  }
  let ind: number | null = null;
  for (let i = sec.start; i < sec.end; i++) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    const m = l.match(/^( *)-(\s|$)/);
    if (!m) {
      if (strict) throw new YamlLayoutError(key);
      return null;
    }
    ind = m[1].length;
    break;
  }
  if (ind === null) return { sec, ind: 2, items: [] };

  const itemRe = new RegExp(`^ {${ind}}-(\\s|$)`);
  const starts: number[] = [];
  for (let i = sec.start; i < sec.end; i++) if (itemRe.test(lines[i])) starts.push(i);
  const items = starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : sec.end;
    let contentEnd = end;
    while (
      contentEnd > start + 1 &&
      (isBlank(lines[contentEnd - 1]) ||
        (isComment(lines[contentEnd - 1]) && indentOf(lines[contentEnd - 1]) <= ind!))
    ) {
      contentEnd--;
    }
    return { start, end, contentEnd };
  });
  return { sec, ind, items };
}

/** Make sure `key:` exists as a block section; returns the (possibly) updated lines. */
function ensureSeqSection(lines: string[], key: string): string[] {
  const sec = findSection(lines, key);
  if (sec) {
    if (sec.inline === "[]") return splice(lines, sec.header, sec.header + 1, [`${key}:`]);
    if (sec.inline) throw new YamlLayoutError(key);
    return lines;
  }
  if (key === "proxy-groups") {
    const rules = findSection(lines, "rules");
    if (rules) return splice(lines, rules.header, rules.header, [`${key}:`, ""]);
  }
  const last = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 2 : lines.length - 1;
  return appendLines(lines, last >= 0 && !isBlank(lines[last]) ? ["", `${key}:`] : [`${key}:`]);
}

// ---------------------------------------------------------------------------
// Proxy-group items as mappings

interface Field {
  key: string;
  start: number;
  end: number;
  value: string;
  dashLine: boolean;
}

interface ItemMap {
  keyIndent: number;
  /** `  - ` prefix when the first key sits on the dash line, else "". */
  dashPrefix: string;
  fields: Field[];
}

const KEY_RE = /^([A-Za-z0-9_.<-]+|'(?:[^']|'')*'|"(?:[^"\\]|\\.)*")\s*:(?:\s+(.*)|\s*)$/;

function parseItemMap(lines: string[], item: SeqItem): ItemMap | null {
  const m = lines[item.start].match(/^( *-)( *)(.*)$/);
  if (!m) return null;
  let keyIndent: number;
  let dashPrefix = "";
  if (m[3] && !m[3].startsWith("#")) {
    dashPrefix = m[1] + m[2];
    keyIndent = dashPrefix.length;
  } else {
    let j = item.start + 1;
    while (j < item.contentEnd && (isBlank(lines[j]) || isComment(lines[j]))) j++;
    if (j >= item.contentEnd) return { keyIndent: m[1].length + 1, dashPrefix: "", fields: [] };
    keyIndent = indentOf(lines[j]);
  }

  const fields: Field[] = [];
  for (let i = item.start; i < item.contentEnd; i++) {
    const line = lines[i];
    let text: string;
    const dash = i === item.start;
    if (dash) {
      if (!dashPrefix) continue;
      text = line.slice(dashPrefix.length);
    } else {
      if (isBlank(line) || isComment(line) || indentOf(line) !== keyIndent) continue;
      text = line.slice(keyIndent);
      if (text.startsWith("-")) continue;
    }
    const km = text.match(KEY_RE);
    if (!km) {
      if (dash) return null;
      continue;
    }
    fields.push({ key: unquote(km[1]), start: i, end: -1, value: km[2] ?? "", dashLine: dash });
  }
  fields.forEach((f, k) => {
    let end = k + 1 < fields.length ? fields[k + 1].start : item.contentEnd;
    while (
      end > f.start + 1 &&
      (isBlank(lines[end - 1]) || (isComment(lines[end - 1]) && indentOf(lines[end - 1]) <= keyIndent))
    ) {
      end--;
    }
    f.end = end;
  });
  return { keyIndent, dashPrefix, fields };
}

interface ListLine {
  line: number;
  indent: number;
  value: string;
}

function blockListLines(lines: string[], f: Field): ListLine[] {
  const out: ListLine[] = [];
  let dashInd = -1;
  for (let i = f.start + 1; i < f.end; i++) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    const m = l.match(/^( *)-\s+(.*)$/);
    if (!m) continue;
    if (dashInd < 0) dashInd = m[1].length;
    if (m[1].length !== dashInd) continue;
    out.push({ line: i, indent: dashInd, value: scalar(m[2]) });
  }
  return out;
}

function isFlowField(f: Field): boolean {
  return stripComment(f.value).trim().startsWith("[");
}

function fieldList(lines: string[], f: Field): string[] {
  const inline = stripComment(f.value).trim();
  if (inline.startsWith("[")) return splitFlowList(inline.slice(1, inline.lastIndexOf("]")));
  if (inline) return [unquote(inline)];
  return blockListLines(lines, f).map((x) => x.value);
}

type FieldValue = string | number | boolean | string[];

function sameValue(next: FieldValue, cur: string | string[]): boolean {
  if (Array.isArray(next)) {
    return Array.isArray(cur) && cur.length === next.length && cur.every((v, i) => v === next[i]);
  }
  return !Array.isArray(cur) && String(next) === cur;
}

function renderField(key: string, value: FieldValue, keyIndent: number, listIndent: number): string[] {
  const pad = " ".repeat(keyIndent);
  if (Array.isArray(value)) {
    const itemPad = " ".repeat(keyIndent + listIndent);
    return [`${pad}${key}:`, ...value.map((v) => `${itemPad}- ${formatScalar(v)}`)];
  }
  if (typeof value !== "string") return [`${pad}${key}: ${value}`];
  if (key === "icon" || key === "url") return [`${pad}${key}: ${doubleQuoted(value)}`];
  return [`${pad}${key}: ${formatScalar(value)}`];
}

interface GroupsView extends SeqView {
  lines: string[];
  maps: (ItemMap | null)[];
  names: (string | null)[];
}

function viewGroups(lines: string[], strict: boolean): GroupsView | null {
  const seq = viewSeq(lines, "proxy-groups", strict);
  if (!seq) return null;
  const maps = seq.items.map((it) => parseItemMap(lines, it));
  const names = maps.map((m) => {
    const f = m?.fields.find((x) => x.key === "name");
    return f ? scalar(f.value) : null;
  });
  return { ...seq, lines, maps, names };
}

function detectListIndent(v: GroupsView): number {
  for (const map of v.maps) {
    if (!map) continue;
    for (const f of map.fields) {
      const items = blockListLines(v.lines, f);
      if (items.length) return items[0].indent - map.keyIndent;
    }
  }
  return 2;
}

function groupFromItem(lines: string[], item: SeqItem, map: ItemMap): ProxyGroupConfig | null {
  const get = (key: string) => map.fields.find((f) => f.key === key);
  const nameField = get("name");
  const name = nameField ? scalar(nameField.value) : "";
  if (!name) return null;
  const str = (key: string) => {
    const f = get(key);
    const v = f ? scalar(f.value) : "";
    return v || undefined;
  };
  const list = (key: string) => {
    const f = get(key);
    return f ? fieldList(lines, f) : undefined;
  };
  const intervalRaw = str("interval");
  const interval = intervalRaw !== undefined ? Number(intervalRaw) : NaN;
  return {
    name,
    type: str("type") || "select",
    icon: str("icon"),
    url: str("url"),
    interval: Number.isFinite(interval) ? interval : undefined,
    hidden: str("hidden") === "true",
    use: list("use"),
    proxies: list("proxies"),
    rawBody: lines.slice(item.start, item.contentEnd).join("\n"),
  };
}

export function parseProxyGroups(yaml: string): ProxyGroupConfig[] {
  const lines = toLines(yaml);
  const v = viewGroups(lines, false);
  if (!v) return [];
  const out: ProxyGroupConfig[] = [];
  v.items.forEach((item, k) => {
    const map = v.maps[k];
    const g = map ? groupFromItem(lines, item, map) : null;
    if (g) out.push(g);
  });
  return out;
}

export function listUserProxyGroups(yaml: string): ProxyGroupConfig[] {
  return parseProxyGroups(yaml).filter((g) => !HIDDEN_GROUP_NAMES.has(g.name) && !g.hidden);
}

/** Group names in config.yaml order (including hidden). */
export function proxyGroupNamesInOrder(yaml: string): string[] {
  return parseProxyGroups(yaml).map((g) => g.name);
}

/** Set/replace/remove one field of a group item; returns `lines` itself when nothing changes. */
function setItemField(
  lines: string[],
  item: SeqItem,
  map: ItemMap,
  key: string,
  value: FieldValue | null,
  listIndent: number,
): string[] {
  const idx = map.fields.findIndex((f) => f.key === key);
  if (idx >= 0) {
    const f = map.fields[idx];
    if (value !== null) {
      const cur = LIST_KEYS.has(key) ? fieldList(lines, f) : scalar(f.value);
      if (sameValue(value, cur)) return lines;
      const rendered = renderField(key, value, map.keyIndent, listIndent);
      if (f.dashLine) rendered[0] = map.dashPrefix + rendered[0].slice(map.keyIndent);
      return splice(lines, f.start, f.end, rendered);
    }
    if (!f.dashLine) return splice(lines, f.start, f.end, []);
    const next = map.fields[idx + 1];
    if (!next) return lines;
    const moved = map.dashPrefix + lines[next.start].slice(map.keyIndent);
    return splice(lines, f.start, next.start + 1, [moved]);
  }
  if (value === null) return lines;
  const rendered = renderField(key, value, map.keyIndent, listIndent);
  const nameField = map.fields.find((f) => f.key === "name");
  const last = map.fields[map.fields.length - 1];
  const at = key === "type" && nameField ? nameField.end : last ? last.end : item.contentEnd;
  return splice(lines, at, at, rendered);
}

function patchEntries(g: ProxyGroupPatch): [string, FieldValue | null][] {
  const out: [string, FieldValue | null][] = [["name", g.name]];
  if (g.type !== undefined) out.push(["type", g.type || "select"]);
  if (g.hidden !== undefined) out.push(["hidden", g.hidden ? true : null]);
  if (g.use !== undefined) out.push(["use", g.use.length ? g.use : null]);
  if (g.proxies !== undefined) out.push(["proxies", g.proxies.length ? g.proxies : null]);
  if (g.url !== undefined) out.push(["url", g.url || null]);
  if (g.interval !== undefined) {
    out.push(["interval", g.interval === null || !Number.isFinite(g.interval) ? null : g.interval]);
  }
  if (g.icon !== undefined) out.push(["icon", g.icon || null]);
  return out;
}

function renderGroupItem(g: ProxyGroupPatch, ind: number, listIndent: number): string[] {
  const keyIndent = ind + 2;
  const out: string[] = [];
  for (const [key, value] of patchEntries({ ...g, type: g.type || "select" })) {
    if (value !== null) out.push(...renderField(key, value, keyIndent, listIndent));
  }
  out[0] = `${" ".repeat(ind)}- ${out[0].slice(keyIndent)}`;
  return out;
}

/** Line-level edit of one list field (keeps other list lines and their quoting). */
function editGroupList(
  lines: string[],
  groupName: string,
  key: string,
  edit: (values: string[], field: Field, map: ItemMap) => { values: string[]; lines?: string[] } | null,
): string[] {
  const v = viewGroups(lines, true);
  if (!v) return lines;
  const k = v.names.indexOf(groupName);
  const map = k >= 0 ? v.maps[k] : null;
  const f = map?.fields.find((x) => x.key === key);
  if (!map || !f) return lines;
  const res = edit(fieldList(lines, f), f, map);
  if (!res) return lines;
  if (res.lines) return res.lines;
  return setItemField(lines, v.items[k], map, key, res.values.length ? res.values : null, detectListIndent(v));
}

function listInsert(lines: string[], groupName: string, key: string, value: string, index: (vals: string[]) => number): string[] {
  return editGroupList(lines, groupName, key, (vals, f) => {
    if (vals.includes(value)) return null;
    const at = Math.max(0, Math.min(index(vals), vals.length));
    const values = [...vals.slice(0, at), value, ...vals.slice(at)];
    const items = blockListLines(lines, f);
    if (isFlowField(f) || !items.length) return { values };
    const line = `${" ".repeat(items[0].indent)}- ${formatScalar(value)}`;
    const pos = at < items.length ? items[at].line : items[items.length - 1].line + 1;
    return { values, lines: splice(lines, pos, pos, [line]) };
  });
}

function listRemove(lines: string[], groupName: string, key: string, value: string): string[] {
  return editGroupList(lines, groupName, key, (vals, f) => {
    if (!vals.includes(value)) return null;
    const values = vals.filter((x) => x !== value);
    if (isFlowField(f)) return { values };
    const drop = new Set(blockListLines(lines, f).filter((x) => x.value === value).map((x) => x.line));
    return { values, lines: lines.filter((_, i) => !drop.has(i)) };
  });
}

function listRename(lines: string[], groupName: string, key: string, from: string, to: string): string[] {
  return editGroupList(lines, groupName, key, (vals, f) => {
    if (!vals.includes(from)) return null;
    const values = vals.map((x) => (x === from ? to : x));
    if (isFlowField(f)) return { values };
    const next = [...lines];
    for (const x of blockListLines(lines, f)) {
      if (x.value === from) next[x.line] = `${" ".repeat(x.indent)}- ${formatScalar(to)}`;
    }
    return { values, lines: next };
  });
}

function globalInsertIndex(name: string): (vals: string[]) => number {
  return (vals) => {
    if (name === "STRAIGHT") {
      const p = vals.indexOf("PROXY");
      if (p >= 0) return p + 1;
    }
    const d = vals.indexOf("DIRECT");
    return d >= 0 ? d : vals.length;
  };
}

function insertGroup(v: GroupsView, g: ProxyGroupPatch): string[] {
  const itemLines = renderGroupItem(g, v.ind, detectListIndent(v));
  const blankSep = v.items.some((it, k) => k > 0 && isBlank(v.lines[it.start - 1]));
  const proxyIdx = v.names.indexOf("PROXY");
  const globalIdx = v.names.indexOf("GLOBAL");
  let after = -1;
  if (g.name === "STRAIGHT" && proxyIdx >= 0) after = proxyIdx;
  else if (globalIdx > 0) after = globalIdx - 1;
  else if (globalIdx < 0 && v.items.length) after = v.items.length - 1;

  let lines: string[];
  if (after >= 0) {
    const pos = v.items[after].contentEnd;
    lines = splice(v.lines, pos, pos, blankSep ? ["", ...itemLines] : itemLines);
  } else if (globalIdx === 0) {
    const pos = v.items[0].start;
    lines = splice(v.lines, pos, pos, blankSep ? [...itemLines, ""] : itemLines);
  } else {
    lines = splice(v.lines, v.sec.end, v.sec.end, itemLines);
  }
  if (g.name !== "GLOBAL") lines = listInsert(lines, "GLOBAL", "proxies", g.name, globalInsertIndex(g.name));
  return lines;
}

/**
 * Create a group or update the given fields of an existing one in place.
 * `originalName` renames a group (references are updated by renameGroupReferences).
 * GLOBAL gets the group only when it is created.
 */
export function upsertProxyGroup(
  yaml: string,
  group: ProxyGroupPatch,
  opts: { originalName?: string } = {},
): string {
  return withLf(yaml, (text) => {
    let lines = ensureSeqSection(text.split("\n"), "proxy-groups");
    const v = viewGroups(lines, true)!;
    let current = opts.originalName ?? group.name;
    if (!v.names.includes(current)) {
      if (current !== group.name && v.names.includes(group.name)) current = group.name;
      else return insertGroup(v, group).join("\n");
    }
    for (const [key, value] of patchEntries(group)) {
      const cv = viewGroups(lines, true)!;
      const k = cv.names.indexOf(current);
      const map = cv.maps[k];
      if (k < 0 || !map) break;
      lines = setItemField(lines, cv.items[k], map, key, value, detectListIndent(cv));
      if (key === "name") current = group.name;
    }
    return lines.join("\n");
  });
}

/** Remove a group item, its GLOBAL entry and simple rules targeting it; other lines stay untouched. */
export function deleteProxyGroup(yaml: string, name: string): string {
  return withLf(yaml, (text) => {
    let lines = text.split("\n");
    const v = viewGroups(lines, true);
    const k = v ? v.names.indexOf(name) : -1;
    if (v && k >= 0) {
      const item = v.items[k];
      lines = splice(lines, item.start, item.contentEnd, []);
      const at = item.start;
      if (at > 0 && at < lines.length && isBlank(lines[at - 1]) && isBlank(lines[at])) {
        lines = splice(lines, at, at + 1, []);
      }
      lines = listRemove(lines, "GLOBAL", "proxies", name);
    }
    return removeRuleLines(lines, (r) => r.target === name && r.type !== "COMPLEX").join("\n");
  });
}

/** Rename references to a group: `proxies` lists of all groups and simple rule targets (incl. MATCH). */
export function renameGroupReferences(yaml: string, from: string, to: string): string {
  if (from === to) return yaml;
  return withLf(yaml, (text) => {
    let lines = text.split("\n");
    const v = viewGroups(lines, true);
    if (v) {
      for (const name of v.names) {
        if (name) lines = listRename(lines, name, "proxies", from, to);
      }
    }
    const rv = viewRules(lines, true);
    if (!rv) return lines.join("\n");
    const next = [...lines];
    for (const r of rv.rules) {
      const raw = renameRuleTarget(r.raw, from, to);
      if (raw !== r.raw) next[r.line] = `${" ".repeat(rv.ind)}- ${raw}`;
    }
    return next.join("\n");
  });
}

const PROXY_GROUP_ICON =
  "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/azure-api-proxy/default.svg";
const STRAIGHT_GROUP_ICON =
  "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/azure-entra-global-secure-access/default.svg";

/** Ensure PROXY + STRAIGHT groups for panel policies (insert before GLOBAL). */
export function ensurePolicyGroups(yaml: string): string {
  let next = yaml;
  const names = () => new Set(parseProxyGroups(next).map((g) => g.name));
  if (!names().has("PROXY")) {
    next = upsertProxyGroup(next, {
      name: "PROXY",
      type: "select",
      use: ["subscription"],
      proxies: ["DIRECT"],
      icon: PROXY_GROUP_ICON,
    });
  }
  if (!names().has("STRAIGHT")) {
    next = upsertProxyGroup(next, {
      name: "STRAIGHT",
      type: "select",
      proxies: ["DIRECT"],
      icon: STRAIGHT_GROUP_ICON,
    });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Rules

const POLICY_BLOCK_START = "# zkeen:policies";
const POLICY_BLOCK_END = "# zkeen:policies-end";

interface RuleLine extends ParsedRule {
  line: number;
}

interface RulesView {
  sec: Section;
  ind: number;
  rules: RuleLine[];
  /** Marker line indexes, -1 when absent. */
  blockStart: number;
  blockEnd: number;
}

function isComplexRule(raw: string): boolean {
  return /^(OR|AND|NOT|SUB-RULE),/.test(raw);
}

function ruleTargetIndex(parts: string[]): number {
  if (parts[0]?.trim() === "MATCH") return 1;
  let i = parts.length - 1;
  while (i > 1 && RULE_PARAMS.has(parts[i]?.trim() ?? "")) i--;
  return i;
}

function parseRuleRaw(raw: string): ParsedRule {
  if (isComplexRule(raw)) return { raw, type: "COMPLEX", payload: raw, target: "", extra: "" };
  const parts = raw.split(",");
  const type = parts[0]?.trim() || "";
  const ti = ruleTargetIndex(parts);
  return {
    raw,
    type,
    payload: type === "MATCH" ? "" : parts.slice(1, ti).join(","),
    target: parts[ti]?.trim() || "",
    extra: parts.slice(ti + 1).join(","),
  };
}

/** Replace the outbound of a simple rule; other fields (payload, no-resolve, …) stay as is. */
export function renameRuleTarget(raw: string, from: string, to: string): string {
  if (isComplexRule(raw)) return raw;
  const parts = raw.split(",");
  const ti = ruleTargetIndex(parts);
  if (parts[ti]?.trim() !== from) return raw;
  parts[ti] = formatRuleTarget(to);
  return parts.join(",");
}

function viewRules(lines: string[], strict: boolean): RulesView | null {
  const seq = viewSeq(lines, "rules", strict);
  if (!seq) return null;
  let blockStart = -1;
  let blockEnd = -1;
  for (let i = seq.sec.start; i < seq.sec.end; i++) {
    const t = lines[i].trim();
    if (t === POLICY_BLOCK_START && blockStart < 0) blockStart = i;
    else if (t === POLICY_BLOCK_END && blockStart >= 0 && blockEnd < 0) blockEnd = i;
  }
  if (blockStart >= 0 && blockEnd < 0) {
    if (strict) throw new YamlLayoutError("rules");
    blockStart = -1;
  }
  const rules: RuleLine[] = [];
  for (const item of seq.items) {
    const m = lines[item.start].match(/^ *-\s+(.*)$/);
    if (!m) continue;
    const raw = scalar(m[1]);
    if (!raw) continue;
    rules.push({
      ...parseRuleRaw(raw),
      line: item.start,
      inPolicyBlock: blockStart >= 0 && item.start > blockStart && item.start < blockEnd,
    });
  }
  let ind = seq.ind;
  if (!seq.items.length && blockStart >= 0) ind = indentOf(lines[blockStart]);
  return { sec: seq.sec, ind, rules, blockStart, blockEnd };
}

function removeRuleLines(lines: string[], pred: (r: RuleLine) => boolean): string[] {
  const v = viewRules(lines, true);
  if (!v) return lines;
  const drop = new Set(v.rules.filter(pred).map((r) => r.line));
  return drop.size ? lines.filter((_, i) => !drop.has(i)) : lines;
}

export function parseRules(yaml: string): ParsedRule[] {
  const v = viewRules(toLines(yaml), false);
  return v ? v.rules : [];
}

/** Simple rules of a group outside the panel policy block (the group editor's scope). */
export function rulesForGroup(yaml: string, groupName: string): ParsedRule[] {
  return parseRules(yaml).filter(
    (r) => r.target === groupName && r.type !== "COMPLEX" && !r.inPolicyBlock,
  );
}

/**
 * Apply the group editor's rule list in place: rules kept by `raw` are not touched,
 * removed ones are deleted, new ones go after the group's last rule
 * (else before the first MATCH, else at the end). MATCH, complex rules and the
 * policy block are never changed here.
 */
export function setGroupRules(yaml: string, groupName: string, drafts: GroupRuleDraft[]): string {
  return withLf(yaml, (text) => {
    let lines = text.split("\n");
    let v = viewRules(lines, true);
    const owned = v
      ? v.rules.filter(
          (r) => !r.inPolicyBlock && r.type !== "COMPLEX" && r.type !== "MATCH" && r.target === groupName,
        )
      : [];

    const inFile = new Map<string, number>();
    for (const r of owned) inFile.set(r.raw, (inFile.get(r.raw) ?? 0) + 1);
    const keep = new Map<string, number>();
    const add: string[] = [];
    for (const d of drafts) {
      if (d.type === "MATCH") continue;
      const left = d.raw ? inFile.get(d.raw) ?? 0 : 0;
      if (d.raw && left > 0) {
        inFile.set(d.raw, left - 1);
        keep.set(d.raw, (keep.get(d.raw) ?? 0) + 1);
      } else {
        add.push(d.raw ?? buildRuleLine(d.type, d.value, groupName));
      }
    }
    const drop = new Set<number>();
    for (const r of owned) {
      const n = keep.get(r.raw) ?? 0;
      if (n > 0) keep.set(r.raw, n - 1);
      else drop.add(r.line);
    }
    if (!add.length && !drop.size) return text;

    lines = ensureSeqSection(lines, "rules");
    v = viewRules(lines, true)!;
    const pad = " ".repeat(v.ind);
    const firstMatch = v.rules.find((r) => !r.inPolicyBlock && r.type === "MATCH");
    const insertAt = owned.length
      ? owned[owned.length - 1].line + 1
      : firstMatch
        ? firstMatch.line
        : v.sec.end;

    const out: string[] = [];
    for (let i = 0; i <= lines.length; i++) {
      if (i === insertAt) out.push(...add.map((r) => `${pad}- ${r}`));
      if (i < lines.length && !drop.has(i)) out.push(lines[i]);
    }
    return out.join("\n");
  });
}

export function buildRuleLine(type: string, value: string, groupName: string): string {
  if (type === "MATCH") return `MATCH,${formatRuleTarget(groupName)}`;
  return `${type},${value},${formatRuleTarget(groupName)}`;
}

// ---------------------------------------------------------------------------
// Panel policies (marker block at the top of rules)

export type UserPolicyKind = "ip" | "domain";

export interface UserPolicy {
  kind: UserPolicyKind;
  value: string;
  target: string;
}

export interface UserPolicyDraft extends UserPolicy {
  id: string;
}

/** Normalize host IP for SRC-IP-CIDR policies (strip accidental /prefix). */
export function normalizePolicyIp(ip: string): string {
  return ip.trim().replace(/\/\d+$/, "");
}

/** Normalize domain for DOMAIN-SUFFIX (strip scheme, path, www). */
export function normalizePolicyDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0] ?? "";
  d = d.split("?")[0] ?? "";
  d = d.replace(/\.$/, "");
  return d;
}

export function userPolicyId(p: UserPolicy): string {
  return `${p.kind}:${p.value}:${p.target}`;
}

function isHostSrcIpPolicy(type: string, payload: string): boolean {
  // Legacy invalid "SRC-IP,a.b.c.d,TARGET" (broke mihomo) + host SRC-IP-CIDR /32.
  if (type === "SRC-IP") return true;
  if (type !== "SRC-IP-CIDR") return false;
  return !payload.includes("/") || /\/32$/.test(payload);
}

/** Rule CSV lines must not quote outbound names — Mihomo treats quotes as part of the name. */
function formatRuleTarget(target: string): string {
  return target.trim().replace(/,/g, "");
}

export function formatUserPolicyLine(p: UserPolicy, indent = 2): string {
  const pad = " ".repeat(indent);
  return p.kind === "ip"
    ? `${pad}- SRC-IP-CIDR,${normalizePolicyIp(p.value)}/32,${formatRuleTarget(p.target)}`
    : `${pad}- DOMAIN-SUFFIX,${normalizePolicyDomain(p.value)},${formatRuleTarget(p.target)}`;
}

function parsePolicyTarget(parts: string[]): string {
  let targetIdx = parts.length - 1;
  if (parts[targetIdx]?.trim() === "no-resolve") targetIdx -= 1;
  return (parts[targetIdx]?.trim() ?? "").replace(/^['"]|['"]$/g, "");
}

function parseUserPolicyFromRaw(raw: string): UserPolicy | null {
  const parts = raw.split(",");
  const type = parts[0]?.trim() ?? "";
  if (isHostSrcIpPolicy(type, parts[1]?.trim() ?? "")) {
    const ip = normalizePolicyIp((parts[1]?.trim() ?? "").replace(/^['"]|['"]$/g, ""));
    const target = parsePolicyTarget(parts);
    if (!ip || !target) return null;
    return { kind: "ip", value: ip, target };
  }
  if (type === "DOMAIN-SUFFIX") {
    const domain = normalizePolicyDomain((parts[1]?.trim() ?? "").replace(/^['"]|['"]$/g, ""));
    const target = parsePolicyTarget(parts);
    if (!domain || !target) return null;
    return { kind: "domain", value: domain, target };
  }
  return null;
}

function hasPolicyBlock(v: RulesView): boolean {
  return v.blockStart >= 0 && v.blockEnd > v.blockStart;
}

/** Parse panel-managed policies (marker block, or legacy SRC-IP-CIDR /32 before migration). */
export function parseUserPolicies(yaml: string): UserPolicyDraft[] {
  const v = viewRules(toLines(yaml), false);
  if (!v) return [];
  const block = hasPolicyBlock(v);
  const out: UserPolicyDraft[] = [];
  const seen = new Set<string>();
  for (const r of v.rules) {
    if (block && !r.inPolicyBlock) continue;
    const parsed = parseUserPolicyFromRaw(r.raw);
    if (!parsed) continue;
    // Without marker block: only migrate IP policies (avoid grabbing config DOMAIN-SUFFIX).
    if (!block && parsed.kind !== "ip") continue;
    const id = userPolicyId(parsed);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...parsed, id });
  }
  return out;
}

function normalizePolicies(policies: UserPolicy[]): UserPolicy[] {
  const unique: UserPolicy[] = [];
  const seen = new Set<string>();
  for (const p of policies) {
    const normalized: UserPolicy =
      p.kind === "ip"
        ? { kind: "ip", value: normalizePolicyIp(p.value), target: p.target.trim() }
        : { kind: "domain", value: normalizePolicyDomain(p.value), target: p.target.trim() };
    if (!normalized.value || !normalized.target) continue;
    const id = userPolicyId(normalized);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(normalized);
  }
  return unique;
}

/**
 * Replace panel policies. With a marker block only the block content changes;
 * without it, the block is created at the top of rules and the legacy host IP rules
 * being adopted are moved into it (one-time migration). Nothing else is touched.
 */
export function replaceUserPolicies(yaml: string, policies: UserPolicy[]): string {
  return withLf(yaml, (text) => {
    let lines = text.split("\n");
    const unique = normalizePolicies(policies);
    let v = viewRules(lines, true);

    if (v && hasPolicyBlock(v)) {
      const pad = " ".repeat(indentOf(lines[v.blockStart]));
      const ind = pad.length;
      const current = lines.slice(v.blockStart, v.blockEnd + 1).join("\n");
      const block = [
        `${pad}${POLICY_BLOCK_START}`,
        ...unique.map((p) => formatUserPolicyLine(p, ind)),
        `${pad}${POLICY_BLOCK_END}`,
      ];
      if (unique.length) {
        if (block.join("\n") === current) return text;
        return splice(lines, v.blockStart, v.blockEnd + 1, block).join("\n");
      }
      let end = v.blockEnd + 1;
      if (end < lines.length && isBlank(lines[end])) end++;
      return splice(lines, v.blockStart, end, []).join("\n");
    }

    if (!unique.length) return text;
    if (v) {
      const ids = new Set(unique.map(userPolicyId));
      const drop = new Set(
        v.rules
          .filter((r) => {
            const p = parseUserPolicyFromRaw(r.raw);
            return p?.kind === "ip" && ids.has(userPolicyId(p));
          })
          .map((r) => r.line),
      );
      lines = lines.filter((_, i) => !drop.has(i));
    }
    lines = ensureSeqSection(lines, "rules");
    v = viewRules(lines, true)!;
    const pad = " ".repeat(v.ind);
    const block = [
      `${pad}${POLICY_BLOCK_START}`,
      ...unique.map((p) => formatUserPolicyLine(p, v!.ind)),
      `${pad}${POLICY_BLOCK_END}`,
    ];
    const at = v.rules.length ? v.rules[0].line : v.sec.end;
    return splice(lines, at, at, v.rules.length ? [...block, ""] : block).join("\n");
  });
}

export interface IpPolicy {
  id: string;
  ip: string;
  target: string;
  raw: string;
}

/** @deprecated use parseUserPolicies */
export function parseIpPolicies(yaml: string): IpPolicy[] {
  return parseUserPolicies(yaml)
    .filter((p) => p.kind === "ip")
    .map((p) => ({
      id: p.id,
      ip: p.value,
      target: p.target,
      raw: `SRC-IP-CIDR,${p.value}/32,${p.target}`,
    }));
}

/** @deprecated use replaceUserPolicies */
export function replaceIpPolicies(
  yaml: string,
  policies: { ip: string; target: string }[],
): string {
  const domains = parseUserPolicies(yaml).filter((p) => p.kind === "domain");
  return replaceUserPolicies(yaml, [
    ...policies.map((p) => ({ kind: "ip" as const, value: p.ip, target: p.target })),
    ...domains.map((p) => ({ kind: "domain" as const, value: p.value, target: p.target })),
  ]);
}

export function defaultNewGroup(name: string): ProxyGroupConfig {
  return {
    name,
    type: "select",
    use: ["subscription"],
    proxies: ["DIRECT"],
  };
}
