/**
 * Pure input and output for opt-in local LLM prompt titles.
 * No `node:` import: the caller supplies repository directory and OS user names.
 * Nothing here reads tool output, diffs, quotes or check excerpts.
 */

import type { PromptAnalysis, PromptDetail } from "./schema.js";
import { redact, type RedactOptions } from "./redact.js";

/** Bump when the system prompt or the condensed input shape changes. Part of the cache key. */
export const TITLE_PROMPT_VERSION = "1";

/**
 * System message for the title request. One past-tense sentence, drawn only from the user message.
 * The user message is the prompt text, then up to 25 step titles, then up to 20 changed file paths.
 */
export const TITLE_SYSTEM_PROMPT =
  "You name a single coding-session prompt. Reply with one past-tense sentence of at most 120 characters. Use only the user message: the prompt text, then step titles, then changed file paths. No markdown, no quotes, no label, no explanation.";

const STEP_CAP = 25;
const FILE_CAP = 20;
const INPUT_MAX = 2000;
const TITLE_MAX = 120;

/** OpenAI chat-completions body for one title. `temperature`, `max_tokens` and `stream` are fixed. */
export interface TitleRequestBody {
  model: string;
  messages: [
    { role: "system"; content: string },
    { role: "user"; content: string },
  ];
  temperature: 0;
  max_tokens: 60;
  stream: false;
}

export function titleRequestBody(model: string, input: string): TitleRequestBody {
  return {
    model,
    messages: [
      { role: "system", content: TITLE_SYSTEM_PROMPT },
      { role: "user", content: input },
    ],
    temperature: 0,
    max_tokens: 60,
    stream: false,
  };
}

/**
 * Options are the same pair export uses: `repoDir` (realpath of the repository) and `usernames` (OS user names).
 * A string is accepted as `repoDir` alone. `envFile` is not forwarded.
 */
function titleRedactOptions(rootOrOpts: string | RedactOptions | undefined): RedactOptions {
  if (typeof rootOrOpts === "string") return rootOrOpts === "" ? {} : { repoDir: rootOrOpts };
  if (rootOrOpts === undefined) return {};
  const out: RedactOptions = {};
  if (rootOrOpts.repoDir !== undefined && rootOrOpts.repoDir !== "") out.repoDir = rootOrOpts.repoDir;
  if (rootOrOpts.usernames !== undefined) out.usernames = rootOrOpts.usernames;
  return out;
}

function toForward(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

/** Collapse `.` and `..`. An absolute path cannot climb above its root. */
function normalize(p: string): string {
  const forward = toForward(p);
  const rooted = forward.startsWith("/");
  const parts: string[] = [];
  for (const seg of forward.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const top = parts[parts.length - 1];
      const drive = top !== undefined && /^[A-Za-z]:$/.test(top);
      if (parts.length > 0 && top !== ".." && !drive) parts.pop();
      else if (!rooted && !drive) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  if (rooted) return `/${parts.join("/")}`;
  return parts.join("/");
}

/**
 * Repo-relative file path with forward slashes.
 * Absolute paths outside `root`, `..` escapes, empty paths and NULs are dropped so an absolute path is never emitted.
 */
function repoRelative(path: string, root: string | undefined): string | null {
  if (path.includes("\0") || /[\r\n]/.test(path)) return null;
  const norm = normalize(path.trim());
  if (norm === "" || norm === "." || norm === ".." || norm.startsWith("../") || norm.startsWith("~")) return null;
  if (!isAbsolute(norm)) return norm;
  if (root === undefined || root === "") return null;
  const base = normalize(root).replace(/\/+$/, "");
  // The filesystem root is not a repository prefix (it would strip the leading slash off every path).
  if (!isAbsolute(base) || base === "" || base === "/") return null;
  if (norm === base) return null;
  const prefix = `${base}/`;
  if (!norm.startsWith(prefix)) return null;
  const rel = norm.slice(prefix.length);
  if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../")) return null;
  return rel;
}

function pushField(lines: string[], raw: string, opts: RedactOptions): void {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.trim() === "") return;
  const text = redact(normalized, opts).text;
  if (text.trim() === "") return;
  lines.push(text);
}

/**
 * Keep a prefix of whole lines within `max` characters.
 * A line that would be split is dropped. A single line longer than `max` yields "".
 */
function cutLines(s: string, max: number): string {
  if (s.length <= max) return s;
  if (s.charAt(max) === "\n") return s.slice(0, max);
  const nl = s.lastIndexOf("\n", max - 1);
  if (nl < 0) return "";
  return s.slice(0, nl);
}

/**
 * Condensed, redacted model input for one prompt.
 * Each field is redacted on its own (prompt text, then up to 25 step titles, then up to 20 changed file paths),
 * the fields are joined with newlines, and a partial last line past 2000 characters is dropped.
 * Only `redact().text` is returned. `detail` contributes step titles and nothing else.
 */
export function condenseForTitle(prompt: PromptAnalysis, detail: PromptDetail | null, rootOrOpts?: string | RedactOptions): string {
  const opts = titleRedactOptions(rootOrOpts);
  const lines: string[] = [];
  pushField(lines, prompt.text, opts);
  for (const step of (detail?.steps ?? []).slice(0, STEP_CAP)) pushField(lines, step.title, opts);
  let included = 0;
  for (const file of prompt.files) {
    if (included >= FILE_CAP) break;
    const rel = repoRelative(file.path, opts.repoDir);
    if (rel === null) continue;
    included++;
    pushField(lines, rel, opts);
  }
  return cutLines(lines.join("\n"), INPUT_MAX);
}

function firstNonEmptyLine(s: string): string | null {
  for (const line of s.split(/\r\n|\n|\r/)) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return null;
}

const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "\u201c": "\u201d",
  "\u2018": "\u2019",
};

