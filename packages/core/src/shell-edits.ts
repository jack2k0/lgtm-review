/**
 * Heuristic detection of file edits made through Bash (`sed -i`, `tee`, `> file`, `git apply`, ...), for
 * sessions whose log carries no `bashEditDiff` (the session did not start inside the repo), and of
 * commands whose only mutating segments are git operations (merge, rebase, checkout, ...).
 * Pure string logic on the command, regex/linear, never throws.
 */
import { isDocPath } from "./hints.js";
import {
  matchSegment,
  normalizeFirstToken,
  splitSegments,
  stripHeredocs,
  parseHeredocStarts,
  heredocEnds,
  stripPrefixes,
  type HeredocStart,
  type RepoScripts,
  type Segment,
} from "./check-patterns.js";

/** File name used when the target of a shell edit cannot be read off the command. */
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

const NONE: ShellMutation = { edits: [], gitOnly: false, order: "unknown", hasCd: false, hasHistoryGitOp: false, opaque: false };
const FILES_MAX = 20;
const GIT_OPS = new Set(["merge", "rebase", "pull", "checkout", "stash", "cherry-pick", "revert", "mv", "restore", "reset", "switch", "am"]);

interface Word {
  text: string;
  /** Unquoted glob / expansion characters, or a `$` / backtick inside double quotes: the real operands are unknown. */
  dynamic: boolean;
}
interface Redirect {
  fd: string;
  target: Word | null;
}

const REDIR_RE = /(\d+|&)?(>>|>&|>\||>|<<<|<<-?|<&|<)/y;

