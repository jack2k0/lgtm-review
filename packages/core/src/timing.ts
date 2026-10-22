/**
 * Approximate active-time split of one prompt (Read / Write / Check / Fix) and its one-line headline.
 * Pure and deterministic: only the timestamps found in the log are used, never a clock.
 *
 * Model: every classified tool call ("action") covers two intervals that belong to its phase:
 *   - think: previous event timestamp -> tool_use timestamp (model thinking time before the call);
 *   - exec:  tool_use timestamp -> tool_result timestamp.
 * A think gap > 5 min (waiting for the user) or an exec delta > 10 min is excluded entirely;
 * negative or missing deltas count as 0. Intervals of one phase are merged (union) so parallel
 * calls are not double counted; `activeMs` is the union of all intervals of all phases, so the
 * four phase values can sum to more than `activeMs` when different phases overlap in time.
 */

export type Phase = "read" | "write" | "check" | "fix";

export interface TimeSplit {
  readMs: number;
  writeMs: number;
  checkMs: number;
  fixMs: number;
}

export interface Timing {
  timeSplit: TimeSplit;
  activeMs: number;
  headline: string;
}

export const THINK_GAP_MAX_MS = 5 * 60_000;
export const EXEC_MAX_MS = 10 * 60_000;

/** Tools whose time counts as Read. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"]);
/** Tools whose time counts as Write (Bash that changed files counts as Write too). */
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * Phase of a tool call before the Fix rule is applied. Returns null for tools outside the
 * model (Agent/Task, TodoWrite, AskUserQuestion, MCP and unknown tools): their time is not counted.
 * Precedence for Bash: check command > edit (changed files) > read.
 */
export function baseClass(name: string, bash: { isCheck: boolean; edited: boolean }): "read" | "write" | "check" | null {
  if (name === "Bash") return bash.isCheck ? "check" : bash.edited ? "write" : "read";
  if (WRITE_TOOLS.has(name)) return "write";
  if (READ_TOOLS.has(name)) return "read";
  return null;
}

/** Milliseconds since epoch for an ISO timestamp, or null when absent or unparsable. */
export function parseTs(s: string | null | undefined): number | null {
  if (typeof s !== "string" || s === "") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export type Interval = readonly [start: number, end: number];

/** Total length of the union of the intervals. */
export function unionMs(intervals: readonly Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let [curStart, curEnd] = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

const PHASE_ORDER: readonly Phase[] = ["write", "read", "check", "fix"];
const PHASE_WORD: Record<Phase, string> = { write: "writing", read: "reading", check: "checking", fix: "fixing" };

/**
 * `"Mostly <writing|reading|checking|fixing> (NN%), K check(s)"` for the largest phase
 * (ties: write, read, check, fix); NN is the phase's share of the four phase values (rounded).
 * `"No timing data"` when `activeMs` is 0.
 */
export function makeHeadline(split: TimeSplit, activeMs: number, checkCount: number): string {
  if (activeMs <= 0) return "No timing data";
  const value: Record<Phase, number> = { read: split.readMs, write: split.writeMs, check: split.checkMs, fix: split.fixMs };
  const sum = value.read + value.write + value.check + value.fix;
  if (sum <= 0) return "No timing data";
  let best: Phase = "write";
  for (const p of PHASE_ORDER) if (value[p] > value[best]) best = p;
  const pct = Math.round((value[best] * 100) / sum);
  return `Mostly ${PHASE_WORD[best]} (${pct}%), ${checkCount} check${checkCount === 1 ? "" : "s"}`;
}

export interface TimingTracker {
  /**
   * Record one finished action. `prevTs` is the timestamp of the event before the tool_use,
   * `useTs` and `resTs` those of the tool_use and its tool_result (null = unknown).
   */
  add(phase: Phase, prevTs: number | null, useTs: number | null, resTs: number | null): void;
  result(checkCount: number): Timing;
}

export function createTimingTracker(): TimingTracker {
  const byPhase: Record<Phase, Interval[]> = { read: [], write: [], check: [], fix: [] };

  function push(phase: Phase, start: number | null, end: number | null, max: number): void {
    if (start === null || end === null) return;
    const d = end - start;
    if (d <= 0 || d > max) return;
    byPhase[phase].push([start, end]);
  }

  return {
    add(phase, prevTs, useTs, resTs): void {
      push(phase, prevTs, useTs, THINK_GAP_MAX_MS);
      push(phase, useTs, resTs, EXEC_MAX_MS);
    },
    result(checkCount: number): Timing {
      const timeSplit: TimeSplit = {
        readMs: unionMs(byPhase.read),
        writeMs: unionMs(byPhase.write),
        checkMs: unionMs(byPhase.check),
        fixMs: unionMs(byPhase.fix),
      };
      const activeMs = unionMs([...byPhase.read, ...byPhase.write, ...byPhase.check, ...byPhase.fix]);
      return { timeSplit, activeMs, headline: makeHeadline(timeSplit, activeMs, checkCount) };
    },
  };
}
