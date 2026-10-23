import { classifyCommand, type RepoScripts } from "./check-patterns.js";
import { buildFileDiff, capPatch, DIFF_LINES_MAX, patchChars, patchLines, type RawPatch } from "./diff.js";
import { computeHints, emptyStats, recommend, type EditEvidence, type EditStats } from "./hints.js";
import { createParser, type Event, type ToolInput, type ToolResultEvent } from "./parse.js";
import { ACTIONS_MAX, buildSteps, failureExcerpt, kindOf, oneLine, QUOTES_PER_STEP, type ActionRec } from "./steps.js";
import { actionPhase, createTimingTracker, parseTs, type TimingTracker } from "./timing.js";
import type { FileChange, FileDiff, PromptAnalysis, PromptDetail, SessionAnalysis, Status } from "./schema.js";

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
}

export interface Analyzer {
  push(line: string): void;
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
  /** Position in the event stream when the edit result arrived. */
  seq: number;
  files: FileTouch[];
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
  output: string;
}

interface PromptState {
  index: number;
  uuid: string;
  text: string;
  edits: EditRec[];
  checks: CheckRec[];
  partial: boolean;
  timing: TimingTracker;
  /** The last completed check failed: work now counts as Fix. */
  failing: boolean;
  /** Detail mode. */
  startedAtMs: number | null;
  actions: ActionRec[];
  quoteBuf: string[];
  truncated: boolean;
  /** Retained diff lines per file path. */
  patchLines: Map<string, number>;
}