function stripQuotes(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 4; i++) {
    if (t.length < 2) return t;
    const end = QUOTE_PAIRS[t[0]!];
    if (end === undefined || !t.endsWith(end)) return t;
    t = t.slice(1, -1).trim();
  }
  return t;
}

const LEAD_RE = /^(?:title\s*:\s*|#{1,6}\s*|[*]+\s+|-\s+)/i;

function stripLead(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 8; i++) {
    const next = t.replace(LEAD_RE, "").trim();
    if (next === t) break;
    t = next;
  }
  // A line that is only a marker (`-`, `#`, `***`) is not a title. `-5` is kept.
  if (/^(?:#+|[*]+|-+)$/.test(t)) return "";
  return t;
}

function stripMarkdown(s: string): string {
  let t = s.replace(/`+/g, "");
  t = t.replace(/\*\*|__/g, "");
  t = t.replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=[\s.,;:!?)]|$)/g, "$1$2");
  t = t.replace(/(^|\s)_(\S(?:.*?\S)?)_(?=[\s.,;:!?)]|$)/g, "$1$2");
  return t;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripControls(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/** Cut to `max` code points on a word boundary, reserving one code point for the ellipsis. */
function cutAtWord(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  const body = (space > 0 ? head.slice(0, space) : head).trimEnd();
  return body === "" ? "" : `${body}…`;
}

function lineStartsWithThink(s: string): boolean {
  for (const line of s.split(/\r\n|\n|\r/)) {
    if (line.trim().toLowerCase().startsWith("<think")) return true;
  }
  return false;
}

/**
 * One title from a model reply: drop closed `<think>` blocks. An opening `<think>` tag with no closing tag,
 * or any line that still starts with `<think` after stripping, is not a title (null). Otherwise keep the
 * first non-empty line, strip quotes, a leading `Title:` / `#` / `*` / `-`, markdown emphasis and backticks,
 * collapse whitespace, drop control characters, and cut to 120 characters on a word boundary. Empty becomes null.
 */
export function sanitizeTitle(raw: string): string | null {
  const withoutClosed = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  if (/<think\b[^>]*>/i.test(withoutClosed) || lineStartsWithThink(withoutClosed)) return null;
  const line = firstNonEmptyLine(withoutClosed);
  if (line === null) return null;
  let t = line;
  for (let i = 0; i < 6; i++) {
    const next = stripMarkdown(stripLead(stripQuotes(t))).trim();
    if (next === t) break;
    t = next;
  }
  t = collapse(stripControls(collapse(t)));
  if (t === "" || /^<think/i.test(t)) return null;
  const cut = cutAtWord(t, TITLE_MAX);
  return cut === "" || /^<think/i.test(cut) ? null : cut;
}
