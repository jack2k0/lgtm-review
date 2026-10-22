import type { Warning } from "./schema.js";

/**
 * Tolerant, push-based normalizer of Claude Code session log lines into a small event stream.
 * Never throws; unknown or broken records become warnings or are skipped silently.
 * Only truncated fields are kept (never `originalFile`, full `content`, full tool output).
 */

export const PROMPT_TEXT_MAX = 200;
const RESULT_TEXT_MAX = 500;
const COMMAND_MAX = 4000;
const PATH_MAX = 1000;
const MAX_WARNINGS = 1000;

export interface ToolInput {
  command?: string;
  filePath?: string;
  /** Number of lines of `content` (Write only). */
  contentLines?: number;
}

export interface BashEdit {
  path: string;
  kind: "M" | "A" | "D";
  added: number;
  removed: number;
  maybeIncomplete: boolean;
}

export type PromptEvent = { type: "prompt"; uuid: string; text: string; ts: string | null; line: number };
/** `ts` is the raw record timestamp (ISO string) or null when the record has none. */
export type ToolUseEvent = { type: "tool_use"; id: string; name: string; input: ToolInput; ts: string | null; line: number };
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
  bashEditDiff?: BashEdit[];
  /** The command was started in the background; the exit code is unknown. */
  background: boolean;
  /** Raw record timestamp (ISO string) or null when the record has none. */
  ts: string | null;
  line: number;
};
export type BoundaryEvent = { type: "boundary"; kind: "compact" | "interrupt" };
export type Event = PromptEvent | ToolUseEvent | ToolResultEvent | BoundaryEvent;

export interface ParserMeta {
  sessionId: string | null;
  branch: string | null;
  startedAt: string | null;
  title: string | null;
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

function sanitizeInput(name: string, input: unknown): ToolInput {
  const out: ToolInput = {};
  if (!isObj(input)) return out;
  if (name === "Bash") {
    const c = str(input.command);
    if (c !== undefined) out.command = truncate(c, COMMAND_MAX);
  }
  const p = str(input.file_path) ?? str(input.notebook_path);
  if (p !== undefined) out.filePath = truncate(p, PATH_MAX);
  if (name === "Write" && typeof input.content === "string") out.contentLines = countLines(input.content);
  return out;
}

function parseBashEdits(diff: unknown): BashEdit[] | undefined {
  if (!isObj(diff) || !Array.isArray(diff.files)) return undefined;
  const out: BashEdit[] = [];
  for (const f of diff.files) {
    if (!isObj(f)) continue;
    const path = str(f.filePath);
    if (path === undefined) continue;
    const hunks = Array.isArray(f.hunks) ? f.hunks.filter(isObj) : [];
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      const c = countDiffLines(h.lines);
      added += c.added;
      removed += c.removed;
    }
    // Unified-diff convention: "+0,0" side means the file no longer exists, "-0,0" side that it is new.
    const deleted = hunks.length > 0 && hunks.every((h) => h.newStart === 0 && h.newLines === 0);
    const created = hunks.length > 0 && hunks.every((h) => h.oldStart === 0 && h.oldLines === 0);
    out.push({
      path: truncate(path, PATH_MAX),
      kind: deleted ? "D" : created ? "A" : "M",
      added,
      removed,
      maybeIncomplete: hunks.length === 0,
    });
  }
  return out;
}

export function createParser(opts: { file?: string } = {}): Parser {
  const warnings: Warning[] = [];
  let omitted = 0;
  let lineNo = 0;
  let pendingInvalid = 0; // line number of an unparsable line not yet known to be non-final
  let finished: Warning[] | null = null;
  const seen = new Set<string>();
  const unknown = new Map<string, { first: number; count: number }>();
  const meta: ParserMeta = { sessionId: null, branch: null, startedAt: null, title: null };

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
        if (isError) {
          const m = /^\s*(?:Error:\s*)?Exit code (\d+)/.exec(text);
          if (m && m[1] !== undefined) ev.exitCode = Number(m[1]);
        }
        if (tur) {
          if (tur.type === "create" || tur.type === "update") ev.resultType = tur.type;
          if (Array.isArray(tur.structuredPatch)) {
            let added = 0;
            let removed = 0;
            for (const h of tur.structuredPatch) {
              if (!isObj(h)) continue;
              const c = countDiffLines(h.lines);
              added += c.added;
              removed += c.removed;
            }
            ev.structuredPatch = { added, removed };
          }
          if (tur.type === "create" && typeof tur.content === "string") ev.createLines = countLines(tur.content);
          const be = parseBashEdits(tur.bashEditDiff);
          if (be !== undefined) ev.bashEditDiff = be;
          if (tur.backgroundTaskId !== undefined && tur.backgroundTaskId !== null) ev.background = true;
        }
        out.push(ev);
      }
      return;
    }

    if (rec.isMeta === true || rec.isCompactSummary === true) return;
    if (rec.scheduledTaskId !== undefined && rec.scheduledTaskId !== null) return;
    if (isObj(rec.origin)) {
      const k = rec.origin.kind;
      if (k !== undefined && k !== "human") return;
    }

    const text = blocksText(content, PROMPT_TEXT_MAX, "\n");
    const head = (typeof content === "string" ? content : blocksText(content, 40, "")).trimStart();
    if (head.startsWith("[Request interrupted")) {
      out.push({ type: "boundary", kind: "interrupt" });
      return;
    }
    if (NON_PROMPT_PREFIXES.some((p) => head.startsWith(p))) return;
    if (typeof content === "string" ? content.trim() === "" : blocks.length === 0) return;
    out.push({
      type: "prompt",
      uuid: nonEmptyStr(rec.uuid) ?? `line-${lineNo}`,
      text,
      ts: str(rec.timestamp) ?? null,
      line: lineNo,
    });
  }

  function handleAssistant(rec: Record<string, unknown>, message: Record<string, unknown>, out: Event[]): void {
    if (!Array.isArray(message.content)) return;
    for (const b of message.content) {
      if (!isObj(b) || b.type !== "tool_use") continue;
      const id = nonEmptyStr(b.id);
      if (id === undefined) {
        warn(lineNo, "tool_use without id");
        continue;
      }
      const name = str(b.name) ?? "";
      out.push({ type: "tool_use", id, name, input: sanitizeInput(name, b.input), ts: nonEmptyStr(rec.timestamp) ?? null, line: lineNo });
    }
  }

  function handleMessageRecord(type: string, rec: Record<string, unknown>, out: Event[]): void {
    if (rec.isSidechain === true) return;
    const uuid = nonEmptyStr(rec.uuid);
    if (uuid !== undefined) {
      if (seen.has(uuid)) return;
      seen.add(uuid);
    }
    meta.sessionId ??= nonEmptyStr(rec.sessionId) ?? null;
    meta.branch ??= nonEmptyStr(rec.gitBranch) ?? null;
    meta.startedAt ??= nonEmptyStr(rec.timestamp) ?? null;

    if (type === "system") {
      if (rec.subtype === "compact_boundary") out.push({ type: "boundary", kind: "compact" });
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
export function parseLines(lines: Iterable<string>, opts: { file?: string } = {}): {
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
