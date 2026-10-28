import { checkScope, classifyCommand, findMaskedFailure, type RepoScripts } from "./check-patterns.js";
import { classifyShellMutation, normalizePath, resolveTarget, SHELL_EDIT_FILE, type ShellMutation } from "./shell-edits.js";
import { buildFileDiff, capPatch, DIFF_LINES_MAX, patchChars, patchLines, type RawPatch } from "./diff.js";
import { computeHints, emptyStats, isDocPath, isScratchPath, recommend, type EditEvidence, type EditStats } from "./hints.js";
import { createParser, type Event, type TaskNotificationEvent, type ToolInput, type ToolResultEvent } from "./parse.js";
import { agentWorktreeRoot, resolveScope, resolveWorktreeScope, scopeCovers, scopeGaps, type ResolvedScope } from "./scope.js";
import { ACTIONS_MAX, buildSteps, failureExcerpt, kindOf, oneLine, QUOTES_PER_STEP, type ActionRec } from "./steps.js";
import { actionPhase, createTimingTracker, parseTs, type TimingTracker } from "./timing.js";
import { createSubagentCollector, emptyFlags, mergeSubagents, planContinuations, textWeight, type MergeContext, type MergeFlags, type SubagentTranscript } from "./subagents.js";
import type { FileChange, FileDiff, PromptAnalysis, PromptDetail, SessionAnalysis, Status, Warning } from "./schema.js";

export interface AnalyzeOptions {
  repo?: RepoScripts;
  /** Overrides the title taken from the log. */
  title?: string;
  /** Session id used when set (e.g. from the file name); otherwise the one found in the log. */
  sessionId?: string;
  /** File name attached to warnings. */
  file?: string;
  /**
   * Opt-in: also retain what the Steps and Diff views need (slim actions, agent quotes, capped hunks).
   * `finish()` output is identical with or without it.
   */
  detail?: boolean;
  /**
   * Already parsed subagent transcripts by the tool-use id of the parent's `Agent` call (see `parseSubagent`).
   * A transcript whose id matches no `Agent` call is reported as a warning and attributed to no prompt.
   */
  subagents?: ReadonlyMap<string, SubagentTranscript> | Iterable<readonly [string, SubagentTranscript]>;
}

export interface Analyzer {
  push(line: string): void;
  /**
   * Adds the transcript of the subagent started by the `Agent` call `toolUseId`: an already parsed transcript
   * or the lines of its file. Must be called before `finish()` (later calls are ignored).
   */
  addSubagent(toolUseId: string, transcript: SubagentTranscript | Iterable<string>, meta?: { agentId?: string; description?: string }): void;
  finish(): SessionAnalysis;
  /** Steps of every prompt (detail mode; `[]` otherwise). Finishes the analysis if needed. */
  details(): PromptDetail[];
  /** Diff of one file edited in a prompt, from the log only; `null` when unknown or not in detail mode. */
  diffFor(promptIndex: number, path: string): FileDiff | null;
  /** Rough size of the retained detail data in bytes (0 outside detail mode). */
  detailBytes(): number;
}

/** Session-wide retention budgets (detail mode). */
export const DETAIL_DIFF_CHARS_MAX = 16_000_000;
export const DETAIL_ACTIONS_MAX = 100_000;

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const STOP_STATUSES = new Set(["killed", "stopped", "cancelled", "canceled", "timeout", "timed_out", "aborted"]);
/** Exit codes of a check killed by a signal (SIGINT/SIGKILL/SIGTERM and 144). Neither passed nor failed (Q5, C3). */
const SIGNAL_EXITS = new Set([130, 137, 143, 144]);
const TITLE_MAX = 60;

function isSignalExit(code: number): boolean {
  return SIGNAL_EXITS.has(code);
}
const FAIL_OUTPUT_MAX = 200;

interface FileTouch {
  path: string;
  kind: "M" | "A" | "D";
  added: number;
  removed: number;
  maybeIncomplete: boolean;
  /** The edit was made in the Fix phase (the last completed check had failed). */
  inFix: boolean;
  /** Counters of assertion-like and skip-marker lines; the lines themselves are never kept. */
  stats: EditStats;
  /** code, documentation (FR-015) or scratch (S-20); decided when the edit is recorded. */
  cls: "code" | "doc" | "scratch";
  /** Detail mode: retained hunks of this edit; `undefined` when the log recorded none. */
  patch?: RawPatch | undefined;
}

interface EditRec {
  /**
   * Position in the event stream when the edit result arrived. An edit in the same command as a check is
   * ordered by segment: half a step before the result when the check ran on it, half a step after otherwise.
   */
  seq: number;
  files: FileTouch[];
  /** Produced by a command whose only mutating segments are git operations: never changes the status. */
  gitOp: boolean;
  /** Every file of the edit is documentation: listed, never changes the status (FR-015). */
  doc: boolean;
  /** No code file and not all documentation: scratch files, possibly with documentation (S-20). */
  scratch: boolean;
  /** Agent id of the subagent that made the edit; `""` for the parent thread. */
  thread: string;
}

