import { classifyCommand, findMaskedFailure, type RepoScripts } from "./check-patterns.js";
import { classifyShellMutation, resolveTarget } from "./shell-edits.js";
import { buildFileDiff, capPatch, DIFF_LINES_MAX, patchChars, patchLines, type RawPatch } from "./diff.js";
import { computeHints, emptyStats, recommend, type EditEvidence, type EditStats } from "./hints.js";
import { createParser, type Event, type ToolInput, type ToolResultEvent } from "./parse.js";
import { ACTIONS_MAX, buildSteps, failureExcerpt, kindOf, oneLine, QUOTES_PER_STEP, type ActionRec } from "./steps.js";
import { actionPhase, createTimingTracker, parseTs, type TimingTracker } from "./timing.js";
import { createSubagentCollector, emptyFlags, mergeSubagents, textWeight, type MergeContext, type MergeFlags, type SubagentTranscript } from "./subagents.js";
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
const TITLE_MAX = 60;
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
  /** Agent id of the subagent that made the edit; `""` for the parent thread. */
  thread: string;
}

interface CheckRec {
  useSeq: number;
  resultSeq: number;
  completed: boolean;
  /** The command did not run (tool error without an exit code): not a check outcome at all. */
  ignored: boolean;
  exit: number;
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
  /** Timestamps (ms) of the previous event and of this tool_use; null when unknown. */
  prevTs: number | null;
  useTs: number | null;
  /** The prompt was in the failing state when the call started. */
  failing: boolean;
  action: ActionRec | null;
}

function editTouch(use: PendingUse, res: ToolResultEvent, inFix: boolean): FileTouch | null {
  const path = use.input.filePath;
  if (path === undefined) return null;
  const isWrite = use.name === "Write";
  // A written file without patch counts the written content as added (nothing is known about the old one).
  const stats = res.stats ?? (isWrite ? use.input.contentStats : undefined) ?? emptyStats();
  if (isWrite && res.resultType === "create") {
    return { path, kind: "A", added: res.createLines ?? use.input.contentLines ?? 0, removed: 0, maybeIncomplete: false, inFix, stats };
  }
  if (res.structuredPatch) {
    return { path, kind: "M", added: res.structuredPatch.added, removed: res.structuredPatch.removed, maybeIncomplete: false, inFix, stats };
  }
  if (isWrite) {
    // No create marker and no patch: whole-file write of unknown previous content.
    return { path, kind: "M", added: use.input.contentLines ?? 0, removed: 0, maybeIncomplete: true, inFix, stats };
  }
  return { path, kind: "M", added: 0, removed: 0, maybeIncomplete: true, inFix, stats };
}

/** Sequence number at which the last completed (non-ignored) check finished; null when none did. */
function lastCheckSeq(p: PromptState): number | null {
  let last: number | null = null;
  for (const c of p.checks) if (!c.ignored && c.completed && (last === null || c.resultSeq > last)) last = c.resultSeq;
  return last;
}

