import { isDocPath } from "./hints.js";
import {
  isArithmeticCommandStart,
  scanBracketPairEnd,
  scanParenPairEnd,
} from "./check-patterns.js";

export const SHELL_EDIT_FILE = "(shell edit)";

export interface ShellEditTarget {
  /** Target path as written, an absolute path after a known `cd`, or `SHELL_EDIT_FILE`. */
  file: string;
  /** The edit comes from a git operation (`git mv`, `git rm`): it never changes the status. */
  gitOp: boolean;
  kind?: "M" | "A" | "D";
  /**
   * Directory a relative `file` is resolved against when this command also runs `cd`.
   * `""` is the session cwd; a relative string is joined onto it; an absolute string is the directory.
   * Absent when the command never left the session cwd, or when `file` is already absolute or `(shell edit)`.
   */
  baseDir?: string;
}

export interface ShellMutation {
  /** Heuristic edits found in the command (empty when it only reads, or writes to scratch paths). */
  edits: ShellEditTarget[];
  /** The command has mutating segments and every one of them is a git operation. */
  gitOnly: boolean;
  /**
   * Where the non-git mutating segments sit relative to the check segments of the same command:
   * `before-check` (the check ran on the edited files), `after-check`, or `unknown` (no check or no such segment).
   */
  order: "before-check" | "after-check" | "unknown";
  /**
   * The command runs `cd` / `pushd` / `popd`. Relative targets carry `baseDir` so only the edits
   * that actually sit in an unresolved directory stay unresolved.
   */
  hasCd: boolean;
  /**
   * The command runs a history-moving git operation (merge, rebase, pull, cherry-pick, revert, stash, checkout,
   * switch, reset, restore, am, mv): the files in its `bashEditDiff` may come from git rather than from its plain edits.
   */
  hasHistoryGitOp: boolean;
  /**
   * Some segment is neither a recognised write, a git operation, a check nor a known non-writing command, or the
   * list of edits was cut: files of the diff cannot be attributed one by one.
   */
  opaque: boolean;
}

export const NONE: ShellMutation = { edits: [], gitOnly: false, order: "unknown", hasCd: false, hasHistoryGitOp: false, opaque: false };
export const FILES_MAX = 20;
export const GIT_OPS = new Set(["merge", "rebase", "pull", "checkout", "stash", "cherry-pick", "revert", "mv", "restore", "reset", "switch", "am"]);

export interface Word {
  text: string;
  /** Unquoted glob / expansion characters, or a `$` / backtick inside double quotes: the real operands are unknown. */
  dynamic: boolean;
}
export interface Redirect {
  fd: string;
  target: Word | null;
  op?: string;
}

const REDIR_RE = /(\d+|&)?(>>|>&|>\||>|<<<|<<-?|<&|<)/y;

/** Quote-aware split of one segment into words and output redirections (input redirections are dropped). */
export function parseWords(s: string): { words: Word[]; redirects: Redirect[] } {
  const words: Word[] = [];
  const redirects: Redirect[] = [];
  const n = s.length;
  let i = 0;
  const skipWs = (): void => {
    while (i < n && /\s/.test(s[i] as string)) i++;
  };
  const readWord = (): Word | null => {
    skipWs();
    let text = "";
    let dynamic = false;
    let any = false;
    while (i < n) {
      const c = s[i] as string;
      if (/\s/.test(c) || c === "<" || c === ">") break;
      any = true;
      if (c === "'") {
        const j = s.indexOf("'", i + 1);
        const end = j < 0 ? n : j;
        text += s.slice(i + 1, end);
        i = j < 0 ? n : j + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < n && s[j] !== '"') {
          if (s[j] === "\\" && j + 1 < n) {
            text += s[j + 1];
            j += 2;
            continue;
          }
          if (s[j] === "$" || s[j] === "`") dynamic = true;
          text += s[j];
          j++;
        }
        i = j + 1;
        continue;
      }
      if (c === "\\") {
        text += s[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === "$" && s.slice(i, i + 3) === "$((") {
        const arithEnd = scanParenPairEnd(s, i + 3);
        if (arithEnd >= 0) {
          text += s.slice(i, arithEnd + 1);
          i = arithEnd + 1;
          dynamic = true;
          continue;
        }
      }
      if (c === "$" && s.slice(i, i + 2) === "$[") {
        const arithEnd = scanBracketPairEnd(s, i + 2);
        if (arithEnd >= 0) {
          text += s.slice(i, arithEnd + 1);
          i = arithEnd + 1;
          dynamic = true;
          continue;
        }
      }
      if ("*?[{$`()".includes(c)) dynamic = true;
      text += c;
      i++;
    }
    return any ? { text, dynamic } : null;
  };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const isCommandStart = words.length === 0 || isArithmeticCommandStart(words[words.length - 1]?.text ?? "");
    if (isCommandStart && s.slice(i, i + 2) === "((") {
      const end = scanParenPairEnd(s, i + 2);
      if (end >= 0) {
        words.push({ text: s.slice(i, end + 1), dynamic: true });
        i = end + 1;
        continue;
      }
    }
    REDIR_RE.lastIndex = i;
    const m = REDIR_RE.exec(s);
    if (m) {
      i = REDIR_RE.lastIndex;
      const fd = m[1] ?? ""; // "&" for `&>` / `&>>`
      const op = m[2] as string;
      if (op === ">" || op === ">>" || op === ">|") redirects.push({ fd, target: readWord(), op });
      else if (op === ">&") {
        // `>&2`, `2>&1`, `>&-` duplicate or close a descriptor; `>& file` writes the file.
        const target = readWord();
        if (target !== null && !/^\d*-?$/.test(target.text)) redirects.push({ fd: fd === "" ? "&" : fd, target, op: ">&" });
      } else readWord(); // `<file`, `<<EOF`, `<<<str`: nothing written to a file
      continue;
    }
    const before = i;
    const w = readWord();
    if (w) words.push(w);
    else if (i === before) i++;
  }
  return { words, redirects };
}

