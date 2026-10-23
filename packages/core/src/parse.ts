import { createPatch, extractPatch, type RawPatch } from "./diff.js";
import { emptyStats, EVIDENCE_LINES_MAX, scanContent, scanDiffLines, type EditStats } from "./hints.js";
import type { Warning } from "./schema.js";

/**
 * Tolerant, push-based normalizer of Claude Code session log lines into a small event stream.
 * Never throws; unknown or broken records become warnings or are skipped silently.
 * Only truncated fields are kept (never `originalFile`, full `content`, full tool output).
 */

export const PROMPT_TEXT_MAX = 200;
const RESULT_TEXT_MAX = 500;
/** Tail of a result kept for the masked-exit inspection. */
export const RESULT_TAIL_MAX = 4096;
const COMMAND_MAX = 4000;
const PATH_MAX = 1000;
const MAX_WARNINGS = 1000;
/** Detail mode: longest retained agent text block and tool-call hint. */
export const QUOTE_MAX = 400;
export const HINT_MAX = 200;
/** Detail mode: lines retained from the bash edits of one tool result (all files together). */
const BASH_EDIT_LINES_MAX = 10_000;

export interface ToolInput {
  command?: string;
  filePath?: string;
  /** Number of lines of `content` (Write only). */
  contentLines?: number;
  /** Assertion and skip-marker counters of the written content (Write only; first 2000 lines). */
  contentStats?: EditStats;
  /** Detail mode only: pattern, url, query, description or directory of the call (<= 200 chars). */
  hint?: string;
}

export interface BashEdit {
  path: string;
  kind: "M" | "A" | "D";
  added: number;
  removed: number;
  maybeIncomplete: boolean;
  /** Assertion and skip-marker counters of the recorded hunks (first 2000 lines). */
  stats: EditStats;
  /** Detail mode only: the recorded hunks (capped); absent when the log has none. */
  patch?: RawPatch;
}

export type PromptEvent = { type: "prompt"; uuid: string; text: string; ts: string | null; line: number };
/** `ts` is the raw record timestamp (ISO string) or null when the record has none. */
export type ToolUseEvent = {
  type: "tool_use";
  id: string;
  name: string;
  input: ToolInput;
  ts: string | null;
  line: number;
  /** Set for events of a subagent transcript (sidechain parser): the subagent's id. */
  agentId?: string;
  /** Set by the subagent merge on an `Agent` call: a transcript was merged, is missing, or lies deeper than the depth limit. */
  subagent?: "found" | "missing" | "depth";
};
export type ToolResultEvent = {
  type: "tool_result";
  toolUseId: string;
  isError: boolean;
  /** First 500 characters of the textual output. */
  text: string;
  /** Set when `isError` and the text starts with "Exit code N". */
  exitCode?: number;
  resultType?: "create" | "update";
  structuredPatch?: { added: number; removed: number };
  createLines?: number;
  /** Assertion and skip-marker counters of the patch, or of the created content (first 2000 lines). */
  stats?: EditStats;
  /** Detail mode only: capped hunks of `structuredPatch` (Edit/MultiEdit/Write update). */
  patch?: RawPatch;
  /** Detail mode only: synthetic all-`+` hunk of the content of a created file. */
  createPatch?: RawPatch;
  bashEditDiff?: BashEdit[];
  /** The command was started in the background; the exit code is unknown. */
  background: boolean;
  /** Id of the background task (`toolUseResult.backgroundTaskId`), when the command was started in the background. */
  backgroundTaskId?: string;
  /** Last ~4 KB of the result text; only set when the result is longer than `text` (which keeps the head). */
  tail?: string;
  /** Raw record timestamp (ISO string) or null when the record has none. */
  ts: string | null;
  line: number;
  /** Set for events of a subagent transcript (sidechain parser): the subagent's id. */
  agentId?: string;
};
/**
 * Outcome notification of a background task (`<task-notification>` block in a user record). It is not a prompt.
 * `status` is lowercased (`""` when absent); `exitCode` is taken from the free-text summary ("... exit code N").
 * Matching to a check happens in the analyzer (by `toolUseId`, else `taskId`); sequence numbers are assigned there.
 */
