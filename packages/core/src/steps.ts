import type { Action, Step, StepCheck } from "./schema.js";
import { actionIntervals, unionMs, type Interval, type Phase } from "./timing.js";

/**
 * Mechanical grouping of a prompt's tool calls into steps. Pure and deterministic.
 *
 * - The phase of an action comes from the shared classifier in timing.ts (`actionPhase`), so step
 *   phases agree with the time split. Consecutive actions of the same phase form one step, a
 *   check is always its own step.
 * - Tools outside the model (Agent, TodoWrite, MCP, ...) join the surrounding step; with no step
 *   open yet they open a Read step.
 * - Titles are templates (no LLM): "Read 3 files", "Edit src/a.ts (+2 -1)", "Run pnpm test -> passed",
 *   "Fix: read 2 files, edit src/a.ts (+2 -1)".
 * - Quotes are the agent text blocks written right before the step's first action (<= 3).
 */

export const STEPS_MAX = 200;
export const ACTIONS_MAX = 5000;
export const QUOTES_PER_STEP = 3;
export const SUMMARY_MAX = 200;
const TITLE_MAX = 200;
const EXCERPT_MAX = 200;
const CHECK_LABEL_MAX = 80;

export type ActionKind = "read" | "search" | "web" | "command" | "edit" | "other";

export interface EditNote {
  path: string;
  kind: "M" | "A" | "D";
  added: number;
  removed: number;
}

export interface CheckRec {
  command: string;
  label: string;
  exitCode: number | null;
  passed: boolean | null;
  excerpt: string;
  /** The command was refused or failed without an exit code. */
  notRun: boolean;
}

/** Slim record of one tool call, retained in detail mode. */
export interface ActionRec {
  tool: string;
  kind: ActionKind;
  /** Raw path / command / hint of the call (<= 200 chars). */
  target: string;
  done: boolean;
  ok: boolean;
  /** `null`: the tool is outside the model. */
  phase: Phase | null;
  prevTs: number | null;
  useTs: number | null;
  resTs: number | null;
  quotes: string[];
  check: CheckRec | null;
  edits: EditNote[];
}