/** Known standard scratch environment variables provided by the OS/environment or session. */
export const KNOWN_SCRATCH_ENV_NAMES = new Set(["TMPDIR", "TMP", "TEMP", "S"]);

const IGNORED_PATH_RES: RegExp[] = [
  /^\/dev\//,
  /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/,
  /(?:^|\/)\.cache(?:\/|$)/,
  // `scratch*` is a directory component only (`scratch/a.ts`). `src/scratchpad.ts` is code (C17).
  /(?:^|\/)scratch[^/]*\//,
  /(?:^|\/)[^/]*\.(?:log|out|err)$/,
  /(?:^|\/)(?:log|out|output|err|stdout|stderr)$/,
];

const CHECK_LOG_RES: RegExp[] = [
  /(?:^|\/)(?:results|result|output|out|report|check|test|gate|err|error)[^/]*\.(?:txt|json|xml|html|tap)$/i,
];

export function isCheckLogTarget(
  target: string,
  poisoned?: ReadonlySet<string>,
  tempVars?: ReadonlySet<string>,
): boolean {
  if (isIgnoredPath(target, poisoned, tempVars)) return true;
  const n = pathForIgnore(target);
  return CHECK_LOG_RES.some((re) => re.test(n));
}

/** `//` collapses before the climb test, so `$S//../a.ts` is the same climb as `$S/../a.ts` (C17). */
export function collapseSlashes(p: string): string {
  return p.replace(/\/{2,}/g, "/");
}

const VAR_PREFIX_RE = /^(?:\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)\})(?:\/(.*))?$/;
const VAR_DEF_PREFIX_RE = /^\$\{([A-Za-z_]\w*)(?::=|:-|-|=)([^}]+)\}(?:\/(.*))?$/;

const MKTEMP_SHORT_FLAGS = new Set(["d", "u", "q", "t"]);
const MKTEMP_LONG_FLAGS = new Set(["--directory", "--dry-run", "--quiet"]);