export type TaskNotificationEvent = {
  type: "task-notification";
  taskId?: string;
  toolUseId?: string;
  status: string;
  exitCode: number | null;
  ts: string | null;
  line: number;
};
export type BoundaryEvent = { type: "boundary"; kind: "compact" | "interrupt" };
/** Detail mode only: an agent text block (first 400 characters). */
export type TextEvent = { type: "text"; text: string; agentId?: string };
export type Event = PromptEvent | ToolUseEvent | ToolResultEvent | BoundaryEvent | TextEvent | TaskNotificationEvent;

export interface ParserMeta {
  sessionId: string | null;
  branch: string | null;
  startedAt: string | null;
  title: string | null;
  cwd: string | null;
}

export interface ParserOptions {
  file?: string;
  /** Opt-in retention of hunks, agent text and call hints for the steps and diff views. */
  detail?: boolean;
  /**
   * Parse a subagent transcript (`<session>/subagents/agent-<id>.jsonl`): its records are the main thread
   * (`isSidechain` is expected, not skipped), no prompts or boundaries are emitted (the first user record is the
   * task the parent gave the subagent, not a human prompt), and tool_use/tool_result/text events carry the agent id.
   */
  sidechain?: boolean;
  /** Agent id used for events whose record has no `agentId` (sidechain only). */
  agentId?: string;
}

export interface Parser {
  /** Feed one line; returns the events it produced (usually 0 or 1). */
  push(line: string): Event[];
  /** Flush pending state and return all warnings in a deterministic order. */
  finish(): { warnings: Warning[] };
  meta(): ParserMeta;
}

/** Heavy metadata records skipped before JSON.parse. */
const SKIP_EARLY = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "file-history-snapshot",
  "file-history-delta",
  "attachment",
  "queue-operation",
]);

/** Known metadata types that are ignored without a warning (spike section 10). */
const KNOWN_SILENT = new Set([
  ...SKIP_EARLY,
  "mode",
  "last-prompt",
  "atis-latch",
  "bridge-session",
  "cost-state",
  "permission-mode",
  "agent-setting",
  "continued-in",
]);

const NON_PROMPT_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command",
  "<task-notification",
  "<system-reminder",
  "[Request interrupted",
];

const TYPE_PEEK = /^\s*\{\s*"type"\s*:\s*"([^"\\]{1,40})"/;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function nonEmptyStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function countLines(s: string): number {
  if (s === "") return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  if (s.charCodeAt(s.length - 1) === 10) n--;
  return n;
}

function countDiffLines(lines: unknown): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (Array.isArray(lines)) {
    for (const l of lines) {
      if (typeof l !== "string") continue;
      const c = l.charCodeAt(0);
      if (c === 43) added++; // "+"
      else if (c === 45) removed++; // "-"
    }
  }
  return { added, removed };
}

/** Text of a message `content` (string, or list of text blocks), truncated to `max`. */
function blocksText(content: unknown, max: number, sep: string): string {
  if (typeof content === "string") return truncate(content, max);
  if (!Array.isArray(content)) return "";
  let out = "";
  let first = true;
  for (const b of content) {
    if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") continue;
    out += (first ? "" : sep) + b.text;
    first = false;
    if (out.length >= max) break;
  }
  return truncate(out, max);
}

/** Last `max` characters of a message `content` (string, or list of text blocks). */
function blocksTail(content: unknown, max: number): string {
  if (typeof content === "string") return content.length > max ? content.slice(content.length - max) : content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) if (isObj(b) && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  const all = parts.join("\n");
  return all.length > max ? all.slice(all.length - max) : all;
}

/**
 * Slash commands that never start a unit of work (session management, settings, help).
 * Every other command (including skills and custom commands) opens a prompt.
 */
const SKIPPED_COMMANDS = new Set([
  "clear", "compact", "model", "help", "status", "config", "login", "logout", "cost", "context", "resume", "exit",
  "ide", "permissions", "mcp", "memory", "hooks", "doctor", "terminal-setup", "statusline", "vim", "theme", "fast",
]);
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Prompt text of a slash-command turn (`/name args`), or null when the command is not "work"
 * (or the record is not a command record at all).
 */