function evidenceOf(p: PromptState): EditEvidence[] {
  const out: EditEvidence[] = [];
  for (const e of p.edits) {
    if (e.gitOp) continue;
    for (const t of e.files) out.push({ seq: e.seq, path: t.path, inFix: t.inFix, changed: t.added + t.removed, stats: t.stats });
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

function judge(p: PromptState, by: (thread: string) => string): { status: Status; reason: string } {
  const via = (thread: string): string => (thread === "" ? "" : ` (by subagent ${by(thread)})`);
  if (p.edits.length === 0) return { status: "no-changes", reason: "no edits" };
  // Git operations (merge, rebase, checkout, ...) bring in other people's changes: they never move the status.
  const edits = p.edits.filter((e) => !e.gitOp);
  if (edits.length === 0) return { status: "no-changes", reason: "no edits (git operations only)" };
  const lastEdit = edits.reduce((m, e) => Math.max(m, e.seq), -1);
  const real = p.checks.filter((c) => !c.ignored);
  const completed = real.filter((c) => c.completed);
  const lastCompleted = completed.reduce<CheckRec | null>(
    (m, c) => (m === null || c.resultSeq > m.resultSeq ? c : m),
    null,
  );

  const incompleteAfter = real.some(
    (c) => !c.completed && c.useSeq > lastEdit && (lastCompleted === null || c.useSeq > lastCompleted.resultSeq),
  );
  if (incompleteAfter) return { status: "unchecked", reason: "check did not complete" };

  if (lastCompleted !== null && lastCompleted.resultSeq > lastEdit) {
    if (lastCompleted.masked) {
      return { status: "failing", reason: `${lastCompleted.label} output indicates failures (exit code masked)${via(lastCompleted.thread)}` };
    }
    if (lastCompleted.exit === 0) {
      const note = lastCompleted.probe ? " (edits may have been reverted)" : lastCompleted.unreliable ? " (exit code not verified)" : "";
      return { status: "checked", reason: `${lastCompleted.label} passed after last edit${note}${via(lastCompleted.thread)}` };
    }
    const out = failureOutput(lastCompleted.output);
    return {
      status: "failing",
      reason: (out === "" ? `${lastCompleted.label} failed (exit ${lastCompleted.exit})` : `${lastCompleted.label} failed: ${out}`) + via(lastCompleted.thread),
    };
  }

  if (lastCompleted === null) return { status: "unchecked", reason: "no checks ran" };
  const afterEdits = edits.filter((e) => e.seq > lastCompleted.resultSeq);
  if (afterEdits.length === 0) return { status: "unchecked", reason: "edit in the same command as the last check" };
  const latest = afterEdits.reduce((m, e) => (e.seq > m.seq ? e : m));
  return { status: "unchecked", reason: `${plural(afterEdits.length, "edit")} after last check${via(latest.thread)}` };
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
              completed: false,
              ignored: false,
              exit: 0,
              label: cls.label,
              unreliable: cls.unreliable,
              probe: cls.mutationProbe,
              masked: false,
              maskedLine: "",
              output: "",
              thread,
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
        pending.set(pendingKey(thread, ev.id), { prompt: cur, thread, name: ev.name, input: ev.input, check, prevTs, useTs: ts, failing: cur.failing.has(thread), action });
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
            else {
              use.check.completed = true;
              use.check.exit = ev.exitCode;
              use.check.resultSeq = seq;
              use.check.output = ev.text;
              setFailing(use.prompt, use.thread, ev.exitCode !== 0);
            }
          } else if (!ev.background) {
            use.check.completed = true;
            use.check.exit = 0;
            use.check.resultSeq = seq;
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
            const exitCode = ev.isError ? (ev.exitCode ?? null) : ev.background ? null : 0;
            const masked = use.check.masked;
            act.check = {
              command: use.input.command ?? "",
              label: use.check.label,
              exitCode,
              passed: exitCode === null ? null : exitCode === 0 && !masked,
              excerpt: ev.isError ? (exitCode === null ? oneLine(ev.text, 200) : failureExcerpt(ev.text)) : masked ? oneLine(use.check.maskedLine, 200) : "",
              notRun: ev.isError && ev.exitCode === undefined,
            };
          }
        }
        if (ev.isError) return;
        let touches: FileTouch[] = [];
        if (EDIT_TOOLS.has(use.name)) {
          const t = editTouch(use, ev, phase === "fix");
          if (t) {
            if (detail) t.patch = retain(use.prompt, t.path, t.kind === "A" ? ev.createPatch : ev.patch);
            touches = [t];
          }
        }
        let gitOp = false;
        let seqAt = seq;
        if (use.name === "Bash" && use.input.command !== undefined && (ev.bashEditDiff === undefined || ev.bashEditDiff.length > 0)) {
          const sm = classifyShellMutation(use.input.command, opts.repo);
          if (ev.bashEditDiff !== undefined) {
            gitOp = sm.gitOnly;
            if (!gitOp) seqAt = orderedSeq(seq, sm.order);
            touches = ev.bashEditDiff.map((f) => {
              const t: FileTouch = {
                path: f.path,
                kind: f.kind,
                added: f.added,
                removed: f.removed,
                maybeIncomplete: f.maybeIncomplete || gitOp,
                inFix: phase === "fix",
                stats: f.stats,
              };
              if (detail) t.patch = retain(use.prompt, f.path, f.patch);
              return t;
            });
          } else if (sm.edits.length > 0) {
            // No diff in the log (the session did not start inside the repo): count what the command text says.
            gitOp = sm.gitOnly;
            if (!gitOp) seqAt = orderedSeq(seq, sm.order);
            const cwd = parser.meta().cwd;
            touches = sm.edits.map((e) => ({
              path: resolveTarget(e.file, cwd, sm.hasCd),
              kind: "M" as const,
              added: 0,
              removed: 0,
              maybeIncomplete: true,
              inFix: use.failing,
              stats: emptyStats(),
            }));
            if (!gitOp) use.prompt.shellHeuristic = true;
          }
        }
        if (touches.length > 0) {
          use.prompt.edits.push({ seq: seqAt, files: touches, gitOp, thread: use.thread });
          if (act) act.edits = touches.map((t) => ({ path: t.path, kind: t.kind, added: t.added, removed: t.removed }));
        }
        return;
      }
    }
  }

  /** Feeds a run of buffered events: the part before the first prompt as is, each prompt merged with its subagents. */
  function processBuffered(events: readonly Event[]): void {
    let start = 0;
    const ctx: MergeContext = { subagents, used, descriptions: agentDescriptions };
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
        const hints = computeHints({ edits: evidenceOf(p), lastCheckSeq: lastCheckSeq(p), cwd: meta.cwd });
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
