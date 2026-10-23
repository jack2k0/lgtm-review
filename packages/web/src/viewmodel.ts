import type { PromptAnalysis, SessionSummary, Status, Step, StepCheck, TimeSplit } from "@lgtm/core";

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

export type Route =
  | { kind: "list" }
  | { kind: "session"; id: string }
  | { kind: "steps"; id: string; index: number }
  | { kind: "diff"; id: string; index: number; path: string };

const INDEX_RE = /^(?:0|[1-9]\d{0,8})$/;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Hash routes: `#/session/<id>`, `#/session/<id>/prompt/<index>`, `#/session/<id>/prompt/<index>/diff?path=<file>`. Anything else is the list. */
export function parseRoute(hash: string): Route {
  const m = /^#\/session\/([^/?]+)(?:\/prompt\/([^/?]+)(?:(\/diff)\?path=([^&]*))?)?$/.exec(hash);
  if (!m) return { kind: "list" };
  const id = decode(m[1]!);
  if (id === null) return { kind: "list" };
  if (m[2] === undefined) return { kind: "session", id };
  if (!INDEX_RE.test(m[2])) return { kind: "list" };
  const index = Number(m[2]);
  if (m[3] === undefined) return { kind: "steps", id, index };
  const path = decode(m[4] ?? "");
  if (!path) return { kind: "list" };
  return { kind: "diff", id, index, path };
}

export function routeHref(r: Route): string {
  switch (r.kind) {
    case "list":
      return "#/";
    case "session":
      return `#/session/${encodeURIComponent(r.id)}`;
    case "steps":
      return `#/session/${encodeURIComponent(r.id)}/prompt/${r.index}`;
    case "diff":
      return `#/session/${encodeURIComponent(r.id)}/prompt/${r.index}/diff?path=${encodeURIComponent(r.path)}`;
  }
}

export function phaseLabel(p: Phase): string {
  return PHASES.find((x) => x.phase === p)!.label;
}

/** Step duration; sub-second steps read "<1s" so they are not mistaken for missing data. */
export function formatStepDuration(ms: number): string {
  return ms < 500 ? "<1s" : formatDuration(ms);
}

/** Local `HH:MM:SS`, or an empty string when unknown/invalid. */
export function formatClock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Mechanical title from the server; a generic one when it is empty, so a card never has a blank heading. */
export function stepTitle(s: Pick<Step, "n" | "phase" | "title">): string {
  const t = s.title.trim();
  return t || `${phaseLabel(s.phase)} step ${s.n}`;
}

/** Outcome of a check: "passed", "exit N" (failed) or "did not run" when there is no usable result. */
export function checkOutcome(c: Pick<StepCheck, "exitCode" | "passed">): { text: string; tone: "pass" | "fail" | "none" } {
  if (c.passed === true) return { text: "passed", tone: "pass" };
  if (c.exitCode !== null) return { text: `exit ${c.exitCode}`, tone: "fail" };
  if (c.passed === false) return { text: "failed", tone: "fail" };
  return { text: "did not run", tone: "none" };
}

/** Label of the actions disclosure, e.g. "1 action" / "12 actions". */
export function actionsLabel(n: number): string {
  return plural(n, "action");
}

/** Heading of a prompt: 1-based number as the CLI shows it, plus the text (or a placeholder). */
export function promptHeading(index: number, text: string): string {
  return `Prompt ${index + 1}: ${text.trim() || "(empty prompt)"}`;
}