function slashPromptText(raw: string): string | null {
  const name = COMMAND_NAME_RE.exec(raw)?.[1];
  if (name === undefined) return null;
  const args = (COMMAND_ARGS_RE.exec(raw)?.[1] ?? "").trim();
  const key = name.toLowerCase();
  if (SKIPPED_COMMANDS.has(key)) return null;
  if (key === "goal" && args.toLowerCase() === "clear") return null;
  const flat = args.replace(/\s+/g, " ");
  return truncate(flat === "" ? `/${name}` : `/${name} ${flat}`, PROMPT_TEXT_MAX);
}

function hintOf(input: Record<string, unknown>): string | undefined {
  for (const k of ["pattern", "url", "query", "description", "path"]) {
    const v = input[k];
    if (typeof v === "string" && v !== "") return truncate(v.replace(/\s+/g, " ").trim(), HINT_MAX);
  }
  return undefined;
}

function sanitizeInput(name: string, input: unknown, detail: boolean): ToolInput {
  const out: ToolInput = {};
  if (!isObj(input)) return out;
  if (name === "Bash") {
    const c = str(input.command);
    if (c !== undefined) out.command = truncate(c, COMMAND_MAX);
  }
  const p = str(input.file_path) ?? str(input.notebook_path);
  if (p !== undefined) out.filePath = truncate(p, PATH_MAX);
  if (name === "Write" && typeof input.content === "string") {
    out.contentLines = countLines(input.content);
    const stats = emptyStats();
    scanContent(input.content, stats);
    out.contentStats = stats;
  }
  if (detail) {
    const h = hintOf(input);
    if (h !== undefined) out.hint = h;
  }
  return out;
}

function parseBashEdits(diff: unknown, detail: boolean): BashEdit[] | undefined {
  if (!isObj(diff) || !Array.isArray(diff.files)) return undefined;
  const out: BashEdit[] = [];
  let linesLeft = BASH_EDIT_LINES_MAX;
  for (const f of diff.files) {
    if (!isObj(f)) continue;
    const path = str(f.filePath);
    if (path === undefined) continue;
    const hunks = Array.isArray(f.hunks) ? f.hunks.filter(isObj) : [];
    let added = 0;
    let removed = 0;
    const stats = emptyStats();
    const budget = { left: EVIDENCE_LINES_MAX };
    for (const h of hunks) {
      const c = countDiffLines(h.lines);
      added += c.added;
      removed += c.removed;
      if (Array.isArray(h.lines)) scanDiffLines(h.lines, stats, budget);
    }
    // Unified-diff convention: "+0,0" side means the file no longer exists, "-0,0" side that it is new.
    const deleted = hunks.length > 0 && hunks.every((h) => h.newStart === 0 && h.newLines === 0);
    const created = hunks.length > 0 && hunks.every((h) => h.oldStart === 0 && h.oldLines === 0);
    const edit: BashEdit = {
      path: truncate(path, PATH_MAX),
      kind: deleted ? "D" : created ? "A" : "M",
      added,
      removed,
      maybeIncomplete: hunks.length === 0,
      stats,
    };
    if (detail && hunks.length > 0) {
      const patch = extractPatch(hunks, Math.min(linesLeft, 2000));
      if (patch) {
        for (const h of patch.hunks) linesLeft -= h.lines.length;
        edit.patch = patch;
      }
    }
    out.push(edit);
  }
  return out;
}

/** `Exit code N` of a failed Bash call: the structured `toolUseResult` string first, the result text as fallback. */
function exitCodeOf(structured: string | undefined, text: string): number | undefined {
  const re = /^\s*(?:Error:\s*)?Exit code (\d+)/;
  const m = (structured !== undefined ? re.exec(structured) : null) ?? re.exec(text);
  if (!m || m[1] === undefined) return undefined;
  const n = Number(m[1]);
  // A failed call (`is_error`) cannot have succeeded: an "Exit code 0" there is noise, not an outcome.
  return n === 0 ? undefined : n;
}

const NOTIFICATION_SCAN_MAX = 200_000;
const NOTIFICATIONS_PER_RECORD_MAX = 20;
const NOTIFICATION_BLOCK_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const NOTIFICATION_EXIT_RE = /exit code:?\s*(\d+)/i;