export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function relPath(path: string, cwd: string | null): string {
  if (cwd !== null && cwd !== "") {
    const base = cwd.replace(/[\\/]+$/, "");
    if (path.startsWith(base + "/") || path.startsWith(base + "\\")) return path.slice(base.length + 1);
  }
  return path;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Kind of a call from its tool name (before edits are known). */
export function kindOf(tool: string, isCheck: boolean): ActionKind {
  if (isCheck || tool === "Bash") return "command";
  switch (tool) {
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
    case "LS":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    default:
      return "other";
  }
}

/** First non-empty output lines of a failing command, without the "Exit code N" prefix. */
export function failureExcerpt(text: string): string {
  const rest = text.replace(/^\s*(?:Error:\s*)?Exit code \d+/, "");
  const lines = rest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.slice(0, 2).join("\n").slice(0, EXCERPT_MAX);
}

function summaryOf(a: ActionRec, cwd: string | null): string {
  const t = a.target;
  switch (a.kind) {
    case "read":
    case "edit":
      return t === "" ? a.tool : oneLine(relPath(t, cwd), SUMMARY_MAX);
    case "command":
      return t === "" ? a.tool : oneLine(t, SUMMARY_MAX);
    case "search":
    case "web":
      return t === "" ? a.tool : oneLine(t, SUMMARY_MAX);
    default:
      return oneLine(t === "" ? a.tool : `${a.tool}: ${t}`, SUMMARY_MAX);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function checkTitle(c: CheckRec): string {
  const what = c.label !== "" ? c.label : oneLine(c.command, CHECK_LABEL_MAX);
  const outcome = c.passed === true ? "passed" : c.passed === false && c.exitCode === 0 ? "failed (exit code masked)" : c.exitCode !== null ? `failed (exit ${c.exitCode})` : c.notRun ? "did not run" : "no result";
  return `Run ${what} -> ${outcome}`;
}

function mixTitle(acts: ActionRec[], cwd: string | null, fix: boolean): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const bump = (key: string): void => {
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const files = new Map<string, EditNote>();
  for (const a of acts) {
    if (a.edits.length > 0) {
      if (!counts.has("edit")) order.push("edit");
      counts.set("edit", 1);
      for (const e of a.edits) {
        const cur = files.get(e.path);
        if (!cur) files.set(e.path, { ...e });
        else {
          cur.added += e.added;
          cur.removed += e.removed;
          if (e.kind === "D") cur.kind = "D";
        }
      }
      continue;
    }
    if (a.kind === "edit") bump(a.done ? "editFailed" : "editOpen");
    else if (a.kind === "other") bump(`other:${a.tool}`);
    else bump(a.kind);
  }
  const parts: string[] = [];
  for (const key of order) {
    const n = counts.get(key) ?? 0;
    if (key === "read") parts.push(`read ${plural(n, "file")}`);
    else if (key === "search") parts.push(`search ${plural(n, "time")}`);
    else if (key === "web") parts.push(`do ${plural(n, "web lookup")}`);
    else if (key === "command") parts.push(`run ${plural(n, "command")}`);
    else if (key === "editFailed") parts.push(`${plural(n, "failed edit")}`);
    else if (key === "editOpen") parts.push(`${plural(n, "edit")} without result`);
    else if (key === "edit") {
      const list = [...files.values()];
      if (list.length <= 2) {
        for (const f of list) {
          const verb = f.kind === "A" ? "create" : f.kind === "D" ? "delete" : "edit";
          const stats = f.kind === "A" ? `+${f.added}` : f.kind === "D" ? `-${f.removed}` : `+${f.added} -${f.removed}`;
          parts.push(`${verb} ${relPath(f.path, cwd)} (${stats})`);
        }
      } else {
        const added = list.reduce((s, f) => s + f.added, 0);
        const removed = list.reduce((s, f) => s + f.removed, 0);
        parts.push(`edit ${list.length} files (+${added} -${removed})`);
      }
    } else {
      const tool = key.slice("other:".length);
      parts.push(tool === "Agent" ? (n === 1 ? "delegate to a subagent" : `delegate to ${n} subagents`) : `use ${tool}${n > 1 ? ` x${n}` : ""}`);
    }
  }
  const text = parts.join(", ");
  if (fix) return `Fix: ${text}`;
  return text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

interface Acc {
  phase: Phase;
  isCheck: boolean;
  acts: ActionRec[];
}

export function buildSteps(actions: readonly ActionRec[], cwd: string | null): { steps: Step[]; truncated: boolean } {
  const groups: Acc[] = [];
  let truncated = false;
  let open: Acc | null = null;
  for (const a of actions) {
    if (a.phase === null) {
      if (open === null) {
        if (groups.length >= STEPS_MAX) {
          truncated = true;
          break;
        }
        open = { phase: "read", isCheck: false, acts: [] };
        groups.push(open);
      }
      open.acts.push(a);
      continue;
    }
    if (open !== null && a.phase !== "check" && !open.isCheck && open.phase === a.phase) {
      open.acts.push(a);
      continue;
    }
    if (groups.length >= STEPS_MAX) {
      truncated = true;
      break;
    }
    open = { phase: a.phase, isCheck: a.phase === "check", acts: [a] };
    groups.push(open);
  }

  const steps = groups.map((g, i): Step => {
    const first = g.acts[0]!;
    const intervals: Interval[] = [];
    for (const a of g.acts) if (a.done && a.phase !== null) intervals.push(...actionIntervals(a.prevTs, a.useTs, a.resTs));
    const checkRec = g.isCheck ? first.check : null;
    const check: StepCheck | undefined =
      checkRec !== null
        ? { command: oneLine(checkRec.command, SUMMARY_MAX), exitCode: checkRec.exitCode, passed: checkRec.passed, excerpt: checkRec.excerpt }
        : undefined;
    let title = checkRec !== null ? checkTitle(checkRec) : mixTitle(g.acts, cwd, g.phase === "fix");
    if (g.acts.some((a) => a.tool === "Agent")) title += " (partial: subagent activity not analysed)";
    const files: string[] = [];
    for (const a of g.acts) for (const e of a.edits) if (!files.includes(e.path)) files.push(e.path);
    const step: Step = {
      n: i + 1,
      phase: g.phase,
      title: cap(title, TITLE_MAX),
      startedAt: iso(first.useTs),
      durationMs: unionMs(intervals),
      quotes: first.quotes.slice(),
      actions: g.acts.map((a): Action => ({ tool: a.tool, summary: summaryOf(a, cwd), ok: a.ok, ts: iso(a.useTs) })),
      files,
    };
    if (check) step.check = check;
    return step;
  });
  return { steps, truncated };
}