interface CheckRec {
  useSeq: number;
  /** Position at which the result (the notification, for a background check) arrived; 0 while open. */
  resultSeq: number;
  /**
   * Position up to which the check's outcome covers the edits: an edit with a greater `seq` is not covered.
   * Foreground checks: the result position. Background checks: the position of the launch (`useSeq`), so an edit
   * made while the check was running stays uncovered.
   */
  coveredSeq: number;
  completed: boolean;
  /** The command did not run (tool error without an exit code): not a check outcome at all. */
  ignored: boolean;
  /** `null`: a background check reported as failed without an exit code. */
  exit: number | null;
  /** The command was started in the background (the result only confirmed the launch). */
  background: boolean;
  /** A notification said the background check was stopped or killed: it neither passed nor failed. */
  stopped: boolean;
  /** Exit 130/137/143/144, foreground or from a notification: neither passed nor failed (Q5). Not `stopped`. */
  signalStop: boolean;
  label: string;
  unreliable: boolean;
  /** A command after the check may have reverted the edits (`; git checkout file`). */
  probe: boolean;
  /** Exit 0, but the output tail shows failures (the exit code was masked by a pipe or trailing command). */
  masked: boolean;
  /** First line of the output tail that shows the masked failure. */
  maskedLine: string;
  output: string;
  /** Agent id of the subagent that ran the check; `""` for the parent thread. */
  thread: string;
  /** Where the check ran; `null` when it covers the whole project. */
  scope: ResolvedScope | null;
}

interface PromptState {
  index: number;
  uuid: string;
  text: string;
  edits: EditRec[];
  checks: CheckRec[];
  partial: boolean;
  /** What the subagent merge could not do completely (suffixes of the reason). */
  flags: MergeFlags;
  /** A shell edit was counted from the command text: the file list and the diffs may be incomplete. */
  shellHeuristic: boolean;
  timing: TimingTracker;
  /** Threads (`""` parent, else agent id) whose last completed check failed: their work now counts as Fix. */
  failing: Set<string>;
  /** Detail mode. */
  startedAtMs: number | null;
  actions: ActionRec[];
  /** Agent text blocks written right before the next action, per thread. */
  quoteBufs: Map<string, string[]>;
  truncated: boolean;
  /** Retained diff lines per file path. */
  patchLines: Map<string, number>;
}

interface PendingUse {
  prompt: PromptState;
  thread: string;
  name: string;
  input: ToolInput;
  check: CheckRec | null;
  /** Working directory recorded on the tool_use record; null when absent. */
  cwd: string | null;
  /** Timestamps (ms) of the previous event and of this tool_use; null when unknown. */
  prevTs: number | null;
  useTs: number | null;
  /** The prompt was in the failing state when the call started. */
  failing: boolean;
  action: ActionRec | null;
}

function editTouch(use: PendingUse, res: ToolResultEvent, inFix: boolean, cls: FileTouch["cls"]): FileTouch | null {
  const path = use.input.filePath;
  if (path === undefined) return null;
  const isWrite = use.name === "Write";
  // A written file without patch counts the written content as added (nothing is known about the old one).
  const stats = res.stats ?? (isWrite ? use.input.contentStats : undefined) ?? emptyStats();
  if (isWrite && res.resultType === "create") {
    return { path, kind: "A", added: res.createLines ?? use.input.contentLines ?? 0, removed: 0, maybeIncomplete: false, inFix, stats, cls };
  }
  if (res.structuredPatch) {
    return { path, kind: "M", added: res.structuredPatch.added, removed: res.structuredPatch.removed, maybeIncomplete: false, inFix, stats, cls };
  }
  if (isWrite) {
    // No create marker and no patch: whole-file write of unknown previous content.
    return { path, kind: "M", added: use.input.contentLines ?? 0, removed: 0, maybeIncomplete: true, inFix, stats, cls };
  }
  return { path, kind: "M", added: 0, removed: 0, maybeIncomplete: true, inFix, stats, cls };
}

/** Coverage position of the last completed (non-ignored) check; null when none completed. */
function lastCheckSeq(p: PromptState): number | null {
  let last: number | null = null;
  for (const c of p.checks) if (!c.ignored && c.completed && (last === null || c.coveredSeq > last)) last = c.coveredSeq;
  return last;
}

function evidenceOf(p: PromptState): EditEvidence[] {
  const out: EditEvidence[] = [];
  for (const e of p.edits) {
    if (e.gitOp) continue;
    for (const t of e.files) {
      if (t.cls === "scratch") continue;
      out.push({ seq: e.seq, path: t.path, inFix: t.inFix, changed: t.added + t.removed, stats: t.stats });
    }
  }
  return out;
}

