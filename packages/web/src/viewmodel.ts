import type { Hint, PromptAnalysis, Recommendation, SessionSummary, Severity, Status, Step, StepCheck, TimeSplit } from "@lgtm/core";

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
export function incompleteMarkers(p: Pick<PromptAnalysis, "files" | "partial"> & { reason?: string }): string[] {
  const out: string[] = [];
  if (fileTotals(p).maybeIncomplete) out.push("may be incomplete");
  if (p.partial) out.push("partial (subagents not analysed)");
  // The reason (clamped in the table) carries why a subagent transcript was cut; surface it next to the counts.
  const cut = /subagent transcript truncated \((event|text) cap\)/.exec(p.reason ?? "");
  if (cut) out.push(`subagent transcript truncated (${cut[1]} cap)`);
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
  | { kind: "list"; show?: "attention" }
  | { kind: "session"; id: string; show?: "attention" }
  | { kind: "steps"; id: string; index: number }
  | { kind: "diff"; id: string; index: number; path: string }
  | { kind: "map"; id: string; index: number | null }
  | { kind: "play"; id: string; index: number; beat: number };

const INDEX_RE = /^(?:0|[1-9]\d{0,8})$/;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Hash routes: `#/session/<id>`, `#/session/<id>/map`, `#/session/<id>/prompt/<index>[/map|play]`, `#/session/<id>/prompt/<index>/diff?path=<file>`; `?show=attention` on the list and session routes. Anything else is the list. */
export function parseRoute(hash: string): Route {
  if (hash === "#/?show=attention") return { kind: "list", show: "attention" };
  const session = /^#\/session\/([^/?]+)\?show=attention$/.exec(hash);
  if (session) {
    const id = decode(session[1]!);
    return id === null ? { kind: "list" } : { kind: "session", id, show: "attention" };
  }
  const m = /^#\/session\/([^/?]+)(?:\/prompt\/([^/?]+))?(?:\/(map|diff|play)(?:[?]([^#]*))?)?$/.exec(hash);
  if (!m) return { kind: "list" };
  const id = decode(m[1]!);
  if (id === null) return { kind: "list" };
  const index = m[2];
  const action = m[3];
  const query = m[4];
  if (index === undefined) {
    if (action === undefined && query === undefined) return { kind: "session", id };
    if (action === "map" && query === undefined) return { kind: "map", id, index: null };
    return { kind: "list" };
  }
  if (!INDEX_RE.test(index)) return { kind: "list" };
  const n = Number(index);
  if (action === undefined && query === undefined) return { kind: "steps", id, index: n };
  if (action === "map" && query === undefined) return { kind: "map", id, index: n };
  if (action === "diff") {
    if (!query) return { kind: "list" };
    const pMatch = /^path=([^&]+)$/.exec(query);
    if (!pMatch) return { kind: "list" };
    const path = decode(pMatch[1]!);
    if (!path) return { kind: "list" };
    return { kind: "diff", id, index: n, path };
  }
  if (action === "play") {
    if (query === undefined || query === "") return { kind: "play", id, index: n, beat: 1 };
    const bMatch = /^beat=([^&]+)$/.exec(query);
    if (!bMatch) return { kind: "list" };
    if (!INDEX_RE.test(bMatch[1]!)) return { kind: "list" };
    const b = Number(bMatch[1]!);
    return { kind: "play", id, index: n, beat: Math.max(1, b) };
  }
  return { kind: "list" };
}

export function routeHref(r: Route): string {
  switch (r.kind) {
    case "list":
      return r.show === "attention" ? "#/?show=attention" : "#/";
    case "session":
      return `#/session/${encodeURIComponent(r.id)}${r.show === "attention" ? "?show=attention" : ""}`;
    case "steps":
      return `#/session/${encodeURIComponent(r.id)}/prompt/${r.index}`;
    case "diff":
      return `#/session/${encodeURIComponent(r.id)}/prompt/${r.index}/diff?path=${encodeURIComponent(r.path)}`;
    case "map":
      return r.index === null
        ? `#/session/${encodeURIComponent(r.id)}/map`
        : `#/session/${encodeURIComponent(r.id)}/prompt/${r.index}/map`;
    case "play":
      return r.beat <= 1
        ? `#/session/${encodeURIComponent(r.id)}/prompt/${r.index}/play`
        : `#/session/${encodeURIComponent(r.id)}/prompt/${r.index}/play?beat=${r.beat}`;
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
export function checkOutcome(c: Pick<StepCheck, "exitCode" | "passed" | "stopped">): { text: string; tone: "pass" | "fail" | "none" } {
  if (c.passed === true) return { text: "passed", tone: "pass" };
  if (c.stopped === true) return { text: "stopped", tone: "none" };
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

const KIND_LABELS = { M: "Modified", A: "Added", D: "Deleted" } as const;

/** Text label of a file change kind, so the kind is never conveyed by color or a single letter alone. */
export function kindLabel(k: "M" | "A" | "D"): string {
  return KIND_LABELS[k];
}

/** Prefix drawn in front of a diff line; the `+`/`-`/space character is part of the text, not only a color. */
export function diffPrefix(t: "+" | "-" | " "): string {
  return t;
}

const isAbs = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

/**
 * Display form of `path` among `all` (the files of one prompt): absolute paths lose their common directory
 * prefix, a lone absolute path keeps its last two segments. Display only; the API always gets the exact path.
 */
export function shortPath(path: string, all: readonly string[]): string {
  if (!isAbs(path)) return path;
  const split = (p: string): string[] => p.split(/[\\/]/);
  const dirs = [...new Set([path, ...all])].filter(isAbs).map((p) => split(p).slice(0, -1));
  let common = dirs[0]!;
  if (dirs.length > 1) {
    for (const d of dirs.slice(1)) {
      let i = 0;
      while (i < common.length && i < d.length && common[i] === d[i]) i++;
      common = common.slice(0, i);
    }
  } else {
    common = common.slice(0, Math.max(0, common.length - 1));
  }
  const parts = split(path);
  const rest = parts.slice(common.length);
  const out = rest.join("/").replace(/^\/+/, "");
  return out || (parts[parts.length - 1] ?? path);
}

/** Total `+` and `-` lines of a diff, for the header. */
export function diffCounts(hunks: readonly { lines: readonly { t: "+" | "-" | " " }[] }[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) for (const l of h.lines) if (l.t === "+") added++;
  else if (l.t === "-") removed++;
  return { added, removed };
}

const REC_LABELS: Record<Recommendation, string> = { skim: "Skim", "read-flagged": "Read flagged", "read-all": "Read all" };
/** Text markers (empty, half, full circle) so the recommendation is told apart without color. */
const REC_MARKERS: Record<Recommendation, string> = { skim: "○", "read-flagged": "◐", "read-all": "●" };
const REC_HELP: Record<Recommendation, string> = {
  skim: "Skim: no high-severity hints",
  "read-flagged": "Read flagged: review the files with hints",
  "read-all": "Read all: several high-severity kinds of hints",
};

export function recommendationLabel(r: Recommendation): string {
  return REC_LABELS[r];
}
export function recommendationMarker(r: Recommendation): string {
  return REC_MARKERS[r];
}
export function recommendationHelp(r: Recommendation): string {
  return REC_HELP[r];
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 };
const SEVERITY_LABELS: Record<Severity, string> = { high: "High", warn: "Warn", info: "Info" };

export function severityLabel(s: Severity): string {
  return SEVERITY_LABELS[s];
}

/** Hints ordered by severity (high first), then path, then rule; a new array. */
export function sortHints(hints: readonly Hint[]): Hint[] {
  return [...hints].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      a.rule.localeCompare(b.rule),
  );
}

export const WHERE_TO_LOOK_MAX = 5;

/** First `max` hints by severity then path, and how many were left out. */
export function topHints(hints: readonly Hint[], max = WHERE_TO_LOOK_MAX): { shown: Hint[]; hidden: number } {
  const sorted = sortHints(hints);
  return { shown: sorted.slice(0, max), hidden: Math.max(0, sorted.length - max) };
}

/** Distinct rule names of the hints, in severity order. */
export function distinctRules(hints: readonly Hint[]): string[] {
  return [...new Set(sortHints(hints).map((h) => h.rule))];
}

/** Rule names per file path (hints without a path are left out). */
export function rulesByPath(hints: readonly Hint[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of sortHints(hints)) {
    if (h.path === null) continue;
    const list = out.get(h.path) ?? [];
    if (!list.includes(h.rule)) list.push(h.rule);
    out.set(h.path, list);
  }
  return out;
}

/** Shown instead of a path for prompt-level hints. */
export const PROMPT_LEVEL = "(whole prompt)";

/**
 * Expanded rows / step lists are keyed by prompt index / step number, which are append-only within a session
 * file, so they survive a data refresh. `toggleKey` flips one key without mutating the set.
 */
export function toggleKey<K>(set: ReadonlySet<K>, key: K): ReadonlySet<K> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** The expanded keys that still exist in fresh data; the same set when nothing was dropped. */
export function retainKeys<K>(set: ReadonlySet<K>, existing: Iterable<K>): ReadonlySet<K> {
  if (set.size === 0) return set;
  const have = new Set(existing);
  const kept = new Set<K>();
  for (const k of set) if (have.has(k)) kept.add(k);
  return kept.size === set.size ? set : kept;
}

/** Split prompts into own (non-inherited) and inherited groups.
 *  Returns {own, inherited, from} where:
 *   - own: prompts without inheritedFrom
 *   - inherited: prompts with inheritedFrom
 *   - from: the sessionId the inherited prompts came from (first one, or empty string)
 */
export function splitInherited(prompts: readonly PromptAnalysis[]): {
  own: readonly PromptAnalysis[];
  inherited: readonly PromptAnalysis[];
  from: string;
} {
  const own: PromptAnalysis[] = [];
  const inherited: PromptAnalysis[] = [];
  let from: string = "";
  for (const p of prompts) {
    if (p.inheritedFrom) {
      inherited.push(p);
      if (!from) from = p.inheritedFrom;
    } else {
      own.push(p);
    }
  }
  return { own, inherited, from: from };
}