function tagValue(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  const v = m?.[1]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/** `<task-notification>` blocks of a user message (string content or its text blocks); tags in any order, extras ignored. */
function notificationsOf(content: unknown, ts: string | null, line: number): TaskNotificationEvent[] {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const b of content) if (isObj(b) && b.type === "text" && typeof b.text === "string") text += (text === "" ? "" : "\n") + b.text;
  }
  if (text.length > NOTIFICATION_SCAN_MAX) text = text.slice(0, NOTIFICATION_SCAN_MAX);
  if (!text.includes("<task-notification>")) return [];
  const out: TaskNotificationEvent[] = [];
  for (const m of text.matchAll(NOTIFICATION_BLOCK_RE)) {
    if (out.length >= NOTIFICATIONS_PER_RECORD_MAX) break;
    const block = m[1] ?? "";
    const taskId = tagValue(block, "task-id");
    const toolUseId = tagValue(block, "tool-use-id");
    if (taskId === undefined && toolUseId === undefined) continue;
    const em = NOTIFICATION_EXIT_RE.exec(tagValue(block, "summary") ?? "");
    const ev: TaskNotificationEvent = {
      type: "task-notification",
      status: (tagValue(block, "status") ?? "").toLowerCase(),
      exitCode: em?.[1] !== undefined ? Number(em[1]) : null,
      ts,
      line,
    };
    if (taskId !== undefined) ev.taskId = taskId;
    if (toolUseId !== undefined) ev.toolUseId = toolUseId;
    out.push(ev);
  }
  return out;
}