export function isAllowedMktempCmd(cmd: string): boolean {
  if (/[;&|\n]/.test(cmd)) return false;
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts[0] !== "mktemp") return false;
  let hasT = false;
  let template: string | null = null;
  for (let i = 1; i < parts.length; i++) {
    const raw = parts[i] as string;
    const tok = raw.replace(/^['"]|['"]$/g, "");
    if (tok === "--") continue;
    if (tok.startsWith("--")) {
      if (!MKTEMP_LONG_FLAGS.has(tok)) return false;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      for (let j = 1; j < tok.length; j++) {
        const c = tok[j] as string;
        if (!MKTEMP_SHORT_FLAGS.has(c)) return false;
        if (c === "t") hasT = true;
      }
      continue;
    }
    if (template !== null) return false;
    template = tok;
  }
  if (template !== null) {
    if (hasT) {
      if (!template.includes("/")) return true;
      const norm = normalizePath(template);
      return /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/.test(norm) && norm !== ".." && !norm.startsWith("../");
    }
    const norm = normalizePath(template);
    return /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/.test(norm) && norm !== ".." && !norm.startsWith("../");
  }
  return true;
}

export function isMktempValue(raw: string): boolean {
  const s = raw.trim();
  const inner =
    (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
      ? s.slice(1, -1).trim()
      : s;
  if (inner.startsWith("$(") && inner.endsWith(")")) {
    const body = inner.slice(2, -1).trim();
    return isAllowedMktempCmd(body);
  }
  if (inner.startsWith("`") && inner.endsWith("`")) {
    const body = inner.slice(1, -1).trim();
    return isAllowedMktempCmd(body);
  }
  return false;
}

export function isDirectMktemp(p: string): boolean {
  if (nonLiteralClimb(p)) return false;
  const s = collapseSlashes(p.trim().replace(/^"|"$/g, ""));
  if (!s.startsWith("$(") && !s.startsWith("`")) return false;
  let cmd = "";
  let rest = "";
  if (s.startsWith("$(")) {
    const end = s.indexOf(")");
    if (end === -1) return false;
    cmd = s.slice(2, end).trim();
    rest = s.slice(end + 1);
  } else if (s.startsWith("`")) {
    const end = s.indexOf("`", 1);
    if (end === -1) return false;
    cmd = s.slice(1, end).trim();
    rest = s.slice(end + 1);
  }
  if (!isAllowedMktempCmd(cmd)) return false;
  if (rest === "" || rest === "/") return true;
  if (!rest.startsWith("/")) return false;
  const norm = normalizePath(rest.slice(1));
  return norm !== ".." && !norm.startsWith("../");
}

export function tempPrefixName(prefix: string): string | null {
  const m = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(prefix);
  return m ? (m[1] as string) : null;
}

/**
 * A temp-variable path stays scratch while the remainder is under the variable.
 * `..` that normalises above the variable (`$S/../../src/a.ts`, `$S//../a.ts`) is `climb`: unresolved, a code edit.
 * A temp name assigned to a non-temp root, or used as a `for` / `read` variable, is `climb` from that
 * assignment on (a use earlier in the command stays scratch).
 * Ending exactly on the variable (`$S/foo/..`) is still scratch.
 */
export function tempPrefixKind(
  p: string,
  poisoned?: ReadonlySet<string>,
  tempVars?: ReadonlySet<string>,
): "scratch" | "climb" | null {
  const collapsed = collapseSlashes(p);
  const mDef = VAR_DEF_PREFIX_RE.exec(collapsed);
  if (mDef) {
    const name = mDef[1] as string;
    const fallback = mDef[2] as string;
    const rest = mDef[3];
    if (KNOWN_SCRATCH_ENV_NAMES.has(name) || tempVars?.has(name)) {
      if (poisoned?.has(name)) return "climb";
      if (!/^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/.test(pathForIgnore(fallback))) {
        return "climb";
      }
      if (rest === undefined || rest === "") return "scratch";
      const norm = normalizePath(rest);
      if (norm === ".." || norm.startsWith("../")) return "climb";
      return "scratch";
    }
  }

  const m = VAR_PREFIX_RE.exec(collapsed);
  if (!m) return null;
  const name = (m[1] ?? m[2]) as string;
  if (!KNOWN_SCRATCH_ENV_NAMES.has(name) && !tempVars?.has(name)) return null;
  if (poisoned?.has(name)) return "climb";
  const rest = m[3];
  if (rest === undefined || rest === "") return "scratch";
  const norm = normalizePath(rest);
  if (norm === ".." || norm.startsWith("../")) return "climb";
  return "scratch";
}

/**
 * A non-literal path (`$`, glob, backtick) with a real `..` segment climbs out of whatever prefix it has (C17).
 * `$S/..a` and `$S/.../a` do not: `..` must be its own segment.
 */
export function nonLiteralClimb(p: string): boolean {
  const collapsed = collapseSlashes(p);
  if (!/[$`*?]/.test(collapsed)) return false;
  return /(?:^|\/)\.\.(?:\/|$)/.test(collapsed);
}

/**
 * Path the scratch test sees. A literal `.` / `..` is collapsed first, so `/tmp/../repo/a.ts` is not under `/tmp`.
 * A `$` / glob / `~` target is not collapsed here: a temp prefix is classified by `tempPrefixKind` before this runs.
 */
export function pathForIgnore(p: string): string {
  if (/[$`*?~]/.test(p)) return p;
  if (p.startsWith("/") || p.split("/").some((seg) => seg === "." || seg === "..")) return normalizePath(p);
  return p;
}

/** Scratch, cache and log-capture targets are not edits of the work tree. A temp path that climbs out is. */
export function isIgnoredPath(p: string, poisoned?: ReadonlySet<string>, tempVars?: ReadonlySet<string>): boolean {
  if (nonLiteralClimb(p)) return false;
  if (isDirectMktemp(p)) return true;
  const temp = tempPrefixKind(p, poisoned, tempVars);
  if (temp === "climb") return false;
  if (temp === "scratch") return true;
  const n = pathForIgnore(p);
  return IGNORED_PATH_RES.some((re) => re.test(n));
}

/** A literal path under a temp root, scratch directory, cache or log. A value with `$` / a glob is not. */
export function isTempRootValue(value: string | null): boolean {
  if (value === null || /[$`*?]/.test(value)) return false;
  return IGNORED_PATH_RES.some((re) => re.test(pathForIgnore(value)));
}

/** Collapse `.` / `..` in a stored relative edit (`scratch/../src/a.ts` -> `src/a.ts`). Other paths stay as written. */
export function canonicalizeEditPath(file: string): string {
  if (file === SHELL_EDIT_FILE || file.startsWith("~") || /[$`*?]/.test(file)) return file;
  if (!file.split("/").some((seg) => seg === "." || seg === "..")) return file;
  const n = normalizePath(file);
  return n === "" ? file : n;
}

/** Unknown variable / substitution targets of a redirect: nothing reliable to say, so no edit. */
export function isUnknownTarget(w: Word): boolean {
  return w.text.startsWith("$") || w.text.startsWith("`") || w.dynamic;
}

export function isOption(w: Word): boolean {
  return w.text.startsWith("-") && w.text.length > 1;
}

/** Files of a segment from its operands; `SHELL_EDIT_FILE` when any operand is dynamic or none is left. */
export function operandFiles(ops: Word[], poisoned?: ReadonlySet<string>, tempVars?: ReadonlySet<string>): string[] {
  const live = ops.filter((w) => !isIgnoredPath(w.text, poisoned, tempVars));
  if (live.length === 0 && ops.length > 0) return [];
  // A temp prefix that climbed out, a non-literal `..`, or any dynamic operand, is an unresolved code edit.
  if (live.length === 0 || live.some((w) => w.dynamic || tempPrefixKind(w.text, poisoned, tempVars) === "climb" || nonLiteralClimb(w.text))) {
    return [SHELL_EDIT_FILE];
  }
  return live.map((w) => w.text);
}

export function gitSub(words: Word[]): { sub: string; args: Word[] } | null {
  if (words[0]?.text !== "git") return null;
  let i = 1;
  while (i < words.length) {
    const t = (words[i] as Word).text;
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree") i += 2;
    else if (t.startsWith("-")) i++;
    else break;
  }
  const sub = words[i]?.text;
  return sub === undefined ? null : { sub, args: words.slice(i + 1) };
}

export function sedFiles(args: Word[], poisoned?: ReadonlySet<string>, tempVars?: ReadonlySet<string>): string[] | null {
  let inPlace = false;
  let hasScriptOpt = false;
  const ops: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as Word;
    const t = w.text;
    if (t === "--in-place" || t.startsWith("--in-place=")) inPlace = true;
    else if (t === "-e" || t === "-f" || t === "--expression" || t === "--file") {
      hasScriptOpt = true;
      i++;
    } else if (t.startsWith("--expression=") || t.startsWith("--file=")) hasScriptOpt = true;
    else if (/^-[nEerszul]*i/.test(t)) inPlace = true;
    else if (isOption(w)) continue;
    else ops.push(w);
  }
  if (!inPlace) return null;
  if (!hasScriptOpt) ops.shift(); // the first operand is the script
  return operandFiles(ops, poisoned, tempVars);
}

export function perlFiles(args: Word[], poisoned?: ReadonlySet<string>, tempVars?: ReadonlySet<string>): string[] | null {
  let inPlace = false;
  let hasScript = false;
  const ops: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as Word;
    const t = w.text;
    if (/^-[A-Za-z]*i/.test(t)) inPlace = true;
    if (isOption(w)) {
      // `-e` / `-E` (possibly in a cluster such as `-pe`) take the script as the next word.
      if (/^-[A-Za-z]*[eE]$/.test(t) && !/^-[A-Za-z]*i/.test(t)) {
        hasScript = true;
        i++;
      }
      continue;
    }
    ops.push(w);
  }
  if (!inPlace) return null;
  if (!hasScript) ops.shift();
  return operandFiles(ops, poisoned, tempVars);
}

export function teeFiles(args: Word[], poisoned?: ReadonlySet<string>, tempVars?: ReadonlySet<string>): string[] {
  return operandFiles(
    args.filter((w) => !isOption(w)),
    poisoned,
    tempVars,
  );
}


export function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else out.push(part);
  }
  return (abs ? "/" : "") + out.join("/");
}