/** Quote-aware split of one segment into words and output redirections (input redirections are dropped). */
function parseWords(s: string): { words: Word[]; redirects: Redirect[] } {
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
      if ("*?[{$`()".includes(c)) dynamic = true;
      text += c;
      i++;
    }
    return any ? { text, dynamic } : null;
  };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    REDIR_RE.lastIndex = i;
    const m = REDIR_RE.exec(s);
    if (m) {
      i = REDIR_RE.lastIndex;
      const fd = m[1] ?? ""; // "&" for `&>` / `&>>`
      const op = m[2] as string;
      if (op === ">" || op === ">>" || op === ">|") redirects.push({ fd, target: readWord() });
      else if (op === ">&") {
        // `>&2`, `2>&1`, `>&-` duplicate or close a descriptor; `>& file` writes the file.
        const target = readWord();
        if (target !== null && !/^\d*-?$/.test(target.text)) redirects.push({ fd: fd === "" ? "&" : fd, target });
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

/** `$S`, `$TMPDIR`, `$SCRATCH…` and the same names braced. The rest of the path, if any, follows a slash. */
const TEMP_PREFIX_RE = /^(\$\{?(?:TMPDIR|TMP|TEMP|S|SCRATCH\w*)\}?)(?:\/(.*))?$/;
const TEMP_NAME_RE = /^(?:TMPDIR|TMP|TEMP|S|SCRATCH\w*)$/;

const IGNORED_PATH_RES: RegExp[] = [
  /^\/dev\//,
  /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/,
  /(?:^|\/)\.cache(?:\/|$)/,
  // `scratch*` is a directory component only (`scratch/a.ts`). `src/scratchpad.ts` is code (C17).
  /(?:^|\/)scratch[^/]*\//,
  /(?:^|\/)[^/]*\.(?:log|out|err)$/,
  /(?:^|\/)(?:log|out|output|err|stdout|stderr)$/,
];

/** `//` collapses before the climb test, so `$S//../a.ts` is the same climb as `$S/../a.ts` (C17). */
function collapseSlashes(p: string): string {
  return p.replace(/\/{2,}/g, "/");
}

function tempPrefixName(prefix: string): string | null {
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
function tempPrefixKind(p: string, poisoned?: ReadonlySet<string>): "scratch" | "climb" | null {
  const m = TEMP_PREFIX_RE.exec(collapseSlashes(p));
  if (!m) return null;
  const name = tempPrefixName(m[1] as string);
  if (name !== null && poisoned?.has(name)) return "climb";
  const rest = m[2];
  if (rest === undefined || rest === "") return "scratch";
  const norm = normalizePath(rest);
  if (norm === ".." || norm.startsWith("../")) return "climb";
  return "scratch";
}

/**
 * A non-literal path (`$`, glob, backtick) with a real `..` segment climbs out of whatever prefix it has (C17).
 * `$S/..a` and `$S/.../a` do not: `..` must be its own segment.
 */
function nonLiteralClimb(p: string): boolean {
  const collapsed = collapseSlashes(p);
  if (!/[$`*?]/.test(collapsed)) return false;
  return /(?:^|\/)\.\.(?:\/|$)/.test(collapsed);
}

/**
 * Path the scratch test sees. A literal `.` / `..` is collapsed first, so `/tmp/../repo/a.ts` is not under `/tmp`.
 * A `$` / glob / `~` target is not collapsed here: a temp prefix is classified by `tempPrefixKind` before this runs.
 */
function pathForIgnore(p: string): string {
  if (/[$`*?~]/.test(p)) return p;
  if (p.startsWith("/") || p.split("/").some((seg) => seg === "." || seg === "..")) return normalizePath(p);
  return p;
}

/** Scratch, cache and log-capture targets are not edits of the work tree. A temp path that climbs out is. */
function isIgnoredPath(p: string, poisoned?: ReadonlySet<string>): boolean {
  if (nonLiteralClimb(p)) return false;
  const temp = tempPrefixKind(p, poisoned);
  if (temp === "climb") return false;
  if (temp === "scratch") return true;
  const n = pathForIgnore(p);
  return IGNORED_PATH_RES.some((re) => re.test(n));
}

/** A literal path under a temp root, scratch directory, cache or log. A value with `$` / a glob is not. */
function isTempRootValue(value: string | null): boolean {
  if (value === null || /[$`*?]/.test(value)) return false;
  return IGNORED_PATH_RES.some((re) => re.test(pathForIgnore(value)));
}

/** Collapse `.` / `..` in a stored relative edit (`scratch/../src/a.ts` -> `src/a.ts`). Other paths stay as written. */
function canonicalizeEditPath(file: string): string {
  if (file === SHELL_EDIT_FILE || file.startsWith("~") || /[$`*?]/.test(file)) return file;
  if (!file.split("/").some((seg) => seg === "." || seg === "..")) return file;
  const n = normalizePath(file);
  return n === "" ? file : n;
}

/** Unknown variable / substitution targets of a redirect: nothing reliable to say, so no edit. */
function isUnknownTarget(w: Word): boolean {
  return w.text.startsWith("$") || w.text.startsWith("`") || w.dynamic;
}

function isOption(w: Word): boolean {
  return w.text.startsWith("-") && w.text.length > 1;
}

/** Files of a segment from its operands; `SHELL_EDIT_FILE` when any operand is dynamic or none is left. */
function operandFiles(ops: Word[], poisoned?: ReadonlySet<string>): string[] {
  const live = ops.filter((w) => !isIgnoredPath(w.text, poisoned));
  if (live.length === 0 && ops.length > 0) return [];
  // A temp prefix that climbed out, a non-literal `..`, or any dynamic operand, is an unresolved code edit.
  if (live.length === 0 || live.some((w) => w.dynamic || tempPrefixKind(w.text, poisoned) === "climb" || nonLiteralClimb(w.text))) {
    return [SHELL_EDIT_FILE];
  }
  return live.map((w) => w.text);
}

function gitSub(words: Word[]): { sub: string; args: Word[] } | null {
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

function sedFiles(args: Word[], poisoned?: ReadonlySet<string>): string[] | null {
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
  return operandFiles(ops, poisoned);
}

function perlFiles(args: Word[], poisoned?: ReadonlySet<string>): string[] | null {
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
  return operandFiles(ops, poisoned);
}

function teeFiles(args: Word[], poisoned?: ReadonlySet<string>): string[] {
  return operandFiles(
    args.filter((w) => !isOption(w)),
    poisoned,
  );
}

const GIT_APPLY_READONLY = new Set(["--check", "--stat", "--numstat", "--summary"]);

const PY_WRITE_RE = /\.write_(?:text|bytes)\s*\(/g;
const PY_OPEN_CALL_RE = /\bopen\s*\(/g;
// R2 (kept) + H4: heredoc-fed python is opaque unless every import is on the allow-list and the source has no
// dunder identifier and none of the dynamic-execution names. Only adds opacity.
const PY_SURFACE_MODULE_RE = /\b(?:import|from)\b[^\n;]*\b(?:os|subprocess|shutil|pty|importlib|ctypes|multiprocessing|pathlib)\b/;
const PY_SURFACE_CALL_RE = /\b(?:exec|eval|compile|__import__|getattr|globals|system|popen|spawn\w*)\b/;
const PY_PATH_IMPORT_RE = /\bfrom\s+pathlib\s+import\s+Path(?:\s+as\s+\w+)?[ \t]*(?=$|[;\n])/gm;
const PY_ALLOWED_MODULES = new Set([
  "json", "re", "math", "sys", "pathlib", "textwrap", "datetime", "collections", "itertools", "functools", "string", "typing",
]);
const PY_IMPORT_RE = /\bfrom\s+(\S+)\s+import\b|(?<!\bfrom\s+\S+\s+)\bimport\s+([^\n;]+)/g;
const PY_DYNAMIC_RE = /\b(?:exec|eval|compile|getattr|setattr|globals|vars|builtins)\b|\b__\w+__\b/;

function pythonHasSurface(raw: string): boolean {
  const stripped = stripPyComments(raw);
  const body = stripped.replace(PY_PATH_IMPORT_RE, "");
  if (PY_SURFACE_MODULE_RE.test(body) || PY_SURFACE_CALL_RE.test(body)) return true;
  if (PY_DYNAMIC_RE.test(stripped)) return true;
  for (const m of stripped.matchAll(PY_IMPORT_RE)) {
    const mods = m[1] !== undefined ? [m[1]] : (m[2] ?? "").split(",").map((x) => x.trim().split(/\s+/)[0] ?? "");
    for (const mod of mods) if (!PY_ALLOWED_MODULES.has(mod.split(".")[0] ?? "")) return true;
  }
  return false;
}

const PY_BIND_RE = /(?:^|[;\n])[ \t]*(\w+)[ \t]*=(?!=)[ \t]*([^;\n]+)/g;

/** Splits `s` at the top-level occurrences of `sep` (outside quotes and brackets). */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote !== "") {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function joinPath(a: string, b: string): string {
  if (b.startsWith("/")) return b;
  return a === "" || a.endsWith("/") ? a + b : `${a}/${b}`;
}

/**
 * Resolves a Python expression to a string: a literal, `sys.argv[N]`, a bound name, `Path(x)` / `str(x)` / `(x)`,
 * `a + b`, `a / b` and `os.path.join(a, b, ...)` of resolvable parts. Null when any part is unknown.
 */
function pyValue(expr: string, bound: ReadonlyMap<string, string | null>, argv: (string | null)[], depth = 0): string | null {
  const e = expr.trim();
  if (e === "" || depth > 6) return null;
  const lit = /^(['"])([^'"\n]*)\1$/.exec(e);
  if (lit) return lit[2] as string;
  for (const [sep, join] of [
    ["+", (x: string, y: string) => x + y],
    ["/", joinPath],
  ] as const) {
    const parts = splitTop(e, sep);
    if (parts.length > 1) {
      let acc: string | null = null;
      for (const part of parts) {
        const v = pyValue(part, bound, argv, depth + 1);
        if (v === null) return null;
        acc = acc === null ? v : join(acc, v);
      }
      return acc;
    }
  }
  const wrapped = /^(?:(?:pathlib\.)?Path|PurePath|str|os\.fspath)?\(([\s\S]*)\)$/.exec(e);
  if (wrapped) return pyValue(wrapped[1] as string, bound, argv, depth + 1);
  const joinCall = /^os\.path\.join\(([\s\S]*)\)$/.exec(e);
  if (joinCall) {
    let acc: string | null = null;
    for (const part of splitTop(joinCall[1] as string, ",")) {
      const v = pyValue(part, bound, argv, depth + 1);
      if (v === null) return null;
      acc = acc === null ? v : joinPath(acc, v);
    }
    return acc;
  }
  const arg = /^sys\.argv\[\s*(\d+)\s*\]$/.exec(e);
  if (arg) return argv[Number(arg[1]) - 1] ?? null;
  return /^\w+$/.test(e) ? (bound.get(e) ?? null) : null;
}

/** Removes `#` comments outside string literals (an apostrophe in a comment must not open a string). */
function stripPyComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let quote = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i] as string;
        if (quote !== "") {
          if (c === "\\") i++;
          else if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** The text between the parenthesis at `open` and its match (quote-aware), or null when it is not closed. */
function balancedArgs(s: string, open: number): string | null {
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i++) {
    const c = s[i] as string;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return s.slice(open + 1, i);
  }
  return null;
}

/** Start of the receiver expression that ends `prefix` (`Path("x")`, `(a / "b")`, `p`), or null. */
function receiverOf(prefix: string): string | null {
  const t = prefix.trimEnd();
  // A qualified name (`a.b.write_text`, `x[0].write_text`) is not a plain name we can follow.
  if (/[\w)\]]\s*\.\s*\w+$/.test(t) || t.endsWith("]")) return null;
  if (t.endsWith(")")) {
    let depth = 0;
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i] === ")") depth++;
      else if (t[i] === "(" && --depth === 0) {
        const head = /[\w.]*$/.exec(t.slice(0, i));
        return (head?.[0] ?? "") + t.slice(i);
      }
    }
    return null;
  }
  return /\w+$/.exec(t)?.[0] ?? null;
}

interface PyWriteSite {
  at: number;
  expr: string | null;
  /** Identifier starts that belong to this write once its path resolves (`open`, a chained `.write`). */
  tokens: number[];
  /** Start of `open(`, so a wrapping `dump(` can be tied to a resolved open. */
  openAt: number | null;
  /** Body slice whose forbidden names belong to this write once it resolves (the args, or the receiver). */
  span: { abs: number; text: string } | null;
}

interface PyWriteInfo {
  files: string[];
  /** Starts of identifiers that are part of a write whose path resolved (scratch included). */
  owned: Set<number>;
  /** A parsed `open` / `write_text` whose path did not resolve. */
  unresolved: boolean;
  /** A parsed write whose path resolved, including one later dropped as scratch. */
  resolved: boolean;
}

/**
 * Files written by the Python code of one heredoc (`open(path, 'w')`, `.write_text(`). A path resolves when it is a
 * string literal, `sys.argv[N]` (of `python3 - args`), a name bound to such a value by an assignment above the
 * write (the binding in effect at the write counts), or a concatenation / `Path` / `os.path.join` of those.
 */
function pythonWrites(raw: string, argv: (string | null)[]): string[] {
  return inspectPythonWrites(raw, argv).files;
}

/** Same file list as `pythonWrites`, plus which identifier occurrences sit on a resolved write (C12). */
function inspectPythonWrites(raw: string, argv: (string | null)[]): PyWriteInfo {
  const body = stripPyComments(raw);
  const out: string[] = [];
  let unknown = false;
  let resolved = false;
  const owned = new Set<number>();
  const binds: { at: number; name: string; expr: string; nested: boolean }[] = [];
  for (const m of body.matchAll(PY_BIND_RE)) {
    const name = m[1] as string;
    const at = (m.index ?? 0) + m[0].indexOf(name);
    const lineStart = body.lastIndexOf("\n", at - 1) + 1;
    // An indented binding (inside if / for / with / def) may or may not run: the name is then unresolved.
    const nested = (/^[ \t]*/.exec(body.slice(lineStart))?.[0] ?? "") !== "";
    binds.push({ at, name, expr: m[2] as string, nested });
  }
  const writes: PyWriteSite[] = [];
  for (const m of body.matchAll(PY_OPEN_CALL_RE)) {
    const at = m.index ?? 0;
    const paren = at + m[0].length - 1;
    const args = balancedArgs(body, paren);
    if (args === null) {
      // Cannot tell what is written: stay conservative.
      writes.push({ at, expr: null, tokens: [], openAt: null, span: null });
      continue;
    }
    const parts = splitTop(args, ",").map((x) => x.trim());
    const kw = parts.find((x) => /^mode\s*=/.test(x));
    const mode = kw !== undefined ? kw.replace(/^mode\s*=\s*/, "") : parts[1] !== undefined && !/^\w+\s*=(?!=)/.test(parts[1]) ? parts[1] : undefined;
    if (mode === undefined) continue; // open(path): read
    const lit = /^(['"])([^'"\n]*)\1$/.exec(mode);
    if (lit && !/[wax+]/.test(lit[2] as string)) continue; // a literal read mode
    const after = paren + 1 + args.length + 1;
    const tokens = [at];
    const chained = /^\s*\.\s*write\b/.exec(body.slice(after));
    if (chained) tokens.push(after + chained[0].lastIndexOf("write"));
    writes.push({ at, expr: lit ? (parts[0] ?? null) : null, tokens, openAt: at, span: { abs: paren + 1, text: args } });
  }
  for (const m of body.matchAll(PY_WRITE_RE)) {
    const at = m.index ?? 0;
    const prefixStart = Math.max(0, at - 300);
    const prefix = body.slice(prefixStart, at);
    const recv = receiverOf(prefix);
    const trimmed = prefix.trimEnd();
    const span = recv !== null && trimmed.endsWith(recv) ? { abs: prefixStart + trimmed.length - recv.length, text: recv } : null;
    writes.push({ at, expr: recv, tokens: [], openAt: null, span });
  }
  writes.sort((x, y) => x.at - y.at);
  const bound = new Map<string, string | null>();
  let bi = 0;
  for (const w of writes) {
    while (bi < binds.length && (binds[bi] as { at: number }).at < w.at) {
      const b = binds[bi++] as { name: string; expr: string; nested: boolean };
      bound.set(b.name, b.nested ? null : pyValue(b.expr, bound, argv));
    }
    const v = w.expr === null ? null : pyValue(w.expr, bound, argv);
    if (v === null || v === "") unknown = true;
    else {
      resolved = true;
      if (!isIgnoredPath(v)) out.push(v);
      for (const t of w.tokens) owned.add(t);
    }
    if (out.length >= FILES_MAX) {
      unknown = true; // cut: more writes may follow
      break;
    }
  }
  if (unknown) out.push(SHELL_EDIT_FILE);
  return { files: out, owned, unresolved: unknown, resolved };
}

interface MutFile {
  file: string;
  kind?: "M" | "A" | "D";
}

interface SegMut {
  /** The segment writes files we resolved, but also runs code we cannot read (R2). */
  opaque?: boolean;
  gitOp: boolean;
  /** A history-moving git operation (`GIT_OPS`), as opposed to `git rm` / `git apply`. */
  history: boolean;
  files: MutFile[];
}

/** A command-line argument as a literal: itself, or `$VAR` / `"$VAR"` / `${VAR}` assigned a literal earlier; null otherwise. */
function shellArg(w: Word, vars: ReadonlyMap<string, string>): string | null {
  const ref = /^\$(?:\{(\w+)\}|(\w+))$/.exec(w.text);
  if (ref) return vars.get((ref[1] ?? ref[2]) as string) ?? null;
  return w.dynamic ? null : w.text;
}

const VAR_REF_RE = /\$(?:\{(\w+)\}|(\w+))/g;

/** Replaces `$VAR` / `${VAR}` in a word by the literal assigned earlier in the command, when all of them are known. */
function substituteVars(w: Word, vars: ReadonlyMap<string, string>): Word {
  if (!w.dynamic || vars.size === 0 || !w.text.includes("$")) return w;
  let unknown = false;
  const text = w.text.replace(VAR_REF_RE, (_all, braced: string | undefined, bare: string | undefined) => {
    const v = vars.get((braced ?? bare) as string);
    if (v === undefined) unknown = true;
    return v ?? "";
  });
  if (unknown || /[$`*?[{()]/.test(text)) return w;
  return { text, dynamic: false };
}

/**
 * A climbing temp path is left unsubstituted. Substituting `S=/home/user/src` would turn `$S/a.ts`
 * into a real path; C17 wants that use unresolved (`(shell edit)`).
 */
function substituteKeepingClimb(w: Word, vars: ReadonlyMap<string, string>, poisoned: ReadonlySet<string>): Word {
  if (nonLiteralClimb(w.text) || tempPrefixKind(w.text, poisoned) === "climb") return w;
  return substituteVars(w, vars);
}

/** Bodies of the heredocs of a command, in order of their start. */
function heredocBodies(cmd: string): string[] {
  return heredocParts(cmd).map((h) => h.body);
}

/** Heredocs with their bodies, whether the delimiter was quoted (a quoted body is literal) and whether it was closed. */
function heredocParts(cmd: string): { body: string; quoted: boolean; closed: boolean }[] {
  const out: { body: string; quoted: boolean; closed: boolean }[] = [];
  const queue: HeredocStart[] = [];
  let body: string[] = [];
  for (const line of cmd.split("\n")) {
    if (queue.length > 0) {
      const cur = queue[0] as HeredocStart;
      if (heredocEnds(line, cur.delim, cur.dash)) {
        out.push({ body: body.join("\n"), quoted: cur.quoted, closed: true });
        body = [];
        queue.shift();
      } else body.push(line);
      continue;
    }
    const starts = parseHeredocStarts(line);
    if (starts.length > 0) queue.push(...starts);
  }
  if (queue.length > 0) {
    const cur = queue[0] as HeredocStart;
    out.push({ body: body.join("\n"), quoted: cur.quoted, closed: false });
    for (let i = 1; i < queue.length; i++) {
      const h = queue[i] as HeredocStart;
      out.push({ body: "", quoted: h.quoted, closed: false });
    }
  }
  return out;
}

const ASSIGN_RE = /^(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]+)(?=\s|$)\s*/;

/** Expands `$NAME` / `${NAME}` in an assignment value. Null when any reference is unknown or the value is empty. */
function assignmentValue(raw: string, vars: ReadonlyMap<string, string>): string | null {
  let inner = raw;
  let quoted: "'" | '"' | "" = "";
  if (raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw[raw.length - 1] === raw[0]) {
    quoted = raw[0] as "'" | '"';
    inner = raw.slice(1, -1);
  }
  if (inner === "") return null;
  // Single quotes are literal, including `$`. A later use rejects a value that still contains `$`.
  if (quoted === "'") return inner;
  if (inner.includes("`") || inner.includes("$(")) return null;
  let unknown = false;
  const out = inner.replace(VAR_REF_RE, (_all, braced: string | undefined, bare: string | undefined) => {
    const v = vars.get((braced ?? bare) as string);
    if (v === undefined) unknown = true;
    return v ?? "";
  });
  if (unknown || out === "" || out.includes("$") || out.includes("`")) return null;
  return out;
}

/** Literal `NAME=value` assignments at the start of a segment (also `export NAME=value` and inline env prefixes). */
function collectAssignments(seg: string, vars: Map<string, string>): void {
  let s = seg.trim();
  const exported = s.startsWith("export ");
  const found: [string, string | null][] = [];
  for (let guard = 0; guard < 10; guard++) {
    const m = ASSIGN_RE.exec(s);
    if (!m) break;
    // Same-segment assignments are not visible to each other: the shell expands the values first.
    found.push([m[1] as string, assignmentValue(m[2] as string, vars)]);
    s = s.slice(m[0].length);
  }
  // `NAME=x cmd` sets NAME for cmd only: later segments do not see it (and `$NAME` in cmd is expanded before it).
  if (s.trim() !== "" && !exported) return;
  for (const [name, v] of found) {
    if (v === null) vars.delete(name);
    else vars.set(name, v);
  }
}

/** A value made only of `NAME=value` words (`GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=y`). */
const ENV_WORD_VALUE = /^(?:[A-Za-z_]\w*=(?:[^\s"']+|"[^"]*"|'[^']*'))(?:\s+[A-Za-z_]\w*=(?:[^\s"']+|"[^"]*"|'[^']*'))*$/;

/**
 * Replaces a whole word `$E` / `${E}` / `"$E"` / `"${E}"` with E's value when that value is only
 * `NAME=value` words, so `env $E git …` strips like `env NAME=value`. Any other value stays put.
 */
function expandEnvSlots(seg: string, vars: ReadonlyMap<string, string>): string {
  if (!seg.includes("$") || vars.size === 0) return seg;
  let out = "";
  let i = 0;
  let quote: '"' | "'" | null = null;
  const n = seg.length;
  const boundary = (idx: number): boolean => idx < 0 || idx >= n || /[\s;&|<>()]/.test(seg[idx] as string);
  while (i < n) {
    const c = seg[i] as string;
    if (quote !== null) {
      out += c;
      if (c === "\\" && quote === '"') {
        out += seg[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    const rest = seg.slice(i);
    const quotedRef = c === '"' ? /^"\$(?:\{(\w+)\}|(\w+))"/.exec(rest) : null;
    const bareRef = c === "$" ? /^\$(?:\{(\w+)\}|(\w+))/.exec(rest) : null;
    const ref = quotedRef ?? bareRef;
    if (ref && boundary(i - 1) && boundary(i + ref[0].length)) {
      const v = vars.get((ref[1] ?? ref[2]) as string);
      if (v !== undefined && ENV_WORD_VALUE.test(v)) {
        out += v;
        i += ref[0].length;
        continue;
      }
    }
    if (c === "'" || c === '"') quote = c;
    out += c;
    i++;
  }
  return out;
}

const SAFE_HEADS = new Set(
  (
    "cd pushd popd echo printf ls cat true false : test [ [[ sleep export set unset pwd EOF " +
    // read-only text and system tools
    "tail head grep egrep fgrep rg cut wc tr sort uniq diff cmp jq column nl basename dirname realpath readlink stat file du df date seq which type whoami hostname -v -V " +
    // shell keywords and grouping
    "for do done if then else elif fi while until case esac break continue exit return { } ( ) " +
    // creates directories only; terminal control
    "mkdir rmdir herdr"
  ).split(" "),
);
const SAFE_GIT = new Set(["add", "commit", "status", "log", "diff", "show", "branch", "push", "fetch", "remote", "rev-parse", "rev-list", "merge-base", "show-ref", "grep", "ls-files", "tag", "describe"]);
const SAFE_WORKTREE = new Set(["add", "remove", "prune", "list"]);

const SED_SUBST_WRITE_RE = /(?:^|[;{}\s!])s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[0-9gIiMmp]*[we]/;

/** `sed` that neither edits in place nor writes a file (`w` / `W`), nor runs a command (`e`, `s///e`). */
function isReadOnlySed(words: Word[]): boolean {
  for (const w of words.slice(1)) {
    const t = w.text;
    if (t === "--in-place" || t.startsWith("--in-place=") || /^-[A-Za-z]*i/.test(t)) return false;
    if (/(?:^|[;{}\s!])[wW]\s*\S/.test(t) || /(?:^|[;{}\s!])e(?:\s|$|;|\})/.test(t) || SED_SUBST_WRITE_RE.test(t)) return false;
  }
  return true;
}

/** `sort -o f` / `--output=f`, `uniq in out`: read-only tools with an output file. */
function writesOutputFile(head: string, words: Word[]): boolean {
  const args = words.slice(1).map((w) => w.text);
  if (head === "sort") return args.some((t) => t === "--output" || t.startsWith("--output=") || /^-[A-Za-z]*o/.test(t));
  if (head === "uniq") {
    let positional = 0;
    for (let i = 0; i < args.length; i++) {
      const t = args[i] as string;
      if (t === "-f" || t === "-s" || t === "-w") i++;
      else if (!t.startsWith("-") || t === "-") positional++;
    }
    return positional >= 2;
  }
  return false;
}

/**
 * A redirect that may write a file we do not see as an edit: any unknown target; for descriptors other than stdout
 * (`2> f`, `&> f`, `>& f`) also a known target that is neither scratch/log nor documentation.
 */
function writesUnseen(r: Redirect, poisoned?: ReadonlySet<string>): boolean {
  if (r.target === null) return true;
  // `$S/…`, `$TMPDIR/…`, logs and other scratch targets are not work-tree writes, even before `$S` is substituted.
  if (isIgnoredPath(r.target.text, poisoned)) return false;
  if (isUnknownTarget(r.target)) return true;
  if (r.fd === "" || r.fd === "1") return false;
  return !isDocPath(r.target.text);
}

/** Working directory while one command is scanned. `rel` is joined onto the session cwd later. */
type Dir = { k: "session" } | { k: "abs"; path: string } | { k: "rel"; path: string } | { k: "unknown" };

const CD_FLAGS = new Set(["--", "-P", "-L", "-n", "--physical", "--logical"]);

/** One `cd` / `pushd` operand. Unknown forms (`-`, `~`, `$()`, an unset var) poison the directory. */
function concreteDir(w: Word, dir: Dir): Dir {
  if (w.dynamic || w.text === "" || w.text === "-" || w.text.startsWith("~") || w.text.includes("$") || w.text.includes("`") || w.text.includes("(")) {
    return { k: "unknown" };
  }
  if (w.text.startsWith("/")) return { k: "abs", path: normalizePath(w.text) };
  if (dir.k === "unknown") return { k: "unknown" };
  if (dir.k === "session") {
    const n = normalizePath(w.text);
    return n === "" || n === "." ? { k: "session" } : { k: "rel", path: n };
  }
  if (dir.k === "abs") return { k: "abs", path: normalizePath(`${dir.path}/${w.text}`) };
  const joined = normalizePath(`${dir.path}/${w.text}`);
  if (joined === "" || joined === ".") return { k: "session" };
  if (joined.startsWith("/")) return { k: "abs", path: joined };
  return { k: "rel", path: joined };
}

/** Index of the `)` matching the `(` at `open`, or -1 when it is not in `text`. Quote-aware. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Unquoted parentheses, matching what `splitSegments` counts. */
function unquotedParens(text: string): { opens: number; closes: number } {
  let opens = 0;
  let closes = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") opens++;
    else if (c === ")") closes++;
  }
  return { opens, closes };
}

/** A grouping `( … )`, not `$(…)`, `<(…)`, `>(…)`, `name()`, or `name=(…)`. */
function isGroupingSubshellOpen(text: string, i: number): boolean {
  const prev = i > 0 ? (text[i - 1] as string) : "";
  if (prev === "$" || prev === "<" || prev === ">" || prev === "=") return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j] as string)) j--;
  if (j >= 0 && /[A-Za-z0-9_]/.test(text[j] as string)) {
    let k = i + 1;
    while (k < text.length && /\s/.test(text[k] as string)) k++;
    if (k < text.length && text[k] === ")") return false;
  }
  return true;
}

/**
 * Grouping subshell parentheses in this segment. `stack` remembers opens from earlier segments,
 * so a `)` in a later segment still closes the subshell it belongs to. `$(…)`, function `name()`,
 * and array `name=(…)` do not: a `cd` there is not isolated by this stack.
 */
function consumeGroupingParens(text: string, stack: boolean[]): { opens: number; closes: number } {
  let opens = 0;
  let closes = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "(") {
      const grouping = isGroupingSubshellOpen(text, i);
      stack.push(grouping);
      if (grouping) opens++;
    } else if (c === ")") {
      if (stack.pop()) closes++;
    }
  }
  return { opens, closes };
}

/** Words stripped before the command word when looking for a directory hider (C16). */
const HIDER_SKIP = new Set(["!", "if", "elif", "then", "else", "while", "until", "do", "time", "{", "("]);

/**
 * Heads `stripPrefixes` removes before the real command. `command` and `exec` are absent on purpose:
 * they are hiders, except `command -v` / `-V`.
 */
const HIDER_WRAPPERS = new Set([
  "nice",
  "timeout",
  "env",
  "nohup",
  "time",
  "corepack",
  "flock",
  "ionice",
  "setsid",
  "stdbuf",
  "uv",
  "poetry",
  "pipenv",
  "npx",
  "bunx",
  "pnpm",
  "yarn",
]);

const SUDO_VALUE_FLAGS = new Set([
  "-u",
  "-g",
  "-h",
  "-p",
  "-U",
  "-C",
  "-D",
  "-R",
  "-T",
  "--user",
  "--group",
  "--host",
  "--prompt",
  "--other-user",
  "--chdir",
  "--role",
  "--type",
  "--close-from",
  "--command-timeout",
]);

function leadingToken(s: string): string {
  const m = /^(?:\\+)?(\S+)/.exec(s);
  return (m?.[1] ?? "").replace(/^\\+/, "");
}

/** `sudo [-u user] … command` → `command`. Flags that take a value keep that value out of the head. */
function peelSudo(s: string): string {
  let rest = s.replace(/^sudo\s+/, "");
  for (let guard = 0; guard < 40; guard++) {
    const m = /^(?:"[^"]*"|'[^']*'|\S+)/.exec(rest);
    if (!m) return rest;
    const w = m[0];
    const after = rest.slice(m[0].length).trimStart();
    if (/^[A-Za-z_]\w*=/.test(w) && !w.startsWith("-")) {
      rest = after;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      rest = after;
      const flag = w.includes("=") ? w.slice(0, w.indexOf("=")) : w;
      if (SUDO_VALUE_FLAGS.has(flag) && !w.includes("=")) {
        const v = /^(?:"[^"]*"|'[^']*'|\S+)/.exec(rest);
        if (v) rest = rest.slice(v[0].length).trimStart();
      }
      continue;
    }
    return rest;
  }
  return rest;
}

/**
 * Drop the wrapper prefixes the check matcher drops, so the hider check sees `eval` / `source`
 * behind `nice`, `sudo -u`, `env NAME=v`, `time -p`, `timeout`, `flock`, and the rest of PREFIXES.
 * Stops at `command` / `exec` (a following `stripPrefixes` would delete them).
 */
function stripHiderWrappers(segment: string): string {
  let s = segment.trim();
  for (let guard = 0; guard < 20; guard++) {
    const before = s;
    s = s.replace(/^[({!]+\s*/, "").replace(/^(?:!|if|elif|then|else|while|until|do)\s+/, "");
    s = s.replace(/^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "");
    const head = leadingToken(s);
    if (head === "command" || head === "exec") return s.trimStart();
    if (head === "sudo") s = peelSudo(s);
    else if (HIDER_WRAPPERS.has(head)) {
      // Keep a later `command` / `exec` (`nice command -v`, `nohup exec`) from being stripped too.
      const shielded = s.replace(/(?<=\s)((?:\\+)?(?:command|exec))(?=\s|$)/g, "\u0000$1");
      s = stripPrefixes(shielded).replace(/\u0000/g, "").trimStart();
    }
    // `time -p source` → stripPrefixes leaves `-p source`.
    s = s.replace(/^(?:-\S+\s+)+/, "").trimStart();
    if (s === before) break;
  }
  return s.trimStart();
}

/**
 * True when this segment's command word is `eval`, `source`, `.`, `builtin`, `exec`, or `command`
 * not followed by `-v` / `-V`. The tracked directory is unknown from here on.
 * `pnpm exec` is not the builtin: only the command word counts. `(` / `{` stuck to the word are stripped.
 */
function hidesDirectory(segment: string): boolean {
  const words = parseWords(stripHiderWrappers(segment)).words;
  let i = 0;
  while (i < words.length) {
    const t = (words[i] as Word).text.replace(/^[({!]+/, "");
    if (t === "" || HIDER_SKIP.has(t) || /^[A-Za-z_]\w*=/.test(t)) {
      i++;
      continue;
    }
    if (t === "command") {
      const next = (words[i + 1]?.text ?? "").replace(/^[({!]+/, "");
      return next !== "-v" && next !== "-V";
    }
    if (t.startsWith("-") && t !== "-") {
      i++;
      continue;
    }
    return t === "eval" || t === "source" || t === "." || t === "builtin" || t === "exec";
  }
  return false;
}

/** Directory after this `cd` / `pushd`. No operand, an extra operand, or an unknown flag poisons it. */
function nextDir(words: Word[], dir: Dir): Dir {
  const ops: Word[] = [];
  for (const w of words.slice(1)) {
    if (CD_FLAGS.has(w.text)) continue;
    if (w.text.startsWith("-") && w.text !== "-" && w.text.length > 1) return { k: "unknown" };
    ops.push(w);
  }
  if (ops.length !== 1) return { k: "unknown" };
  return concreteDir(ops[0] as Word, dir);
}

/** Literal absolute `cd` / `pushd` operand, before `$` substitution. Anything else is null. */
function literalAbsPath(words: Word[]): string | null {
  const placed = nextDir(words, { k: "unknown" });
  return placed.k === "abs" ? placed.path : null;
}

/** Operator that closed a segment, at the grouping and compound depth it actually sits at. */
interface ListMark {
  afterParen: number;
  afterCompound: number;
  op: string;
}

function groupingDepth(stack: readonly boolean[]): number {
  let n = 0;
  for (const open of stack) if (open) n++;
  return n;
}

function restoredSegment(seg: Segment): string {
  const seen = unquotedParens(seg.text);
  return seg.text + ")".repeat(Math.max(0, seg.closes - seen.closes));
}

/**
 * A `||` earlier in this and-or list, at the same grouping and compound depth.
 * Nested `(…)` / `if` bodies are a different list: an outer `||` does not count.
 */
function precededByOr(history: readonly ListMark[], baseParen: number, baseCompound: number): boolean {
  for (let j = history.length - 1; j >= 0; j--) {
    const prev = history[j] as ListMark;
    if (prev.afterParen === baseParen && prev.afterCompound === baseCompound) {
      if (prev.op === "||") return true;
      if (prev.op === "&&") continue;
      return false;
    }
    if (prev.afterParen < baseParen || prev.afterCompound < baseCompound) return false;
  }
  return false;
}

/**
 * The and-or list that starts at `index` is backgrounded (`&` terminates it).
 * `&&` and `||` stay in the list. `;`, a newline, `|`, `&`, and a closing keyword end it.
 * Operators inside a compound command or a deeper subshell do not end the outer list.
 */
function listEndsWithAmp(
  segs: Segment[],
  index: number,
  stackAfter: readonly boolean[],
  opParen: number,
  opCompound: number,
  baseParen: number,
  baseCompound: number,
  currentOp: string,
): boolean {
  const connector = (op: string): boolean => op === "&&" || op === "||";
  if (opParen === baseParen && opCompound === baseCompound && !connector(currentOp)) return currentOp === "&";
  const stack = stackAfter.slice();
  let compound = opCompound;
  for (let j = index + 1; j < segs.length; j++) {
    const seg = segs[j] as Segment;
    consumeGroupingParens(restoredSegment(seg), stack);
    const head = commandHead(seg.text);
    if (COMPOUND_INC.has(head)) compound++;
    else if (COMPOUND_DEC.has(head)) compound = Math.max(0, compound - 1);
    const afterParen = groupingDepth(stack);
    if (afterParen === baseParen && compound === baseCompound && !connector(seg.op)) return seg.op === "&";
    if (afterParen < baseParen || compound < baseCompound) return false;
  }
  return false;
}

/**
 * Where a relative target is read from. An absolute `cd` is baked into `file` (callers read `file`).
 * `baseDir: ""` is the session cwd, so an earlier relative target still resolves when a later `cd` ran.
 * `docDir` is an untrusted literal absolute `cd` (C18): only a documentation name is placed there.
 */
function placeFile(file: string, dir: Dir, sawCd: boolean, docDir: string | null): { file: string; baseDir?: string } {
  if (file === SHELL_EDIT_FILE || file.startsWith("~")) return { file };
  if (file.startsWith("/")) return { file: normalizePath(file) };
  const rel = canonicalizeEditPath(file);
  if (dir.k === "unknown") {
    if (docDir !== null && isDocPath(rel)) return { file: normalizePath(`${docDir}/${rel}`) };
    return { file: SHELL_EDIT_FILE };
  }
  if (dir.k === "abs") return { file: normalizePath(`${dir.path}/${file}`) };
  if (dir.k === "rel") return { file: rel, baseDir: dir.path };
  return sawCd ? { file: rel, baseDir: "" } : { file: rel };
}

/**
 * `npm ci`, or `pnpm` / `yarn` `install`|`i` with `--frozen-lockfile` / `--immutable` (any order, plus `-C` / `--dir` / `--prefix`).
 * `npm install` / `npm i` is never frozen: npm ignores `--frozen-lockfile` (C15).
 */
function isFrozenInstall(words: Word[]): boolean {
  const head = words[0]?.text;
  if (head !== "npm" && head !== "pnpm" && head !== "yarn") return false;
  const args: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const t = (words[i] as Word).text;
    if (t === "-C" || t === "--dir" || t === "--prefix" || t === "--cwd") {
      i++;
      continue;
    }
    if (t.startsWith("--dir=") || t.startsWith("--prefix=") || t.startsWith("--cwd=") || /^-C./.test(t)) continue;
    args.push(t);
  }
  const positional = args.filter((t) => !t.startsWith("-"));
  if (head === "npm") return positional[0] === "ci";
  const frozen = args.includes("--frozen-lockfile") || args.includes("--immutable");
  return (positional[0] === "install" || positional[0] === "i") && frozen;
}

/**
 * The word right after `node` (C17). Any interpreter option means this is not a gate script.
 * Later words are script arguments and are not examined.
 */
function scriptOperand(words: Word[]): Word | null {
  const w = words[1];
  if (w === undefined || w.text.startsWith("-")) return null;
  return w;
}

/**
 * Exactly `node scripts/gate.mjs` or `node ./scripts/gate.mjs` (C17). `cd scripts && node gate.mjs` resolves
 * to the same path. An absolute cwd counts only when that directory is the session repo root, a directory
 * under it, or a sibling worktree `<parent>/<basename>-<segment>` (C13), and the script is still `scripts/gate.mjs`.
 * `check*` / `verify*` / `validate*` and python gate scripts are not GATEREAD. An absolute script path fails closed.
 */
function isGateScript(words: Word[], dir: Dir, repoRoots: readonly string[]): boolean {
  if ((words[0]?.text ?? "") !== "node" || dir.k === "unknown") return false;
  const op = scriptOperand(words);
  if (op === null || op.dynamic || op.text.startsWith("/") || op.text.startsWith("~")) return false;
  if (dir.k === "abs") {
    if (!repoRoots.some((root) => gateDirTrusted(dir.path, root))) return false;
    return isScriptsGateFile(dir.path, op.text);
  }
  const joined = dir.k === "rel" ? `${dir.path}/${op.text}` : op.text;
  return normalizePath(joined) === "scripts/gate.mjs";
}

/** `<dir>/scripts/gate.mjs`, not a file nested under `scripts/` and not another script name. */
function isScriptsGateFile(dir: string, operand: string): boolean {
  const script = normalizePath(`${dir}/${operand}`);
  return script === `${normalizePath(dir)}/scripts/gate.mjs`;
}

/**
 * Absolute directory that may hold a repo gate script (C13). `<anything>` in the sibling form is one
 * path segment: the worktree directory itself, not a directory under that worktree.
 */
function gateDirTrusted(dir: string, repoRoot: string): boolean {
  const d = normalizePath(dir);
  const root = normalizePath(repoRoot);
  if (!d.startsWith("/") || !root.startsWith("/")) return false;
  if (d === root || d.startsWith(`${root}/`)) return true;
  const slash = root.lastIndexOf("/");
  const parent = root.slice(0, slash);
  const base = root.slice(slash + 1);
  if (base === "") return false;
  const prefix = `${parent}/${base}-`;
  if (!d.startsWith(prefix)) return false;
  const rest = d.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

function asRepoRoots(repoRoot: string | readonly (string | null | undefined)[] | null | undefined): string[] {
  if (repoRoot == null) return [];
  const list = typeof repoRoot === "string" ? [repoRoot] : repoRoot;
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string" || !raw.startsWith("/")) continue;
    const n = normalizePath(raw);
    if (n.startsWith("/") && !out.includes(n)) out.push(n);
  }
  return out;
}

const DIR_CMD = new Set(["cd", "pushd", "popd"]);
const COMPOUND_INC = new Set(["if", "while", "until", "for", "case"]);
const COMPOUND_OPEN = new Set(["if", "elif", "while", "until", "for", "case"]);
const COMPOUND_DEC = new Set(["fi", "done", "esac"]);

/** Command word after the same prefix strip the mutation scan uses. */
function commandHead(segment: string): string {
  const { words } = parseWords(normalizeFirstToken(stripPrefixes(segment)));
  return words[0]?.text ?? "";
}

/** Body of `` `...` `` or `$(...)` starting at `i`, and the index just after it. */
function readCommandNest(s: string, i: number): { body: string; next: number } {
  if (s[i] === "`") {
    const end = s.indexOf("`", i + 1);
    if (end < 0) return { body: s.slice(i + 1), next: s.length };
    return { body: s.slice(i + 1, end), next: end + 1 };
  }
  const end = closeParen(s, i + 1);
  if (end < 0) return { body: s.slice(i + 2), next: s.length };
  return { body: s.slice(i + 2, end), next: end + 1 };
}

/**
 * R1: the text inside every `$(…)`, backtick and `<(…)` / `>(…)` of a command (single quotes skipped,
 * double quotes not). `unsure` when one cannot be followed to its end. `$((…))` is arithmetic: not a body.
 */
function substitutionBodies(cmd: string, heredocBody = false): { bodies: string[]; unsure: boolean } {
  const bodies: string[] = [];
  let unsure = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (!heredocBody && c === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (!heredocBody && c === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (c === "`") {
      let end = -1;
      for (let j = i + 1; j < cmd.length; j++) {
        if (cmd[j] === "\\") j++;
        else if (cmd[j] === "`") {
          end = j;
          break;
        }
      }
      if (end < 0) {
        unsure = true;
        bodies.push(cmd.slice(i + 1).replace(/\\`/g, "`"));
        break;
      }
      bodies.push(cmd.slice(i + 1, end).replace(/\\`/g, "`"));
      i = end;
      continue;
    }
    const dollar = c === "$" && cmd[i + 1] === "(";
    const proc = !heredocBody && quote === null && (c === "<" || c === ">") && cmd[i + 1] === "(";
    if (!dollar && !proc) continue;
    if (dollar && cmd[i + 2] === "(") {
      i += 2; // arithmetic or a nested group: keep scanning inside it
      continue;
    }
    const open = i + 1;
    const close = closeParen(cmd, open);
    if (close < 0) {
      unsure = true;
      bodies.push(cmd.slice(open + 1));
      break;
    }
    bodies.push(cmd.slice(open + 1, close));
    i = close;
  }
  return { bodies, unsure };
}

/**
 * Bare `cd` / `pushd` / `popd` words, including inside `$(...)` and backticks.
 * Quoted text is skipped (a quoted `cd` does not run), except those nests, which do.
 * `/tmp/cd` is one word, not a `cd`.
 */
function bareDirWordCount(s: string): number {
  let count = 0;
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < s.length) {
    const c = s[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (c === '"') {
        quote = null;
        i++;
        continue;
      }
      if (c === "`" || (c === "$" && s[i + 1] === "(")) {
        const nested = readCommandNest(s, i);
        count += bareDirWordCount(nested.body);
        i = nested.next;
        continue;
      }
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }
    if (c === "`" || (c === "$" && s[i + 1] === "(")) {
      const nested = readCommandNest(s, i);
      count += bareDirWordCount(nested.body);
      i = nested.next;
      continue;
    }
    if (!/[\s|&;<>(){}]/.test(c)) {
      const start = i;
      while (i < s.length) {
        const d = s[i] as string;
        if (/[\s|&;<>(){}"'\\`]/.test(d)) break;
        if (d === "$" && s[i + 1] === "(") break;
        i++;
      }
      if (DIR_CMD.has(s.slice(start, i))) count++;
      continue;
    }
    i++;
  }
  return count;
}

/** `f()` / `function f` starts a function. The body is not the current shell. */
function startsFunction(segment: string): boolean {
  const t = segment.trim().replace(/^[({!]+\s*/, "");
  if (/^function\s+[A-Za-z_]\w*/.test(t)) return true;
  return /^[A-Za-z_]\w*\s*\(\s*\)/.test(t);
}

/** An alias whose text names `cd` / `pushd` / `popd` (quotes included: the value is the definition). */
function aliasDefinesDirChange(segment: string): boolean {
  if (commandHead(segment) !== "alias") return false;
  return /(^|[^A-Za-z0-9_])(cd|pushd|popd)(?![A-Za-z0-9_])/.test(segment);
}

function countBraces(segment: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (quote !== null) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "{") open++;
    else if (c === "}") close++;
  }
  return { open, close };
}

/**
 * Temp names (`S`, `TMP`, `TMPDIR`, `TEMP`, `SCRATCH*`) this segment assigns to something other than a
 * temp root, or binds with `for` / `read`. Callers add them before this segment's own writes, so an
 * earlier use keeps the by-name scratch rule. A prefix `NAME=value cmd` does not: the shell expands
 * that command before the assignment, and the assignment does not survive it. `vars` is the map from
 * earlier segments (same-segment assignments are not visible to each other).
 */
function poisonTempNamesInSegment(text: string, vars: ReadonlyMap<string, string>, poisoned: Set<string>): void {
  let s = text.trim();
  const exported = s.startsWith("export ");
  const found: [string, string | null][] = [];
  for (let guard = 0; guard < 10; guard++) {
    const m = ASSIGN_RE.exec(s);
    if (!m) break;
    found.push([m[1] as string, assignmentValue(m[2] as string, vars)]);
    s = s.slice(m[0].length);
  }
  if (s.trim() === "" || exported) {
    for (const [name, value] of found) {
      if (TEMP_NAME_RE.test(name) && !isTempRootValue(value)) poisoned.add(name);
    }
  }
  const { words } = parseWords(text);
  for (let i = 0; i < words.length; i++) {
    const t = (words[i] as Word).text;
    if (t === "for") {
      const name = words[i + 1]?.text ?? "";
      if (TEMP_NAME_RE.test(name)) poisoned.add(name);
    } else if (t === "read") {
      let j = i + 1;
      while (j < words.length && /^-[A-Za-z]+$/.test((words[j] as Word).text)) j++;
      while (j < words.length && TEMP_NAME_RE.test((words[j] as Word).text)) {
        poisoned.add((words[j] as Word).text);
        j++;
      }
    }
  }
}

/** `NODE_OPTIONS` / `PYTHONPATH` assigned in this segment (they stay in the environment for later segments). */
function assignsLoader(raw: string): boolean {
  let s = raw.trim();
  for (let guard = 0; guard < 10; guard++) {
    s = s.replace(/^[({!]+\s*/, "");
    const name = /^(?:export\s+)?([A-Za-z_]\w*)=/.exec(s);
    if (!name) return false;
    if (name[1] === "NODE_OPTIONS" || name[1] === "PYTHONPATH") return true;
    const full = /^(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*/.exec(s);
    if (!full) return false;
    s = s.slice(full[0].length);
    if (s.trim() === "") return false;
  }
  return false;
}

function looseTokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i] as string)) i++;
    if (i >= s.length) break;
    const q = s[i];
    if (q === "'" || q === '"') {
      const end = s.indexOf(q, i + 1);
      const stop = end < 0 ? s.length : end;
      out.push(s.slice(i + 1, stop));
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j] as string)) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

/** `env --chdir` / `env -C` before the command word (the value may be attached with `=` or be the next word). */
function envChangesDir(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "--chdir" || t.startsWith("--chdir=") || t === "-C" || t.startsWith("-C")) return true;
    if (t.startsWith("-") || /^[A-Za-z_]\w*=/.test(t)) continue;
    return false;
  }
  return false;
}

/** `sudo --chdir` before the command word. */
function sudoChangesDir(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "--chdir" || t.startsWith("--chdir=")) return true;
    if (t.startsWith("-") || /^[A-Za-z_]\w*=/.test(t)) continue;
    return false;
  }
  return false;
}

/**
 * A loader in front of this segment: `NODE_OPTIONS=`, `PYTHONPATH=`, `env --chdir`, `env -C`, `sudo --chdir`.
 * Other assignments (`FOO=1`, `S=/tmp`) do not block GATEREAD.
 */
function segmentGateBlocked(raw: string): boolean {
  let s = raw.trim();
  for (let guard = 0; guard < 20; guard++) {
    s = s.replace(/^[({!]+\s*/, "").replace(/^(?:do|then|else)\s+/, "");
    const assign = /^(?:export\s+)?([A-Za-z_]\w*)=(?:"[^"]*"|'[^']*'|\S*)(\s*)$|^(?:export\s+)?([A-Za-z_]\w*)=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(s);
    if (assign) {
      const name = (assign[1] ?? assign[3]) as string;
      if (name === "NODE_OPTIONS" || name === "PYTHONPATH") return true;
      if (assign[1] !== undefined) return false;
      s = s.slice(assign[0].length);
      continue;
    }
    if (/^env(?:\s|$)/.test(s)) {
      const tokens = looseTokens(s.replace(/^env\s*/, ""));
      if (envChangesDir(tokens)) return true;
      const cmdAt = tokens.findIndex((t) => !t.startsWith("-") && !/^[A-Za-z_]\w*=/.test(t));
      if (cmdAt < 0) return false;
      s = tokens.slice(cmdAt).join(" ");
      continue;
    }
    if (/^sudo(?:\s|$)/.test(s)) {
      const tokens = looseTokens(s.replace(/^sudo\s*/, ""));
      if (sudoChangesDir(tokens)) return true;
      const cmdAt = tokens.findIndex((t) => !t.startsWith("-") && !/^[A-Za-z_]\w*=/.test(t));
      if (cmdAt < 0) return false;
      s = tokens.slice(cmdAt).join(" ");
      continue;
    }
    return false;
  }
  return false;
}


/** Segments known not to write files (beyond what `segmentMutation` already reported). */
function isKnownNonWriting(
  rawWords: Word[],
  redirects: Redirect[],
  dir: Dir,
  vars: ReadonlyMap<string, string>,
  repoRoots: readonly string[],
  poisoned: ReadonlySet<string>,
  gateBlocked: boolean,
): boolean {
  const words = unwrapXargs(rawWords.map((w) => substituteKeepingClimb(w, vars, poisoned)));
  const head = words[0]?.text;
  if (head === undefined) return redirects.length === 0;
  // A write redirect to an unknown target is a write we cannot see.
  if (redirects.some((r) => writesUnseen(r, poisoned))) return false;
  if (/^[A-Za-z_]\w*=/.test(head)) return true;
  const git = gitSub(words);
  if (git !== null) {
    // `git diff --output=f` and friends write a file.
    if (SAFE_GIT.has(git.sub)) return !git.args.some((w) => /^--out(?:p(?:ut?)?)?(?:=|$)/.test(w.text));
    if (git.sub === "worktree") return SAFE_WORKTREE.has(git.args[0]?.text ?? "");
    if (git.sub === "config") return git.args.some((w) => w.text === "--get" || w.text === "--get-all" || w.text === "--list" || w.text === "-l");
    return false;
  }
  if (isFrozenInstall(words) || (!gateBlocked && isGateScript(words, dir, repoRoots))) return true;
  if (head === "sed" || head === "gsed") return isReadOnlySed(words);
  if (writesOutputFile(head, words)) return false;
  return SAFE_HEADS.has(head);
}

const XARGS_VALUE_OPTS = new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "-J"]);

/** `xargs [opts] cmd args`: the command with its words (the file operands come from stdin). */
function unwrapXargs(words: Word[]): Word[] {
  if (words[0]?.text !== "xargs") return words;
  let i = 1;
  while (i < words.length && (words[i] as Word).text.startsWith("-")) i += XARGS_VALUE_OPTS.has((words[i] as Word).text) ? 2 : 1;
  return words.slice(i);
}

function segmentMutation(
  rawWords: Word[],
  redirects: Redirect[],
  isCheck: boolean,
  pipedFromCheck: boolean,
  heredoc: string | null,
  heredocUnsure: boolean,
  vars: ReadonlyMap<string, string>,
  poisoned: ReadonlySet<string>,
): SegMut | null {
  const words = unwrapXargs(rawWords.map((w) => substituteKeepingClimb(w, vars, poisoned)));
  for (const r of redirects) if (r.target !== null) r.target = substituteKeepingClimb(r.target, vars, poisoned);
  const head = words[0]?.text ?? "";
  const files: MutFile[] = [];
  let gitOp = false;
  let history = false;
  let mutating = false;
  let surface = false;

  const git = gitSub(words);
  if (git !== null) {
    if (git.sub === "rm") {
      const hasCached = git.args.some((w) => w.text === "--cached");
      if (!hasCached) {
        const ops = git.args.filter((w) => !isOption(w));
        const targets = operandFiles(ops, poisoned);
        if (targets.length > 0) {
          gitOp = true;
          mutating = true;
          for (const f of targets) {
            files.push({ file: f, kind: "D" });
          }
        }
      }
    } else if (GIT_OPS.has(git.sub)) {
      gitOp = true;
      history = true;
      mutating = true;
      if (git.sub === "mv") {
        const ops = git.args.filter((w) => !isOption(w));
        if (ops.length >= 2) {
          const dest = ops[ops.length - 1]!;
          const sources = ops.slice(0, ops.length - 1);
          for (const src of sources) {
            for (const f of operandFiles([src], poisoned)) {
              files.push({ file: f, kind: "D" });
            }
          }
          for (const f of operandFiles([dest], poisoned)) {
            files.push({ file: f, kind: "A" });
          }
        } else if (ops.length === 1) {
          for (const f of operandFiles(ops, poisoned)) {
            files.push({ file: f, kind: "A" });
          }
        } else {
          files.push({ file: SHELL_EDIT_FILE, kind: "M" });
        }
      }
    } else if (git.sub === "apply" && !git.args.some((w) => GIT_APPLY_READONLY.has(w.text))) {
      mutating = true;
      files.push({ file: SHELL_EDIT_FILE, kind: "M" });
    }
  } else if (head === "sed" || head === "gsed") {
    const f = sedFiles(words.slice(1), poisoned);
    if (f !== null) {
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    }
  } else if (head === "perl") {
    const f = perlFiles(words.slice(1), poisoned);
    if (f !== null) {
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    }
  } else if (head === "tee" && !pipedFromCheck) {
    const f = teeFiles(words.slice(1), poisoned);
    mutating = f.length > 0;
    files.push(...f.map((file) => ({ file, kind: "M" as const })));
  } else if (/^python[\d.]*$/.test(head) && (heredoc !== null || heredocUnsure)) {
    // `python -c` is not scanned (C17: same as main). A heredoc, including a dash-less one, still is.
    const dash = words.findIndex((w) => w.text === "-");
    const argv = dash < 0 ? [] : words.slice(dash + 1).map((w) => shellArg(w, vars));
    const f = heredoc === null ? [SHELL_EDIT_FILE] : pythonWrites(heredoc, argv);
    surface = heredoc !== null && pythonHasSurface(heredoc);
    mutating = f.length > 0;
    files.push(...f.map((file) => ({ file, kind: "M" as const })));
  }

  // `cmd > file` / `cmd >> file`; a check's own redirects capture its log, not an edit.
  if (!isCheck) {
    for (const r of redirects) {
      if ((r.fd !== "" && r.fd !== "1") || r.target === null) continue;
      if (tempPrefixKind(r.target.text, poisoned) === "climb" || nonLiteralClimb(r.target.text)) {
        mutating = true;
        files.push({ file: SHELL_EDIT_FILE, kind: "M" as const });
        continue;
      }
      if (isUnknownTarget(r.target) || isIgnoredPath(r.target.text, poisoned)) continue;
      mutating = true;
      files.push({ file: r.target.text, kind: "M" as const });
    }
  }
  return mutating ? { gitOp, history, files, ...(surface ? { opaque: true } : {}) } : null;
}

/** Normalizes `.`/`..` segments of a path without touching the file system. */
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

/**
 * Makes a relative target absolute. `baseDir` omitted keeps the old rule (any `cd` leaves the target as written).
 * `""` is the session cwd; a relative string is joined onto it; an absolute string is the directory itself.
 */
export function resolveTarget(file: string, cwd: string | null, hasCd: boolean, baseDir?: string | null): string {
  if (file === SHELL_EDIT_FILE || file.startsWith("/") || file.startsWith("~")) return file;
  if (baseDir === undefined) {
    if (hasCd || cwd === null || cwd === "" || !cwd.startsWith("/")) return file;
    return normalizePath(`${cwd}/${file}`);
  }
  if (baseDir === null) return file;
  let base: string;
  if (baseDir === "" || baseDir === ".") {
    if (cwd === null || cwd === "" || !cwd.startsWith("/")) return file;
    base = cwd;
  } else if (baseDir.startsWith("/")) {
    base = baseDir;
  } else if (cwd !== null && cwd.startsWith("/")) {
    base = `${cwd}/${baseDir}`;
  } else {
    return normalizePath(`${baseDir}/${file}`);
  }
  return normalizePath(`${base}/${file}`);
}

/**
 * Heuristic view of a Bash command's file mutations. Does not decide whether the command succeeded:
 * the caller counts the result only for successful calls.
 */
export function classifyShellMutation(
  command: string,
  repo?: RepoScripts,
  repoRoot?: string | readonly (string | null | undefined)[] | null,
): ShellMutation {
  try {
    if (typeof command !== "string" || command.trim() === "") return NONE;
    const repoRoots = asRepoRoots(repoRoot);
    const segs = splitSegments(stripHeredocs(command));
    const checkIdx: number[] = [];
    const plainIdx: number[] = [];
    const edits: ShellEditTarget[] = [];
    const seen = new Set<string>();
    let anyMutating = false;
    let anyPlain = false;
    let hasCd = false;
    let hasHistoryGitOp = false;
    let prevCheck = false;
    let prevPipe = false;
    const vars = new Map<string, string>();
    const bodies = command.includes("<<") ? heredocBodies(command) : [];
    let heredocs = 0;
    let pipeHeredoc: number | null = null;
    let opaque = false;
    let truncated = false;
    let dir: Dir = { k: "session" };
    let sawCd = false;
    // Untrusted `cd` / `pushd` / `popd` outside a subshell leaves the directory unknown.
    // A grouping `( … )` saves the directory state and puts it back at the closing `)`.
    let sticky = false;
    // Literal absolute `cd` / `pushd` that does not resolve code (C18, or a C19 chain that has ended).
    // Documentation is placed there; every other relative target stays unresolved.
    let docDir: string | null = null;
    // C19: code resolves only while this `cd &&` chain is still open, at `chainParen` / `chainCompound`.
    let chainCode = false;
    let chainDoc: string | null = null;
    let chainParen = 0;
    let chainCompound = 0;
    let compound = 0;
    let funcDepth = 0;
    let funcBraces = 0;
    // `NODE_OPTIONS` / `PYTHONPATH` from an earlier segment of this command.
    let loaderEnv = false;
    const poisoned = new Set<string>();
    const dirStack: {
      dir: Dir;
      sticky: boolean;
      docDir: string | null;
      chainCode: boolean;
      chainDoc: string | null;
      chainParen: number;
      chainCompound: number;
    }[] = [];
    const listMarks: ListMark[] = [];
    const groupingOpen: boolean[] = [];
    segs.forEach((seg, i) => {
      poisonTempNamesInSegment(seg.text, vars, poisoned);
      collectAssignments(seg.text, vars);
      // Vars first, then `$E` when E is only NAME=value words, then prefix stripping (C8).
      const expanded = expandEnvSlots(seg.text, vars);
      // `splitSegments` drops a trailing `)`. Put it back so the subshell close is visible.
      // `$(…)` / `name()` / `name=(` are not grouping subshells (`cd $(pwd)` stays in this shell).
      const seenParens = unquotedParens(seg.text);
      const restoredText = seg.text + ")".repeat(Math.max(0, seg.closes - seenParens.closes));
      const groups = consumeGroupingParens(restoredText, groupingOpen);
      for (let n = 0; n < groups.opens; n++) {
        dirStack.push({ dir, sticky, docDir, chainCode, chainDoc, chainParen, chainCompound });
      }
      // The heredoc fed to this segment's stdin: its own, or the one that opened the pipeline it belongs to.
      const segStarts = parseHeredocStarts(seg.text);
      const count = segStarts.length;
      const own = count > 0 ? heredocs + count - 1 : null;
      heredocs += count;
      if (!prevPipe) pipeHeredoc = null;
      if (own !== null) pipeHeredoc = own;
      const fed = own ?? (prevPipe ? pipeHeredoc : null);
      const heredoc = fed === null ? null : (bodies[fed] ?? null);
      // A piped python with no heredoc in its pipeline, while the command has one elsewhere: unsure, not "no write".
      const unsure = heredoc === null && prevPipe && heredocs > 0 && pipeHeredoc === null;
      const isCheck = matchSegment(expanded, repo);
      const hides = hidesDirectory(expanded);
      const { words, redirects } = parseWords(normalizeFirstToken(stripPrefixes(expanded)));
      const subWords = words.map((w) => substituteVars(w, vars));
      const head = subWords[0]?.text;
      // Bash applies this segment's redirections before `cd`, so they belong to the directory we are in now.
      // A hider (`eval`, `source`, `command`, …) makes this segment's own relative targets unresolved too.
      const placeDir: Dir = hides ? { k: "unknown" } : dir;
      const placeSaw = hides || sawCd;
      // A hider's own targets are unresolved. A redirect on this segment runs before its `cd`.
      const placeDoc = hides ? null : docDir;
      // `if cd` is nested via the opener even though `compound` increments after this decision.
      const opener = commandHead(expanded);
      const nested =
        compound > 0 || funcDepth > 0 || COMPOUND_OPEN.has(opener) || startsFunction(expanded) || dirStack.length > 1;
      const headIsDir = head === "cd" || head === "pushd" || head === "popd";
      const otherDir = bareDirWordCount(expanded) - (headIsDir ? 1 : 0) > 0 || aliasDefinesDirChange(expanded);
      const nextHead = commandHead(segs[i + 1]?.text ?? "");
      // Code follows a top-level `cd` / `pushd` only inside its `&&` chain (C19), or for the rest of the
      // command after `|| exit` / `|| return`. A `||` before the cd, or a list that ends in `&`, does neither.
      const dirHead = (head === "cd" || head === "pushd") && !otherDir && !nested && !hides && !prevPipe;
      const baseParen = dirStack.length;
      const baseCompound = compound;
      let skippedByOr = false;
      let backgrounded = false;
      if (dirHead && (seg.op === "&&" || seg.op === "||")) {
        skippedByOr = precededByOr(listMarks, baseParen, baseCompound);
        let opCompound = compound;
        if (COMPOUND_INC.has(opener)) opCompound++;
        else if (COMPOUND_DEC.has(opener)) opCompound = Math.max(0, opCompound - 1);
        backgrounded = listEndsWithAmp(
          segs,
          i,
          groupingOpen,
          groupingDepth(groupingOpen),
          opCompound,
          baseParen,
          baseCompound,
          seg.op,
        );
      }
      const exitGuard =
        dirHead && seg.op === "||" && (nextHead === "exit" || nextHead === "return") && !skippedByOr && !backgrounded;
      const andChain = dirHead && seg.op === "&&" && !skippedByOr && !backgrounded;
      if (hides) {
        hasCd = true;
        dir = { k: "unknown" };
        sawCd = true;
        docDir = null;
        chainCode = false;
      } else if (exitGuard) {
        // `cd || exit` / `cd || return`: a failed cd does not reach the rest of the command.
        hasCd = true;
        const next = nextDir(subWords, dir);
        dir = next;
        sawCd = true;
        docDir = null;
        chainCode = false;
        if (next.k !== "unknown") sticky = false;
      } else if (andChain) {
        hasCd = true;
        const next = nextDir(subWords, dir);
        dir = next;
        sawCd = true;
        docDir = null;
        chainCode = true;
        chainDoc = literalAbsPath(words);
        chainParen = baseParen;
        chainCompound = baseCompound;
        // A known directory is trustworthy again. An unknown target (`cd -`, `cd ~`) poisons without sticking,
        // so a subshell can still restore the directory outside it.
        if (next.k !== "unknown") sticky = false;
      } else if (dirHead && seg.op === "&&") {
        // `true || cd && …`, or `cd && … &`. The cd may not have run in this shell. Code stays unresolved;
        // a literal absolute operand still places documentation (C18).
        hasCd = true;
        dir = { k: "unknown" };
        sawCd = true;
        sticky = true;
        chainCode = false;
        docDir = literalAbsPath(words);
      } else if (head === "popd" || headIsDir || otherDir) {
        // Any other `cd` / `pushd` / `popd` (`;`, newline, pipeline, `&`, `||`, compound, function, `$(…)`, alias).
        hasCd = true;
        dir = { k: "unknown" };
        sawCd = true;
        sticky = true;
        chainCode = false;
        // `;` / newline to a literal absolute directory still places documentation (C18). The operand is
        // read before substitution, so `$S/…` and `$(…)` do not. A relative operand does not either.
        const softAbs =
          (head === "cd" || head === "pushd") &&
          !otherDir &&
          !nested &&
          !hides &&
          !prevPipe &&
          (seg.op === ";" || seg.op === "\n");
        const placed = softAbs ? nextDir(words, { k: "unknown" }) : { k: "unknown" as const };
        docDir = placed.k === "abs" ? placed.path : null;
      }
      const gateBlocked = loaderEnv || segmentGateBlocked(expanded);
      if (assignsLoader(expanded)) loaderEnv = true;
      const m = segmentMutation(words, redirects, isCheck, prevPipe && prevCheck, heredoc, unsure, vars, poisoned);
      if (m === null && !isCheck && !isKnownNonWriting(words, redirects, placeDir, vars, repoRoots, poisoned, gateBlocked)) opaque = true;
      prevCheck = isCheck;
      prevPipe = seg.op === "|";
      if (isCheck) checkIdx.push(i);
      if (m !== null) {
        anyMutating = true;
        if (m.opaque) opaque = true;
        if (m.history) hasHistoryGitOp = true;
        if (!m.gitOp) {
          anyPlain = true;
          plainIdx.push(i);
        }
        for (const f of m.files) {
          const placed = placeFile(f.file, placeDir, placeSaw, placeDoc);
          const kind = f.kind ?? "M";
          const key = `${m.gitOp ? "g" : "e"}\u0000${kind}\u0000${placed.file}\u0000${placed.baseDir ?? ""}`;
          if (seen.has(key)) continue;
          if (edits.length >= FILES_MAX) {
            truncated = true;
            continue;
          }
          seen.add(key);
          edits.push(
            placed.baseDir === undefined
              ? { file: placed.file, gitOp: m.gitOp, kind }
              : { file: placed.file, gitOp: m.gitOp, kind, baseDir: placed.baseDir },
          );
        }
      }
      for (let n = 0; n < groups.closes; n++) {
        const frame = dirStack.pop();
        if (frame) {
          dir = frame.dir;
          sticky = frame.sticky;
          docDir = frame.docDir;
          chainCode = frame.chainCode;
          chainDoc = frame.chainDoc;
          chainParen = frame.chainParen;
          chainCompound = frame.chainCompound;
        }
      }
      if (COMPOUND_INC.has(opener)) compound++;
      else if (COMPOUND_DEC.has(opener)) compound = Math.max(0, compound - 1);
      if (startsFunction(expanded)) funcDepth++;
      if (funcDepth > 0) {
        const braces = countBraces(expanded);
        funcBraces += braces.open - braces.close;
        if (funcBraces <= 0) {
          funcDepth = Math.max(0, funcDepth - 1);
          funcBraces = 0;
        }
      }
      // The segment was placed with the chain directory. A terminator at the chain's own depth
      // (`;`, newline, `|`, `||`, `&`, end) drops code resolution. A literal absolute cd keeps docs.
      if (chainCode && dirStack.length === chainParen && compound === chainCompound && seg.op !== "&&") {
        dir = { k: "unknown" };
        docDir = chainDoc;
        sawCd = true;
        sticky = true;
        chainCode = false;
      }
      listMarks.push({ afterParen: dirStack.length, afterCompound: compound, op: seg.op });
    });
    // R1: command substitutions are commands of their own. A `cd` inside never leaks out.
    const nests = substitutionBodies(stripHeredocs(command));
    // H1: an unquoted heredoc body is expanded by bash; quotes in it are literal.
    if (command.includes("<<")) {
      for (const h of heredocParts(command)) {
        // D3: a heredoc never closed (strict delimiter match) swallows the rest: fail closed.
        if (!h.closed) opaque = true;
        if (h.quoted) continue;
        const inner = substitutionBodies(h.body, true);
        if (inner.unsure) nests.unsure = true;
        // D2: a heredoc nested in a substitution of a heredoc body is not followed: fail closed.
        if (inner.bodies.some((b) => b.includes("<<"))) opaque = true;
        nests.bodies.push(...inner.bodies);
      }
    }
    if (nests.unsure) opaque = true;
    for (const body of nests.bodies) {
      if (body.trim() === "") continue;
      // H3: `case` patterns close with a bare `)`: the body may be cut short. Opaque; found edits are kept.
      if (/\bcase\b/.test(body)) opaque = true;
      const inner = classifyShellMutation(body, repo, repoRoot);
      if (inner.opaque) opaque = true;
      if (inner.edits.length === 0) continue;
      anyMutating = true;
      if (!inner.gitOnly) anyPlain = true;
      if (inner.hasHistoryGitOp) hasHistoryGitOp = true;
      const hostAt = segs.findIndex((x) => x.text.includes(body));
      if (!inner.gitOnly) plainIdx.push(hostAt < 0 ? segs.length - 1 : hostAt);
      for (const e of inner.edits) {
        // A relative target after an outer `cd` has no known directory.
        const lost = hasCd && e.baseDir === undefined && !e.file.startsWith("/") && !e.file.startsWith("~");
        const target: ShellEditTarget = lost ? { file: SHELL_EDIT_FILE, gitOp: e.gitOp, kind: e.kind ?? "M" } : e;
        const kind = target.kind ?? "M";
        const key = `${target.gitOp ? "g" : "e"}\u0000${kind}\u0000${target.file}\u0000${target.baseDir ?? ""}`;
        if (seen.has(key)) continue;
        if (edits.length >= FILES_MAX) {
          truncated = true;
          continue;
        }
        seen.add(key);
        edits.push(target);
      }
    }
    // A relative edit from before the first `cd` still belongs to the session cwd.
    if (hasCd) {
      for (const e of edits) {
        if (e.baseDir !== undefined || e.file === SHELL_EDIT_FILE || e.file.startsWith("/") || e.file.startsWith("~")) continue;
        e.baseDir = "";
      }
    }
    // No parsed edit used to drop `opaque`. Keep it: `python -c` stays opaque with no edit (as on main),
    // and `cd /tmp/other && node scripts/gate.mjs` stays opaque (C13).
    if (!anyMutating) return opaque ? { ...NONE, hasCd, opaque: true } : NONE;
    let order: ShellMutation["order"] = "unknown";
    if (checkIdx.length > 0 && plainIdx.length > 0) {
      const lastCheck = checkIdx[checkIdx.length - 1] as number;
      order = plainIdx.some((i) => i > lastCheck) ? "after-check" : "before-check";
    }
    return { edits, gitOnly: !anyPlain, order, hasCd, hasHistoryGitOp, opaque: opaque || truncated };
  } catch {
    return NONE;
  }
}
