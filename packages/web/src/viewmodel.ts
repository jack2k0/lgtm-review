import type { PromptAnalysis, SessionSummary, Status, TimeSplit } from "@lgtm/core";

export const PROMPT_PAGE = 500;

export const STATUS_ORDER: readonly Status[] = ["checked", "unchecked", "failing", "no-changes"];

const STATUS_LABELS: Record<Status, string> = {
  checked: "Checked",
  unchecked: "Unchecked",
  failing: "Failing",
  "no-changes": "No changes",
};

export function statusLabel(s: Status): string {
  return STATUS_LABELS[s];
}

/** Non-zero status counts in a fixed order, e.g. `[{status:"checked",count:3,label:"Checked"}]`. */
export function statusCountItems(counts: SessionSummary["statusCounts"]): { status: Status; count: number; label: string }[] {
  return STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => ({ status: s, count: counts[s], label: STATUS_LABELS[s] }));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD HH:MM`, or an em dash when unknown/invalid. */
export function formatStarted(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export type Phase = "read" | "write" | "check" | "fix";
export const PHASES: readonly { phase: Phase; label: string; key: keyof TimeSplit }[] = [
  { phase: "read", label: "Read", key: "readMs" },
  { phase: "write", label: "Write", key: "writeMs" },
  { phase: "check", label: "Check", key: "checkMs" },
  { phase: "fix", label: "Fix", key: "fixMs" },
];

export interface BarSegment {
  phase: Phase;
  label: string;
  ms: number;
  /** Share of the bar in percent (shares of the four phase values, they sum to 100 when any time exists). */
  pct: number;
}

export function timeSegments(split: TimeSplit): BarSegment[] {
  const total = PHASES.reduce((a, p) => a + split[p.key], 0);
  if (total <= 0) return [];
  return PHASES.filter((p) => split[p.key] > 0).map((p) => ({
    phase: p.phase,
    label: p.label,
    ms: split[p.key],
    pct: (split[p.key] / total) * 100,
  }));
}

/** Text alternative of the bar, e.g. `Read 10s (20%), Write 40s (80%)`; "No timing data" when empty. */
export function timeBarText(split: TimeSplit): string {
  const segs = timeSegments(split);
  if (segs.length === 0) return "No timing data";
  return segs.map((s) => `${s.label} ${formatDuration(s.ms)} (${Math.round(s.pct)}%)`).join(", ");
}

export interface FileTotals {
  count: number;
  added: number;
  removed: number;
  maybeIncomplete: boolean;
}

export function fileTotals(p: Pick<PromptAnalysis, "files">): FileTotals {
  let added = 0;
  let removed = 0;
  let maybeIncomplete = false;
  for (const f of p.files) {
    added += f.added;
    removed += f.removed;
    if (f.maybeIncomplete) maybeIncomplete = true;
  }
  return { count: p.files.length, added, removed, maybeIncomplete };
}

export function filesText(t: FileTotals): string {
  return `${plural(t.count, "file")} +${t.added} -${t.removed}`;
}

/** Incompleteness markers shown next to the file counts. */
export function incompleteMarkers(p: Pick<PromptAnalysis, "files" | "partial">): string[] {
  const out: string[] = [];
  if (fileTotals(p).maybeIncomplete) out.push("may be incomplete");
  if (p.partial) out.push("partial (subagents not analysed)");
  return out;
}

export function visiblePrompts<T>(items: readonly T[], limit: number): { shown: T[]; hidden: number } {
  const shown = items.slice(0, Math.max(0, limit));
  return { shown, hidden: items.length - shown.length };
}

export function nextLimit(limit: number, total: number): number {
  return Math.min(total, limit + PROMPT_PAGE);
}

export type Route = { kind: "list" } | { kind: "session"; id: string };

export function parseRoute(hash: string): Route {
  const m = /^#\/session\/([^/]+)$/.exec(hash);
  if (m) {
    try {
      return { kind: "session", id: decodeURIComponent(m[1]!) };
    } catch {
      /* fall through */
    }
  }
  return { kind: "list" };
}

export function routeHref(r: Route): string {
  return r.kind === "session" ? `#/session/${encodeURIComponent(r.id)}` : "#/";
}
