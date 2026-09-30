/**
 * Bounded diagnostic journal of actions that can change proxy selections.
 * Lives in the browser's localStorage (never on the router flash); stores only
 * group/node names and results — no URLs, secrets or config content.
 */
import { clashJson, type ClashConnection } from "./api";

const JOURNAL_KEY = "zkeen-op-journal";
const JOURNAL_MAX = 200;

export interface JournalEntry {
  ts: string;
  id: string;
  op: string;
  result: "ok" | "error" | "skipped";
  group?: string;
  from?: string;
  to?: string;
  detail?: string;
  /** Groups whose selected node differs before/after the operation: group → [before, after]. */
  changed?: Record<string, [string, string]>;
}

export function newOpId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

/** Short error text for the journal with URLs (may carry tokens) masked. */
export function journalError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 200);
}

export function readJournal(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function journal(entry: Omit<JournalEntry, "ts">): void {
  try {
    const next = [...readJournal(), { ts: new Date().toISOString(), ...entry }];
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(next.slice(-JOURNAL_MAX)));
  } catch {
    /* storage full or disabled — diagnostics are best-effort */
  }
}

export function exportJournal(): void {
  const blob = new Blob([JSON.stringify(readJournal(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `zkeen-journal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Current `now` of every selector group (GET /proxies); undefined when the core is unreachable. */
export async function snapshotSelections(
  clash: ClashConnection,
): Promise<Record<string, string> | undefined> {
  try {
    const data = await clashJson<{ proxies: Record<string, { now?: string; all?: string[] }> }>(
      "proxies",
      clash,
      undefined,
      10000,
    );
    const out: Record<string, string> = {};
    for (const [name, p] of Object.entries(data.proxies ?? {})) {
      if (p.now && Array.isArray(p.all)) out[name] = p.now;
    }
    return out;
  } catch {
    return undefined;
  }
}

export function diffSelections(
  before?: Record<string, string>,
  after?: Record<string, string>,
): Record<string, [string, string]> | undefined {
  if (!before || !after) return undefined;
  const changed: Record<string, [string, string]> = {};
  for (const [group, was] of Object.entries(before)) {
    const now = after[group] ?? "";
    if (now !== was) changed[group] = [was, now];
  }
  return changed;
}

/** Run `fn` and journal it together with the selection changes it caused. */
export async function withSelectionSnapshots<T>(
  op: string,
  clash: ClashConnection,
  fn: () => Promise<T>,
  after?: (result: T) => ClashConnection,
): Promise<T> {
  const id = newOpId();
  const before = await snapshotSelections(clash);
  try {
    const result = await fn();
    const post = await snapshotSelections(after ? after(result) : clash);
    journal({
      id,
      op,
      result: "ok",
      changed: diffSelections(before, post),
      detail: before && post ? undefined : "snapshot unavailable",
    });
    return result;
  } catch (err) {
    journal({ id, op, result: "error", detail: journalError(err) });
    throw err;
  }
}