export function createParser(opts: ParserOptions = {}): Parser {
  const detail = opts.detail === true;
  const sidechain = opts.sidechain === true;
  /** Agent id of the record being handled (sidechain only). */
  let agentTag: string | undefined;
  const warnings: Warning[] = [];
  let omitted = 0;
  let lineNo = 0;
  let pendingInvalid = 0; // line number of an unparsable line not yet known to be non-final
  let finished: Warning[] | null = null;
  const seen = new Set<string>();
  const unknown = new Map<string, { first: number; count: number }>();
  /** The last slash-command prompt, until the agent first answers. */
  let slash: { uuid: string | null; answered: boolean } | null = null;
  const meta: ParserMeta = { sessionId: null, branch: null, startedAt: null, title: null, cwd: null };

  function warn(line: number, reason: string): void {
    if (warnings.length >= MAX_WARNINGS) {
      omitted++;
      return;
    }
    warnings.push(opts.file !== undefined ? { file: opts.file, line, reason } : { line, reason });
  }

  function noteUnknown(type: string): void {
    const u = unknown.get(type);
    if (u) u.count++;
    else unknown.set(type, { first: lineNo, count: 1 });
  }

  function handleUser(rec: Record<string, unknown>, message: Record<string, unknown>, out: Event[]): void {
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter((b): b is Record<string, unknown> => isObj(b) && b.type === "tool_result");
    // Notifications are read before any non-prompt early return below (their records are meta, non-human or
    // sidechain). In a subagent transcript (`sidechain`) they are emitted too: matching is by id, not by thread.
    const notes = notificationsOf(content, nonEmptyStr(rec.timestamp) ?? null, lineNo);

    if (results.length > 0) {
      const tur = results.length === 1 && isObj(rec.toolUseResult) ? rec.toolUseResult : undefined;
      for (const b of results) {
        const id = nonEmptyStr(b.tool_use_id);
        if (id === undefined) {
          warn(lineNo, "tool_result without tool_use_id");
          continue;
        }
        const isError = b.is_error === true;
        const text = blocksText(b.content, RESULT_TEXT_MAX, "\n");
        const ev: ToolResultEvent = { type: "tool_result", toolUseId: id, isError, text, background: false, ts: nonEmptyStr(rec.timestamp) ?? null, line: lineNo };
        if (agentTag !== undefined) ev.agentId = agentTag;
        if (text.length >= RESULT_TEXT_MAX) {
          const tail = blocksTail(b.content, RESULT_TAIL_MAX);
          if (tail.length > 0) ev.tail = tail;
        }
        if (isError) {
          const code = exitCodeOf(results.length === 1 && typeof rec.toolUseResult === "string" ? rec.toolUseResult : undefined, text);
          if (code !== undefined) ev.exitCode = code;
        }
        if (tur) {
          if (tur.type === "create" || tur.type === "update") ev.resultType = tur.type;
          if (Array.isArray(tur.structuredPatch)) {
            let added = 0;
            let removed = 0;
            const stats = emptyStats();
            const budget = { left: EVIDENCE_LINES_MAX };
            for (const h of tur.structuredPatch) {
              if (!isObj(h)) continue;
              const c = countDiffLines(h.lines);
              added += c.added;
              removed += c.removed;
              if (Array.isArray(h.lines)) scanDiffLines(h.lines, stats, budget);
            }
            ev.structuredPatch = { added, removed };
            ev.stats = stats;
            if (detail) {
              const patch = extractPatch(tur.structuredPatch);
              if (patch) ev.patch = patch;
            }
          }
          if (tur.type === "create" && typeof tur.content === "string") {
            ev.createLines = countLines(tur.content);
            const stats = emptyStats();
            scanContent(tur.content, stats);
            ev.stats = stats;
            if (detail) ev.createPatch = createPatch(tur.content);
          }
          const be = parseBashEdits(tur.bashEditDiff, detail);
          if (be !== undefined) ev.bashEditDiff = be;
          if (tur.backgroundTaskId !== undefined && tur.backgroundTaskId !== null) {
            ev.background = true;
            const taskId = typeof tur.backgroundTaskId === "number" ? String(tur.backgroundTaskId) : nonEmptyStr(tur.backgroundTaskId);
            if (taskId !== undefined) ev.backgroundTaskId = taskId;
          }
        }
        out.push(ev);
      }
      for (const n of notes) out.push(n);
      return;
    }

    for (const n of notes) out.push(n);

    // A subagent transcript has no human prompts: its first user record is the task given by the parent.
    if (sidechain) return;
    if (rec.isMeta === true || rec.isCompactSummary === true) return;
    if (rec.scheduledTaskId !== undefined && rec.scheduledTaskId !== null) return;
    if (isObj(rec.origin)) {
      const k = rec.origin.kind;
      if (k !== undefined && k !== "human") return;
    }

    const head = (typeof content === "string" ? content : blocksText(content, 40, "")).trimStart();
    if (head.startsWith("<command-name>") || head.startsWith("<command-message>")) {
      const t = slashPromptText(blocksText(content, 4000, "\n"));
      if (t === null) return;
      slash = { uuid: nonEmptyStr(rec.uuid) ?? null, answered: false };
      out.push({ type: "prompt", uuid: nonEmptyStr(rec.uuid) ?? `line-${lineNo}`, text: t, ts: str(rec.timestamp) ?? null, line: lineNo });
      return;
    }
    // The expansion of a skill or command follows its command record before any agent output.
    if (slash !== null && !slash.answered && slash.uuid !== null && rec.parentUuid === slash.uuid) return;
    const text = blocksText(content, PROMPT_TEXT_MAX, "\n");
    if (head.startsWith("[Request interrupted")) {
      out.push({ type: "boundary", kind: "interrupt" });
      return;
    }
    if (NON_PROMPT_PREFIXES.some((p) => head.startsWith(p))) return;
    if (typeof content === "string" ? content.trim() === "" : blocks.length === 0) return;
    slash = null;
    out.push({
      type: "prompt",
      uuid: nonEmptyStr(rec.uuid) ?? `line-${lineNo}`,
      text,
      ts: str(rec.timestamp) ?? null,
      line: lineNo,
    });
  }

  function handleAssistant(rec: Record<string, unknown>, message: Record<string, unknown>, out: Event[]): void {
    if (slash !== null) slash.answered = true;
    if (!Array.isArray(message.content)) return;
    for (const b of message.content) {
      if (detail && isObj(b) && b.type === "text" && typeof b.text === "string") {
        const t = b.text.trim();
        if (t !== "") out.push(agentTag !== undefined ? { type: "text", text: truncate(t, QUOTE_MAX), agentId: agentTag } : { type: "text", text: truncate(t, QUOTE_MAX) });
        continue;
      }
      if (!isObj(b) || b.type !== "tool_use") continue;
      const id = nonEmptyStr(b.id);
      if (id === undefined) {
        warn(lineNo, "tool_use without id");
        continue;
      }
      const name = str(b.name) ?? "";
      const use: ToolUseEvent = { type: "tool_use", id, name, input: sanitizeInput(name, b.input, detail), ts: nonEmptyStr(rec.timestamp) ?? null, line: lineNo };
      if (agentTag !== undefined) use.agentId = agentTag;
      out.push(use);
    }
  }

  function handleMessageRecord(type: string, rec: Record<string, unknown>, out: Event[]): void {
    if (rec.isSidechain === true && !sidechain) return;
    if (sidechain) agentTag = nonEmptyStr(rec.agentId) ?? opts.agentId ?? "agent";
    const uuid = nonEmptyStr(rec.uuid);
    if (uuid !== undefined) {
      if (seen.has(uuid)) return;
      seen.add(uuid);
    }
    meta.sessionId ??= nonEmptyStr(rec.sessionId) ?? null;
    meta.branch ??= nonEmptyStr(rec.gitBranch) ?? null;
    meta.startedAt ??= nonEmptyStr(rec.timestamp) ?? null;
    meta.cwd ??= nonEmptyStr(rec.cwd) ?? null;

    if (type === "system") {
      if (rec.subtype === "compact_boundary" && !sidechain) out.push({ type: "boundary", kind: "compact" });
      return;
    }
    const message = rec.message;
    if (!isObj(message)) {
      warn(lineNo, `${type} record lacking message`);
      return;
    }
    if (type === "user") handleUser(rec, message, out);
    else handleAssistant(rec, message, out);
  }

  return {
    push(line: string): Event[] {
      lineNo++;
      const out: Event[] = [];
      try {
        if (typeof line !== "string" || line.trim() === "") return out;
        if (pendingInvalid) {
          warn(pendingInvalid, "invalid JSON");
          pendingInvalid = 0;
        }
        const peek = TYPE_PEEK.exec(line);
        if (peek && peek[1] !== undefined && SKIP_EARLY.has(peek[1])) return out;

        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          pendingInvalid = lineNo;
          return out;
        }
        if (!isObj(rec)) {
          warn(lineNo, "record is not a JSON object");
          return out;
        }
        const type = rec.type;
        if (typeof type !== "string") {
          noteUnknown("(missing)");
          return out;
        }
        if (type === "user" || type === "assistant" || type === "system") {
          handleMessageRecord(type, rec, out);
        } else if (type === "ai-title") {
          const t = nonEmptyStr(rec.aiTitle) ?? nonEmptyStr(rec.title);
          if (t !== undefined) meta.title = t;
        } else if (!KNOWN_SILENT.has(type)) {
          noteUnknown(truncate(type, 40));
        }
      } catch (e) {
        // Defensive: the parser must never throw on odd records.
        warn(lineNo, `unreadable record (${e instanceof Error ? e.message : "error"})`);
        return [];
      }
      return out;
    },

    finish(): { warnings: Warning[] } {
      if (finished) return { warnings: finished.slice() };
      if (pendingInvalid) {
        warn(pendingInvalid, "truncated last line");
        pendingInvalid = 0;
      }
      const types = [...unknown.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const t of types) {
        const u = unknown.get(t);
        if (u) warn(u.first, `unknown record type ${t} (${u.count} record${u.count === 1 ? "" : "s"})`);
      }
      unknown.clear();
      // Stable sort by line number keeps the output readable and deterministic.
      const result = warnings
        .map((w, i) => ({ w, i }))
        .sort((a, b) => a.w.line - b.w.line || a.i - b.i)
        .map((x) => x.w);
      if (omitted > 0) {
        const reason = `${omitted} further warning${omitted === 1 ? "" : "s"} omitted`;
        result.push(opts.file !== undefined ? { file: opts.file, line: 0, reason } : { line: 0, reason });
        omitted = 0;
      }
      finished = result;
      return { warnings: result.slice() };
    },

    meta(): ParserMeta {
      return { ...meta };
    },
  };
}

/** Convenience wrapper for tests and small inputs. */
export function parseLines(lines: Iterable<string>, opts: ParserOptions = {}): {
  events: Event[];
  warnings: Warning[];
  meta: ParserMeta;
} {
  const p = createParser(opts);
  const events: Event[] = [];
  for (const l of lines) for (const e of p.push(l)) events.push(e);
  const { warnings } = p.finish();
  return { events, warnings, meta: p.meta() };
}