interface PendingUse {
  prompt: PromptState;
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

function failureOutput(output: string): string {
  return oneLine(output.replace(/^\s*(?:Error:\s*)?Exit code \d+/, ""), FAIL_OUTPUT_MAX);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function judge(p: PromptState): { status: Status; reason: string } {
  if (p.edits.length === 0) return { status: "no-changes", reason: "no edits" };
  const lastEdit = p.edits.reduce((m, e) => Math.max(m, e.seq), -1);
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
    if (lastCompleted.exit === 0) {
      const note = lastCompleted.unreliable ? " (exit code may be masked by a pipe or trailing command)" : "";
      return { status: "checked", reason: `${lastCompleted.label} passed after last edit${note}` };
    }
    const out = failureOutput(lastCompleted.output);
    return {
      status: "failing",
      reason: out === "" ? `${lastCompleted.label} failed (exit ${lastCompleted.exit})` : `${lastCompleted.label} failed: ${out}`,
    };
  }

  if (lastCompleted === null) return { status: "unchecked", reason: "no checks ran" };
  const after = p.edits.filter((e) => e.seq > lastCompleted.resultSeq).length;
  return { status: "unchecked", reason: `${plural(after, "edit")} after last check` };
}

export function createAnalyzer(opts: AnalyzeOptions = {}): Analyzer {
  const parser = createParser({ ...(opts.file !== undefined ? { file: opts.file } : {}), detail: opts.detail === true });
  const prompts: PromptState[] = [];
  const pending = new Map<string, PendingUse>();
  let cur: PromptState | null = null;
  let seq = 0;
  /** Timestamp of the last event; events without one inherit it. */
  let lastTs: number | null = null;
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

  function onEvent(ev: Event): void {
    if (ev.type === "text") {
      // Agent text only feeds the quotes: it must not move the sequence or the timing clock.
      if (cur !== null) {
        cur.quoteBuf.push(ev.text);
        if (cur.quoteBuf.length > QUOTES_PER_STEP) cur.quoteBuf.shift();
      }
      return;
    }
    seq++;
    const prevTs = lastTs;
    let ts = lastTs;
    if (ev.type !== "boundary") {
      ts = parseTs(ev.ts) ?? lastTs;
      lastTs = ts;
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
          timing: createTimingTracker(),
          failing: false,
          startedAtMs: parseTs(ev.ts),
          actions: [],
          quoteBuf: [],
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
        if (ev.name === "Agent") cur.partial = true;
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
              output: "",
            };
            cur.checks.push(check);
          }
        }
        let action: ActionRec | null = null;
        if (detail) {
          if (cur.actions.length >= ACTIONS_MAX || totalActions >= DETAIL_ACTIONS_MAX) cur.truncated = true;
          else {
            const kind = kindOf(ev.name, check !== null);
            action = {
              tool: ev.name,
              kind,
              target: oneLine(ev.input.command ?? ev.input.filePath ?? ev.input.hint ?? "", 200),
              done: false,
              ok: false,
              phase: actionPhase(ev.name, { isCheck: check !== null, edited: false }, cur.failing),
              prevTs,
              useTs: ts,
              resTs: null,
              quotes: cur.quoteBuf,
              check:
                check === null
                  ? null
                  : { command: ev.input.command ?? "", label: check.label, exitCode: null, passed: null, excerpt: "", notRun: false },
              edits: [],
            };
            cur.quoteBuf = [];
            cur.actions.push(action);
            totalActions++;
            detailChars += 200 + action.target.length + action.quotes.reduce((n, q) => n + q.length, 0);
          }
        }
        pending.set(ev.id, { prompt: cur, name: ev.name, input: ev.input, check, prevTs, useTs: ts, failing: cur.failing, action });
        return;
      }
      case "tool_result": {
        const use = pending.get(ev.toolUseId);
        if (!use) return;
        pending.delete(ev.toolUseId);
        if (use.check) {
          if (ev.isError) {
            if (ev.exitCode === undefined) use.check.ignored = true;
            else {
              use.check.completed = true;
              use.check.exit = ev.exitCode;
              use.check.resultSeq = seq;
              use.check.output = ev.text;
              use.prompt.failing = ev.exitCode !== 0;
            }
          } else if (!ev.background) {
            use.check.completed = true;
            use.check.exit = 0;
            use.check.resultSeq = seq;
            use.prompt.failing = false;
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
            act.check = {
              command: use.input.command ?? "",
              label: use.check.label,
              exitCode,
              passed: exitCode === null ? null : exitCode === 0,
              excerpt: ev.isError ? (exitCode === null ? oneLine(ev.text, 200) : failureExcerpt(ev.text)) : "",
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
        } else if (use.name === "Bash" && ev.bashEditDiff && ev.bashEditDiff.length > 0) {
          touches = ev.bashEditDiff.map((f) => {
            const t: FileTouch = {
              path: f.path,
              kind: f.kind,
              added: f.added,
              removed: f.removed,
              maybeIncomplete: f.maybeIncomplete,
              inFix: phase === "fix",
              stats: f.stats,
            };
            if (detail) t.patch = retain(use.prompt, f.path, f.patch);
            return t;
          });
        }
        if (touches.length > 0) {
          use.prompt.edits.push({ seq, files: touches });
          if (act) act.edits = touches.map((t) => ({ path: t.path, kind: t.kind, added: t.added, removed: t.removed }));
        }
        return;
      }
    }
  }

  const self: Analyzer = {
    push(line: string): void {
      try {
        for (const ev of parser.push(line)) onEvent(ev);
      } catch {
        // Never throws on odd input; the parser already reports what it can.
      }
    },

    finish(): SessionAnalysis {
      if (result) return result;
      const { warnings } = parser.finish();
      const meta = parser.meta();
      const out: PromptAnalysis[] = prompts.map((p) => {
        const j = judge(p);
        const hints = computeHints({ edits: evidenceOf(p), lastCheckSeq: lastCheckSeq(p), cwd: meta.cwd });
        return {
          index: p.index,
          uuid: p.uuid,
          text: p.text,
          status: j.status,
          reason: p.partial ? `${j.reason}; subagent activity not analysed` : j.reason,
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
      return detail ? detailChars * 2 : 0;
    },
  };
  return self;
}

export function analyzeSession(lines: Iterable<string>, opts: AnalyzeOptions = {}): SessionAnalysis {
  const a = createAnalyzer(opts);
  for (const l of lines) a.push(l);
  return a.finish();
}