function aggregateFiles(edits: EditRec[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const e of edits) {
    for (const t of e.files) {
      const cur = byPath.get(t.path);
      if (!cur) {
        byPath.set(t.path, { path: t.path, kind: t.kind, added: t.added, removed: t.removed, maybeIncomplete: t.maybeIncomplete });
      } else {
        cur.added += t.added;
        cur.removed += t.removed;
        cur.maybeIncomplete = cur.maybeIncomplete || t.maybeIncomplete;
        // First touch decides "A"; a later delete wins; otherwise keep the kind.
        if (t.kind === "D") cur.kind = "D";
        else if (cur.kind === "D") cur.kind = "M";
      }
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Diff paths made by the plain (non-git) edits of a command that also runs a history-moving git operation,
 * matched by the resolved targets of those edits (A2). Null when a target is unresolved or a code target matches no diff path:
 * the whole diff is then attributed as one, as before.
 */
function plainDiffPaths(sm: ShellMutation, diff: readonly { path: string }[], cwd: string | null, codeLike: (path: string) => boolean): Set<string> | null {
  const out = new Set<string>();
  for (const e of sm.edits) {
    if (e.gitOp) continue;
    if (e.file === SHELL_EDIT_FILE) return null;
    const target = resolveTarget(e.file, cwd, sm.hasCd, e.baseDir);
    const rel = target.startsWith("/") ? null : normalizePath(target);
    let hit = false;
    for (const f of diff) {
      if (rel === null ? f.path === normalizePath(target) : rel !== "" && !rel.startsWith("..") && !rel.startsWith("~") && (f.path === rel || f.path.endsWith(`/${rel}`))) {
        out.add(f.path);
        hit = true;
      }
    }
    // A documentation or scratch target missing from a (capped) diff cannot change which files are code edits.
    if (!hit && (codeLike(target) || target.startsWith("~"))) return null;
  }
  return out;
}

/** Basename has no dot (`archive`, `GNUmakefile`). `.` / `..` and names like `a.ts` are not. */
function extensionlessPath(path: string): boolean {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return base !== "" && base !== "." && base !== ".." && !base.includes(".");
}

/**
 * No-diff path only (C5): an extensionless `git mv` destination is a directory when another parsed edit
 * target starts with `<dest>/`. The source being a directory, or a diff-path prefix, does not count.
 */
function gitMvDirectoryPaths(items: readonly { t: FileTouch; gitMade: boolean }[]): Set<string> {
  const dirs = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (!item.gitMade || item.t.kind !== "A") continue;
    const target = item.t.path.replace(/\/+$/, "");
    if (!extensionlessPath(target)) continue;
    const prefix = `${target}/`;
    if (items.some((o, j) => j !== i && o.t.path.replace(/\/+$/, "").startsWith(prefix))) dirs.add(item.t.path);
  }
  return dirs;
}

/** Sequence number of an edit made in the same command as a check, ordered by segment. */
function orderedSeq(seq: number, order: "before-check" | "after-check" | "unknown"): number {
  return order === "before-check" ? seq - 0.5 : order === "after-check" ? seq + 0.5 : seq;
}

function failureOutput(output: string): string {
  return oneLine(output.replace(/^\s*(?:Error:\s*)?Exit code \d+/, ""), FAIL_OUTPUT_MAX);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Scope of a check run from `cwd`; inside an agent worktree it is always the worktree (or a directory in it). */
function checkScopeOf(raw: string[] | null, cwd: string | null, sessionRoot: string | null): ResolvedScope | null {
  const wt = agentWorktreeRoot(cwd);
  return wt === null ? resolveScope(raw, cwd, sessionRoot) : resolveWorktreeScope(raw, cwd as string, wt, sessionRoot);
}

function judge(p: PromptState, by: (thread: string) => string): { status: Status; reason: string; outOfScope: Map<string, string> } {
  const via = (thread: string): string => (thread === "" ? "" : ` (by subagent ${by(thread)})`);
  if (p.edits.length === 0) return { status: "no-changes", reason: "no edits", outOfScope: new Map() };
  // Git operations, documentation and scratch files need no check (FR-015, S-20): none of them moves the status.
  const edits = p.edits.filter((e) => !e.gitOp && !e.doc && !e.scratch);
  if (edits.length === 0) {
    const nonGit = p.edits.filter((e) => !e.gitOp);
    if (nonGit.length === 0) return { status: "no-changes", reason: "no edits (git operations only)", outOfScope: new Map() };
    const anyDoc = nonGit.some((e) => e.files.some((t) => t.cls === "doc"));
    const anyScratch = nonGit.some((e) => e.files.some((t) => t.cls === "scratch"));
    const what = anyDoc && anyScratch ? "documentation and scratch files only" : anyScratch ? "scratch files only" : "documentation only";
    return { status: "no-changes", reason: `no code edits (${what})`, outOfScope: new Map() };
  }
  const lastEdit = edits.reduce((m, e) => Math.max(m, e.seq), -1);
  const real = p.checks.filter((c) => !c.ignored);
  // An agent-worktree check that passed but covers none of the edited files proves nothing about them.
  const editedPaths = new Set<string>();
  for (const e of edits) for (const f of e.files) if (f.cls === "code" && f.path.startsWith("/")) editedPaths.add(f.path);
  const coversNone = (c: CheckRec): boolean =>
    c.scope?.worktree !== undefined &&
    c.exit === 0 &&
    !c.masked &&
    editedPaths.size > 0 &&
    ![...editedPaths].some((path) => c.scope!.roots.some((r) => scopeCovers(r, path)));
  const completed = real.filter((c) => c.completed && !coversNone(c));
  const lastCompleted = completed.reduce<CheckRec | null>(
    (m, c) => (m === null || c.coveredSeq > m.coveredSeq || (c.coveredSeq === m.coveredSeq && c.resultSeq > m.resultSeq) ? c : m),
    null,
  );

  // A signal exit (Q5) and a notification stop are resolved, so they are not an open check. A quiet background
  // check (Q4) is open, but it does not hide a covering pass.
  const incomplete = real.filter(
    (c) => !c.completed && !c.stopped && !c.signalStop && c.useSeq > lastEdit && (lastCompleted === null || c.useSeq > lastCompleted.resultSeq),
  );
  const passCovers = lastCompleted !== null && lastCompleted.coveredSeq > lastEdit && lastCompleted.exit === 0 && !lastCompleted.masked;
  const bgQuiet = incomplete.length > 0 && incomplete.every((c) => c.background) && passCovers;
  if (incomplete.length > 0 && !bgQuiet) return { status: "unchecked", reason: "check did not complete", outOfScope: new Map() };

  if (lastCompleted !== null && lastCompleted.coveredSeq > lastEdit) {
    if (lastCompleted.masked) {
      return {
        status: "failing",
        reason: `${lastCompleted.label} output indicates failures (exit code masked)${via(lastCompleted.thread)}`,
        outOfScope: new Map(),
      };
    }
    if (lastCompleted.exit === null) {
      return { status: "failing", reason: `${lastCompleted.label}: background check failed${via(lastCompleted.thread)}`, outOfScope: new Map() };
    }
    if (lastCompleted.exit === 0) {
      const note = lastCompleted.probe ? " (edits may have been reverted)" : lastCompleted.unreliable ? " (exit code not verified)" : "";
      const docsAfter = p.edits.filter((e) => e.doc && !e.gitOp && e.seq > lastCompleted.coveredSeq).length;
      const nonCodeAfter = p.edits.filter((e) => !e.gitOp && (e.doc || e.scratch) && e.seq > lastCompleted.coveredSeq).length;
      // Every code file is checked against the passing checks that finished after its last edit (D5).
      const files = new Map<string, number>();
      for (const e of edits) {
        for (const f of e.files) {
          if (f.cls !== "code") continue;
          const seen = files.get(f.path);
          if (seen === undefined || e.seq > seen) files.set(f.path, e.seq);
        }
      }
      const gaps = scopeGaps(
        [...files].map(([path, lastSeq]) => ({ path, lastSeq })),
        completed.map((c) => ({ coveredSeq: c.coveredSeq, passed: c.exit === 0 && !c.masked, scope: c.scope })),
      );
      const outOfScope = new Map<string, string>();
      let scopeNote = "";
      if (gaps.length > 0) {
        // An unscoped passing check that finished after the last edit covers every file, so gaps imply a scope.
        const label = lastCompleted.scope!.label;
        scopeNote = ` (scoped to ${label})`;
        for (const gap of gaps) outOfScope.set(gap, label);
      }
      const docsTail = docsAfter > 0 ? `; ${plural(docsAfter, "documentation edit")} after it` : "";
      const bgTail = bgQuiet ? "; a later background check did not report" : "";
      return {
        status: "checked",
        reason: `${lastCompleted.label} passed after last ${nonCodeAfter > 0 ? "code " : ""}edit${note}${scopeNote}${via(lastCompleted.thread)}${docsTail}${bgTail}`,
        outOfScope,
      };
    }
    const out = failureOutput(lastCompleted.output);
    return {
      status: "failing",
      reason: (out === "" ? `${lastCompleted.label} failed (exit ${lastCompleted.exit})` : `${lastCompleted.label} failed: ${out}`) + via(lastCompleted.thread),
      outOfScope: new Map(),
    };
  }

  // After every covering completion: a signal that outlives the last edit did not complete, and it is not a failure.
  if (real.some((c) => c.signalStop && c.useSeq > lastEdit)) return { status: "unchecked", reason: "check did not complete", outOfScope: new Map() };
  if (real.some((c) => c.stopped && c.useSeq > lastEdit)) return { status: "unchecked", reason: "check stopped", outOfScope: new Map() };
  if (lastCompleted === null) return { status: "unchecked", reason: "no checks ran", outOfScope: new Map() };
  const afterEdits = edits.filter((e) => e.seq > lastCompleted.coveredSeq);
  if (afterEdits.length === 0) return { status: "unchecked", reason: "edit in the same command as the last check", outOfScope: new Map() };
  const latest = afterEdits.reduce((m, e) => (e.seq > m.seq ? e : m));
  return { status: "unchecked", reason: `${plural(afterEdits.length, "edit")} after last check${via(latest.thread)}`, outOfScope: new Map() };
}

function reasonOf(p: PromptState, reason: string): string {
  let r = p.shellHeuristic ? `${reason} (shell edits may be incomplete)` : reason;
  if (p.flags.missing) r += "; subagent activity not analysed";
  if (p.flags.depth) r += "; subagent activity not analysed (depth > 3)";
  if (p.flags.eventCap) r += "; subagent transcript truncated (event cap)";
  if (p.flags.textCap) r += "; subagent transcript truncated (text cap)";
  return r;
}

export function createAnalyzer(opts: AnalyzeOptions = {}): Analyzer {
  const parser = createParser({ ...(opts.file !== undefined ? { file: opts.file } : {}), detail: opts.detail === true });
  const prompts: PromptState[] = [];
  const pending = new Map<string, PendingUse>();
  /**
   * Background checks whose launch result arrived, by `task:<backgroundTaskId>` and `use:<tool_use id>`. A task
   * notification (possibly in a later prompt) resolves the entry; the `pending` entry is gone by then.
   */
  const bgChecks = new Map<string, { check: CheckRec; action: ActionRec | null }>();
  let cur: PromptState | null = null;
  let seq = 0;
  /** Timestamp of the last event per thread (`""` parent, else agent id); events without one inherit it. */
  const lastTs = new Map<string, number | null>();
  const subagents = new Map<string, SubagentTranscript>();
  if (opts.subagents !== undefined) for (const [id, tr] of opts.subagents) subagents.set(id, tr);
  /** Events of the current prompt (or, once a prompt calls `Agent`, of everything after it), until subagents are final. */
  let buf: Event[] = [];
  let bufHasAgent = false;
  /** Rough size of the buffered events (counted into `detailBytes`). */
  let bufChars = 0;
  let deferred = false;
  let processed = false;
  const agentDescriptions = new Map<string, string>();
  const used = new Set<string>();
  let result: SessionAnalysis | null = null;
  const detail = opts.detail === true;
  let diffCharsLeft = DETAIL_DIFF_CHARS_MAX;
  let totalActions = 0;
  let detailChars = 0;
  let detailCache: PromptDetail[] | null = null;
  const filesCache = new Map<number, FileChange[]>();

  /** File class (S-20): documentation first, then scratch, else code. */
  function classify(path: string, use: PendingUse): FileTouch["cls"] {
    if (isDocPath(path)) return "doc";
    return isScratchPath(path, parser.meta().cwd, use.cwd) ? "scratch" : "code";
  }

  /** Retains `patch` for an edit of `path`, within the per-file line cap and the session budget. */
  function retain(p: PromptState, path: string, patch: RawPatch | undefined): RawPatch | undefined {
    if (patch === undefined) return undefined;
    const used = p.patchLines.get(path) ?? 0;
    const capped = capPatch(patch, DIFF_LINES_MAX - used);
    const chars = patchChars(capped);
    if (chars > diffCharsLeft) return { hunks: [], cut: patchLines(patch) > 0 };
    diffCharsLeft -= chars;
    detailChars += chars;
    p.patchLines.set(path, used + patchLines(capped));
    return capped;
  }

  function pendingKey(thread: string, id: string): string {
    return thread === "" ? id : `${thread}\u0000${id}`;
  }

  function setFailing(p: PromptState, thread: string, failing: boolean): void {
    if (failing) p.failing.add(thread);
    else p.failing.delete(thread);
  }

  function onNotification(ev: TaskNotificationEvent): void {
    let entry = ev.toolUseId !== undefined ? bgChecks.get(`use:${ev.toolUseId}`) : undefined;
    if (entry === undefined && ev.taskId !== undefined) entry = bgChecks.get(`task:${ev.taskId}`);
    if (entry === undefined) return;
    const c = entry.check;
    // Only an unresolved background check can be resolved, and only once: the first terminal notification wins.
    if (!c.background || c.completed || c.stopped || c.signalStop) return;
    const status = ev.status.toLowerCase();
    // A notification with no status and no exit code is a progress event (e.g. a monitor): not terminal, ignored.
    if (status === "" && ev.exitCode === null) return;
    const finished = status === "completed" || status === "failed" || (status === "" && ev.exitCode !== null);
    const stopped = STOP_STATUSES.has(status);
    if (!finished && !stopped) return;
    c.resultSeq = seq;
    const act = entry.action;
    if (stopped) {
      c.stopped = true;
      if (act?.check) {
        act.check.background = true;
        act.check.stopped = true;
      }
      return;
    }
    let exit: number | null = null;
    if (finished) {
      // An exit code in the summary decides; "failed" never passes, even when the summary says exit code 0.
      exit = ev.exitCode ?? (status === "completed" ? 0 : null);
      if (status === "failed" && exit === 0) exit = null;
    }
    // A signal exit is its own flag (C3). A stop status above wins even when the summary also names one of these codes.
    if (exit !== null && isSignalExit(exit)) {
      c.signalStop = true;
      c.exit = exit;
      if (act?.check) {
        act.check.background = true;
        act.check.passed = null;
        act.check.exitCode = null;
        act.check.excerpt = "";
      }
      return;
    }
    c.completed = true;
    c.exit = exit;
    if (act?.check) {
      act.check.background = true;
      act.check.exitCode = exit;
      act.check.passed = exit === 0;
      act.check.excerpt = "";
      act.ok = exit === 0;
    }
  }

  function onEvent(ev: Event): void {
    if (ev.type === "text") {
      // Agent text only feeds the quotes: it must not move the sequence or the timing clock.
      if (cur !== null) {
        const key = ev.agentId ?? "";
        let q = cur.quoteBufs.get(key);
        if (q === undefined) cur.quoteBufs.set(key, (q = []));
        q.push(ev.text);
        if (q.length > QUOTES_PER_STEP) q.shift();
      }
      return;
    }
    if (ev.type === "task-notification") {
      // Not a tool event: it resolves a background check but takes no part in the timing clock (the phase of a
      // background check is recorded from its launch result only).
      seq++;
      onNotification(ev);
      return;
    }
    seq++;
    const thread = ev.type === "tool_use" || ev.type === "tool_result" ? (ev.agentId ?? "") : "";
    const prevTs = lastTs.get(thread) ?? null;
    let ts = prevTs;
    if (ev.type !== "boundary") {
      ts = parseTs(ev.ts) ?? prevTs;
      lastTs.set(thread, ts);
    }
    switch (ev.type) {
      case "prompt": {
        cur = {
          index: prompts.length,
          uuid: ev.uuid,
          text: ev.text,
          edits: [],
          checks: [],
          partial: false,
          flags: emptyFlags(),
          shellHeuristic: false,
          timing: createTimingTracker(),
          failing: new Set(),
          startedAtMs: parseTs(ev.ts),
          actions: [],
          quoteBufs: new Map(),
          truncated: false,
          patchLines: new Map(),
        };
        prompts.push(cur);
        return;
      }
      case "boundary":
        return;
      case "tool_use": {
        if (cur === null) return;
        let check: CheckRec | null = null;
        if (ev.name === "Bash" && ev.input.command !== undefined) {
          const cls = classifyCommand(ev.input.command, opts.repo);
          if (cls.isCheck) {
            check = {
              useSeq: seq,
              resultSeq: 0,
              coveredSeq: seq,
              completed: false,
              ignored: false,
              exit: 0,
              background: false,
              stopped: false,
              signalStop: false,
              label: cls.label,
              unreliable: cls.unreliable,
              probe: cls.mutationProbe,
              masked: false,
              maskedLine: "",
              output: "",
              thread,
              scope: checkScopeOf(checkScope(ev.input.command, opts.repo), ev.cwd ?? parser.meta().cwd, parser.meta().cwd),
            };
            cur.checks.push(check);
          }
        }
        let action: ActionRec | null = null;
        if (detail) {
          if (cur.actions.length >= ACTIONS_MAX || totalActions >= DETAIL_ACTIONS_MAX) cur.truncated = true;
          else {
            const kind = kindOf(ev.name, check !== null);
            const quotes = cur.quoteBufs.get(thread) ?? [];
            action = {
              tool: ev.name,
              kind,
              target: oneLine(ev.input.command ?? ev.input.filePath ?? ev.input.hint ?? "", 200),
              done: false,
              ok: false,
              phase: actionPhase(ev.name, { isCheck: check !== null, edited: false }, cur.failing.has(thread)),
              prevTs,
              useTs: ts,
              resTs: null,
              quotes,
              check:
                check === null
                  ? null
                  : { command: ev.input.command ?? "", label: check.label, exitCode: null, passed: null, excerpt: "", notRun: false },
              edits: [],
            };
            if (thread !== "") action.via = "subagent";
            if (ev.name === "Agent" && ev.subagent === "found") action.analysed = true;
            cur.quoteBufs.set(thread, []);
            cur.actions.push(action);
            totalActions++;
            detailChars += 200 + action.target.length + action.quotes.reduce((n, q) => n + q.length, 0);
          }
        }
        pending.set(pendingKey(thread, ev.id), { prompt: cur, thread, name: ev.name, input: ev.input, check, cwd: ev.cwd ?? null, prevTs, useTs: ts, failing: cur.failing.has(thread), action });
        return;
      }
      case "tool_result": {
        const key = pendingKey(thread, ev.toolUseId);
        const use = pending.get(key);
        if (!use) return;
        pending.delete(key);
        if (use.check) {
          if (ev.isError) {
            if (ev.exitCode === undefined) use.check.ignored = true;
            else if (isSignalExit(ev.exitCode)) {
              // Killed by a signal: not a failure, and it must not open the Fix phase (C3).
              use.check.signalStop = true;
              use.check.resultSeq = seq;
              use.check.exit = ev.exitCode;
              use.check.output = ev.text;
            } else {
              use.check.completed = true;
              use.check.exit = ev.exitCode;
              use.check.resultSeq = seq;
              use.check.coveredSeq = seq;
              use.check.output = ev.text;
              setFailing(use.prompt, use.thread, ev.exitCode !== 0);
            }
          } else if (!ev.background) {
            use.check.completed = true;
            use.check.exit = 0;
            use.check.resultSeq = seq;
            use.check.coveredSeq = seq;
            const line = use.check.unreliable ? findMaskedFailure(ev.tail ?? ev.text) : null;
            if (line !== null) {
              use.check.masked = true;
              use.check.maskedLine = line;
            }
            setFailing(use.prompt, use.thread, line !== null);
          }
        }
        const edited = !ev.isError && use.name === "Bash" && ev.bashEditDiff !== undefined && ev.bashEditDiff.length > 0;
        const phase = actionPhase(use.name, { isCheck: use.check !== null, edited }, use.failing);
        if (phase !== null) use.prompt.timing.add(phase, use.prevTs, use.useTs, ts);
        const act = use.action;
        if (act) {
          act.done = true;
          act.ok = !ev.isError;
          act.phase = phase;
          act.resTs = ts;
          if (use.check) {
            // A signal has no verdict. `exitCode` stays null so the step title is "no result", not "failed (exit N)".
            const signal = use.check.signalStop;
            const exitCode = signal ? null : ev.isError ? (ev.exitCode ?? null) : ev.background ? null : 0;
            const masked = use.check.masked;
            act.check = {
              command: use.input.command ?? "",
              label: use.check.label,
              exitCode,
              passed: exitCode === null ? null : exitCode === 0 && !masked,
              excerpt: signal ? "" : ev.isError ? (exitCode === null ? oneLine(ev.text, 200) : failureExcerpt(ev.text)) : masked ? oneLine(use.check.maskedLine, 200) : "",
              notRun: ev.isError && ev.exitCode === undefined,
            };
          }
        }
        if (use.check && !ev.isError && ev.background) {
          use.check.background = true;
          const entry = { check: use.check, action: act };
          bgChecks.set(`use:${ev.toolUseId}`, entry);
          if (ev.backgroundTaskId !== undefined) bgChecks.set(`task:${ev.backgroundTaskId}`, entry);
        }
        if (ev.isError) return;
        let touches: FileTouch[] = [];
        if (EDIT_TOOLS.has(use.name)) {
          const t = editTouch(use, ev, phase === "fix", classify(use.input.filePath ?? "", use));
          if (t) {
            if (detail) t.patch = retain(use.prompt, t.path, t.kind === "A" ? ev.createPatch : ev.patch);
            touches = [t];
          }
        }
        // One record per origin: git-made files never change the status, plain edits do (A1).
        const groups: { files: FileTouch[]; gitOp: boolean }[] = [];
        if (use.name === "Bash" && use.input.command !== undefined) {
          // C13: the repo root analyze knows is the call cwd and the session cwd (no separate git toplevel).
          const sm = classifyShellMutation(use.input.command, opts.repo, [use.cwd, parser.meta().cwd]);
          const cwd = use.cwd ?? parser.meta().cwd;
          if (ev.bashEditDiff !== undefined && ev.bashEditDiff.length > 0) {
            const plain = sm.hasHistoryGitOp && !sm.gitOnly && !sm.opaque ? plainDiffPaths(sm, ev.bashEditDiff, cwd, (path) => classify(path, use) === "code") : null;
            const all = ev.bashEditDiff.map((f) => {
              const gitMade = plain === null ? sm.gitOnly : !plain.has(f.path);
              const t: FileTouch = {
                path: f.path,
                kind: f.kind,
                added: f.added,
                removed: f.removed,
                maybeIncomplete: f.maybeIncomplete || gitMade,
                inFix: phase === "fix",
                stats: f.stats,
                cls: classify(f.path, use),
              };
              if (detail) t.patch = retain(use.prompt, f.path, f.patch);
              return { t, gitMade };
            });
            for (const gitOp of plain === null ? [sm.gitOnly] : [true, false]) {
              const files = all.filter((x) => (plain === null ? true : x.gitMade === gitOp)).map((x) => x.t);
              if (files.length > 0) groups.push({ files, gitOp });
            }
            touches = all.map((x) => x.t);
          } else if (sm.edits.length > 0 && !(ev.bashEditDiff !== undefined && sm.gitOnly)) {
            // No diff in the log (the session did not start inside the repo), or an empty one next to an explicit
            // edit (the harness snapshots before the command ends and misses edits committed within it): count the command text.
            const all = sm.edits.map((e) => {
              const path = resolveTarget(e.file, cwd, sm.hasCd, e.baseDir);
              const t: FileTouch = {
                path,
                kind: e.kind ?? ("M" as const),
                added: 0,
                removed: 0,
                maybeIncomplete: true,
                inFix: use.failing,
                stats: emptyStats(),
                cls: classify(path, use),
              };
              return { t, gitMade: e.gitOp };
            });
            // A directory dest is already git-made; forcing it keeps the split from ever counting that path as code.
            const dirDests = gitMvDirectoryPaths(all);
            for (const item of all) {
              if (dirDests.has(item.t.path)) item.gitMade = true;
            }
            // History plus a plain edit still splits when the command is not opaque (round 3). An opaque command
            // splits only its parsed git mv / git rm targets (rule 7, C5). `git rm` is git-made but not history (C10).
            const split = !sm.gitOnly && ((sm.hasHistoryGitOp && !sm.opaque) || all.some((x) => x.gitMade));
            for (const gitOp of split ? [true, false] : [sm.gitOnly]) {
              const files = all.filter((x) => (split ? x.gitMade === gitOp : true)).map((x) => x.t);
              if (files.length > 0) groups.push({ files, gitOp });
            }
            touches = all.map((x) => x.t);
            if (groups.some((g) => !g.gitOp)) use.prompt.shellHeuristic = true;
          }
          for (const g of groups) {
            const seqAt = g.gitOp ? seq : orderedSeq(seq, sm.order);
            const doc = g.files.every((t) => isDocPath(t.path));
            use.prompt.edits.push({ seq: seqAt, files: g.files, gitOp: g.gitOp, doc, scratch: !doc && g.files.every((t) => t.cls !== "code"), thread: use.thread });
          }
        }
        if (groups.length === 0 && touches.length > 0) {
          const doc = touches.every((t) => isDocPath(t.path));
          use.prompt.edits.push({ seq, files: touches, gitOp: false, doc, scratch: !doc && touches.every((t) => t.cls !== "code"), thread: use.thread });
        }
        if (touches.length > 0 && act) act.edits = touches.map((t) => ({ path: t.path, kind: t.kind, added: t.added, removed: t.removed }));
        return;
      }
    }
  }

  /** Feeds a run of buffered events: the part before the first prompt as is, each prompt merged with its subagents. */
  function processBuffered(events: readonly Event[]): void {
    let start = 0;
    const ctx: MergeContext = { subagents, used, descriptions: agentDescriptions };
    planContinuations(events, ctx);
    for (let i = 0; i <= events.length; i++) {
      if (i < events.length && (events[i]!.type !== "prompt" || i === start)) continue;
      const segment = events.slice(start, i);
      start = i;
      if (segment.length === 0) continue;
      if (segment[0]!.type !== "prompt") {
        for (const ev of segment) onEvent(ev);
        continue;
      }
      const merged = mergeSubagents(segment, ctx);
      for (const ev of merged.events) onEvent(ev);
      if (cur !== null) {
        cur.flags = merged.flags;
        cur.partial = merged.flags.missing || merged.flags.depth;
      }
    }
  }

  /** Processes everything buffered; after this, subagents can no longer be added. */
  function ensureProcessed(): void {
    if (processed) return;
    processed = true;
    const events = buf;
    buf = [];
    bufChars = 0;
    processBuffered(events);
  }

  function accept(ev: Event): void {
    if (!deferred && ev.type === "prompt") {
      if (!bufHasAgent) {
        // No `Agent` call in the prompt before: nothing can be merged into it, so stream it.
        const events = buf;
        buf = [];
        bufChars = 0;
        processBuffered(events);
      } else deferred = true;
    }
    if (ev.type === "tool_use" && ev.name === "Agent") bufHasAgent = true;
    bufChars += 64 + textWeight(ev);
    buf.push(ev);
  }

  function byLabel(thread: string): string {
    const d = oneLine(agentDescriptions.get(thread) ?? "", 60);
    return d === "" ? `agent ${thread}` : d;
  }

  const self: Analyzer = {
    push(line: string): void {
      if (processed) return;
      try {
        for (const ev of parser.push(line)) accept(ev);
      } catch {
        // Never throws on odd input; the parser already reports what it can.
      }
    },

    addSubagent(toolUseId, transcript, meta): void {
      if (processed) return;
      if (typeof (transcript as SubagentTranscript).agentId === "string" && Array.isArray((transcript as SubagentTranscript).events)) {
        subagents.set(toolUseId, transcript as SubagentTranscript);
        return;
      }
      const c = createSubagentCollector({ detail, ...(meta?.agentId !== undefined ? { agentId: meta.agentId } : {}), ...(meta?.description !== undefined ? { description: meta.description } : {}) });
      for (const l of transcript as Iterable<string>) c.push(l);
      subagents.set(toolUseId, c.finish());
    },

    finish(): SessionAnalysis {
      if (result) return result;
      ensureProcessed();
      const { warnings: parserWarnings } = parser.finish();
      const warnings: Warning[] = parserWarnings.slice();
      const unmatched = [...subagents.entries()].filter(([id]) => !used.has(id)).map(([, tr]) => tr.agentId);
      unmatched.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const agentId of unmatched) {
        const reason = `unmatched subagent ${agentId}`;
        warnings.push(opts.file !== undefined ? { file: opts.file, line: 0, reason } : { line: 0, reason });
      }
      const meta = parser.meta();
      const out: PromptAnalysis[] = prompts.map((p) => {
        const j = judge(p, byLabel);
        const hints = computeHints({ edits: evidenceOf(p), lastCheckSeq: lastCheckSeq(p), cwd: meta.cwd, outOfScope: j.outOfScope });
        return {
          index: p.index,
          uuid: p.uuid,
          text: p.text,
          status: j.status,
          reason: reasonOf(p, j.reason),
          files: aggregateFiles(p.edits),
          partial: p.partial,
          ...p.timing.result(p.checks.filter((c) => !c.ignored).length),
          hints,
          recommendation: recommend(hints, j.status),
        };
      });
      const first = prompts[0];
      result = {
        sessionId: opts.sessionId ?? meta.sessionId ?? "unknown",
        title: opts.title ?? meta.title ?? (first ? oneLine(first.text, TITLE_MAX) : ""),
        branch: meta.branch ?? "unknown",
        startedAt: meta.startedAt,
        prompts: out,
        warnings,
      };
      return result;
    },

    details(): PromptDetail[] {
      if (!detail) return [];
      if (detailCache) return detailCache;
      const analysis = self.finish();
      const cwd = parser.meta().cwd;
      detailCache = prompts.map((p): PromptDetail => {
        const a = analysis.prompts[p.index]!;
        const { steps, truncated } = buildSteps(p.actions, cwd);
        return {
          index: p.index,
          text: p.text,
          status: a.status,
          reason: a.reason,
          headline: a.headline,
          startedAt: p.startedAtMs === null ? null : new Date(p.startedAtMs).toISOString(),
          activeMs: a.activeMs,
          truncated: p.truncated || truncated,
          hints: a.hints,
          recommendation: a.recommendation,
          steps,
        };
      });
      return detailCache;
    },

    diffFor(promptIndex: number, path: string): FileDiff | null {
      if (!detail) return null;
      ensureProcessed();
      const p = Number.isInteger(promptIndex) ? prompts[promptIndex] : undefined;
      if (!p) return null;
      let files = filesCache.get(p.index);
      if (!files) {
        files = aggregateFiles(p.edits);
        filesCache.set(p.index, files);
      }
      const fc = files.find((f) => f.path === path);
      if (!fc) return null;
      const patches: (RawPatch | undefined)[] = [];
      for (const e of p.edits) for (const t of e.files) if (t.path === path) patches.push(t.patch);
      return buildFileDiff(path, fc.kind, fc.maybeIncomplete, patches);
    },

    detailBytes(): number {
      return detail ? (detailChars + bufChars) * 2 : 0;
    },
  };
  return self;
}

export function analyzeSession(lines: Iterable<string>, opts: AnalyzeOptions = {}): SessionAnalysis {
  const a = createAnalyzer(opts);
  for (const l of lines) a.push(l);
  return a.finish();
}
