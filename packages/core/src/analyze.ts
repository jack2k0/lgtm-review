import { classifyCommand, type RepoScripts } from "./check-patterns.js";
import { createParser, type Event, type ToolInput, type ToolResultEvent } from "./parse.js";
import type { FileChange, PromptAnalysis, SessionAnalysis, Status } from "./schema.js";

export interface AnalyzeOptions {
  repo?: RepoScripts;
  /** Overrides the title taken from the log. */
  title?: string;
  /** Session id used when set (e.g. from the file name); otherwise the one found in the log. */
  sessionId?: string;
  /** File name attached to warnings. */
  file?: string;
}

export interface Analyzer {
  push(line: string): void;
  finish(): SessionAnalysis;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const TITLE_MAX = 60;
const FAIL_OUTPUT_MAX = 200;

interface FileTouch {
  path: string;
  kind: "M" | "A" | "D";
  added: number;
  removed: number;
  maybeIncomplete: boolean;
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
}

interface PendingUse {
  prompt: PromptState;
  name: string;
  input: ToolInput;
  check: CheckRec | null;
}

function editTouch(use: PendingUse, res: ToolResultEvent): FileTouch | null {
  const path = use.input.filePath;
  if (path === undefined) return null;
  const isWrite = use.name === "Write";
  if (isWrite && res.resultType === "create") {
    return { path, kind: "A", added: res.createLines ?? use.input.contentLines ?? 0, removed: 0, maybeIncomplete: false };
  }
  if (res.structuredPatch) {
    return { path, kind: "M", added: res.structuredPatch.added, removed: res.structuredPatch.removed, maybeIncomplete: false };
  }
  if (isWrite) {
    // No create marker and no patch: whole-file write of unknown previous content.
    return { path, kind: "M", added: use.input.contentLines ?? 0, removed: 0, maybeIncomplete: true };
  }
  return { path, kind: "M", added: 0, removed: 0, maybeIncomplete: true };
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

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
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
  const parser = createParser(opts.file !== undefined ? { file: opts.file } : {});
  const prompts: PromptState[] = [];
  const pending = new Map<string, PendingUse>();
  let cur: PromptState | null = null;
  let seq = 0;
  let result: SessionAnalysis | null = null;

  function onEvent(ev: Event): void {
    seq++;
    switch (ev.type) {
      case "prompt": {
        cur = { index: prompts.length, uuid: ev.uuid, text: ev.text, edits: [], checks: [], partial: false };
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
        pending.set(ev.id, { prompt: cur, name: ev.name, input: ev.input, check });
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
            }
          } else if (!ev.background) {
            use.check.completed = true;
            use.check.exit = 0;
            use.check.resultSeq = seq;
          }
        }
        if (ev.isError) return;
        if (EDIT_TOOLS.has(use.name)) {
          const t = editTouch(use, ev);
          if (t) use.prompt.edits.push({ seq, files: [t] });
        } else if (use.name === "Bash" && ev.bashEditDiff && ev.bashEditDiff.length > 0) {
          use.prompt.edits.push({ seq, files: ev.bashEditDiff.map((f) => ({ ...f })) });
        }
        return;
      }
    }
  }

  return {
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
        return {
          index: p.index,
          uuid: p.uuid,
          text: p.text,
          status: j.status,
          reason: p.partial ? `${j.reason}; subagent activity not analysed` : j.reason,
          files: aggregateFiles(p.edits),
          partial: p.partial,
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
  };
}

export function analyzeSession(lines: Iterable<string>, opts: AnalyzeOptions = {}): SessionAnalysis {
  const a = createAnalyzer(opts);
  for (const l of lines) a.push(l);
  return a.finish();
}
