/**
 * Heuristic detection of file edits made through Bash (`sed -i`, `tee`, `> file`, `git apply`, ...), for
 * sessions whose log carries no `bashEditDiff` (the session did not start inside the repo), and of
 * commands whose only mutating segments are git operations (merge, rebase, checkout, ...).
 * Pure string logic on the command, regex/linear, never throws.
 */
import { isDocPath } from "./hints.js";
import { matchSegment, normalizeFirstToken, splitSegments, stripHeredocs, stripPrefixes, type RepoScripts } from "./check-patterns.js";

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

const IGNORED_PATH_RES: RegExp[] = [
  /^\/dev\//,
  /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/,
  /(?:^|\/)\.cache(?:\/|$)/,
  /(?:^|\/)scratch[^/]*(?:\/|$)/,
  /(?:^|\/)[^/]*\.(?:log|out|err)$/,
  /(?:^|\/)(?:log|out|output|err|stdout|stderr)$/,
];

/**
 * A temp-variable path stays scratch while the remainder is under the variable.
 * `..` that normalises above the variable (`$S/../../src/a.ts`) is `climb`: unresolved, and a code edit (C16).
 * Ending exactly on the variable (`$S/foo/..`) is still scratch.
 */
function tempPrefixKind(p: string): "scratch" | "climb" | null {
  const m = TEMP_PREFIX_RE.exec(p);
  if (!m) return null;
  const rest = m[2];
  if (rest === undefined || rest === "") return "scratch";
  const norm = normalizePath(rest);
  if (norm === ".." || norm.startsWith("../")) return "climb";
  return "scratch";
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
function isIgnoredPath(p: string): boolean {
  const temp = tempPrefixKind(p);
  if (temp === "climb") return false;
  if (temp === "scratch") return true;
  const n = pathForIgnore(p);
  return IGNORED_PATH_RES.some((re) => re.test(n));
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
function operandFiles(ops: Word[]): string[] {
  const live = ops.filter((w) => !isIgnoredPath(w.text));
  if (live.length === 0 && ops.length > 0) return [];
  // A temp prefix that climbed out, or any dynamic operand, is an unresolved code edit.
  if (live.length === 0 || live.some((w) => w.dynamic || tempPrefixKind(w.text) === "climb")) return [SHELL_EDIT_FILE];
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

function sedFiles(args: Word[]): string[] | null {
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
  return operandFiles(ops);
}

function perlFiles(args: Word[]): string[] | null {
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
  return operandFiles(ops);
}

function teeFiles(args: Word[]): string[] {
  return operandFiles(args.filter((w) => !isOption(w)));
}

const GIT_APPLY_READONLY = new Set(["--check", "--stat", "--numstat", "--summary"]);

const PY_WRITE_RE = /\.write_(?:text|bytes)\s*\(/g;
const PY_OPEN_CALL_RE = /\bopen\s*\(/g;
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
  gitOp: boolean;
  /** A history-moving git operation (`GIT_OPS`), as opposed to `git rm` / `git apply`. */
  history: boolean;
  files: MutFile[];
  /** Parsed edits are present, but a per-file split would trust a `python -c` the allow-list rejects (C12). */
  opaque?: boolean;
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

/** Bodies of the heredocs of a command, in order of their start. */
function heredocBodies(cmd: string): string[] {
  const out: string[] = [];
  let delim: string | null = null;
  let body: string[] = [];
  for (const line of cmd.split("\n")) {
    if (delim !== null) {
      if (line.trim() === delim) {
        out.push(body.join("\n"));
        delim = null;
        body = [];
      } else body.push(line);
      continue;
    }
    const m = HEREDOC_START_RE.exec(line);
    if (m) delim = m[1] ?? m[2] ?? m[3] ?? null;
  }
  if (delim !== null) out.push(body.join("\n"));
  return out;
}

const HEREDOC_START_RE = /(?<!<)<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/;

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
    "cd pushd popd echo printf ls cat true false : test [ [[ sleep export set unset pwd " +
    // read-only text and system tools
    "tail head grep egrep fgrep rg cut wc tr sort uniq diff cmp jq column nl basename dirname realpath readlink stat file du df date which type whoami hostname -v -V " +
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
function writesUnseen(r: Redirect): boolean {
  if (r.target === null) return true;
  // `$S/…`, `$TMPDIR/…`, logs and other scratch targets are not work-tree writes, even before `$S` is substituted.
  if (isIgnoredPath(r.target.text)) return false;
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

/**
 * `$(...)` pairs fully inside this segment. `splitSegments` counts those parentheses as a subshell,
 * but they do not wrap the segment's own command (`cd $(pwd)` still runs in the current shell).
 * A trailing `)` is already removed from `seg.text`, so `closes` puts it back before the scan.
 */
function containedCommandSubs(text: string): number {
  let count = 0;
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
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const end = closeParen(text, i + 1);
      if (end >= 0) {
        count += 1 + containedCommandSubs(text.slice(i + 2, end));
        i = end;
      }
    }
  }
  return count;
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

/**
 * Where a relative target is read from. An absolute `cd` is baked into `file` (callers read `file`).
 * `baseDir: ""` is the session cwd, so an earlier relative target still resolves when a later `cd` ran.
 */
function placeFile(file: string, dir: Dir, sawCd: boolean): { file: string; baseDir?: string } {
  if (file === SHELL_EDIT_FILE || file.startsWith("~")) return { file };
  if (file.startsWith("/")) return { file: normalizePath(file) };
  const rel = canonicalizeEditPath(file);
  if (dir.k === "unknown") return { file: SHELL_EDIT_FILE };
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

const GATE_BASE_RE = /^(?:gate|check|verify|validate)[\w.-]*\.(?:mjs|cjs|js|py|ts)$/;

/**
 * The word right after `node` / `python` / `python3` (C16). Any interpreter option means this is not a gate script.
 * Later words are script arguments and are not examined.
 */
function scriptOperand(words: Word[]): Word | null {
  const w = words[1];
  if (w === undefined || w.text.startsWith("-")) return null;
  return w;
}

/**
 * `node` / `python` whose first real operand is `scripts/(gate|check|verify|validate)…`.
 * A relative cwd must stay repo-relative (`scripts/…`). An absolute cwd counts only when that directory
 * is the session repo root, a directory under it, or a sibling worktree `<parent>/<basename>-<segment>` (C13).
 * Any other absolute directory, or an absolute script path, fails closed.
 */
function isGateScript(words: Word[], dir: Dir, repoRoots: readonly string[]): boolean {
  const head = words[0]?.text ?? "";
  const kind = head === "node" ? "node" : /^python[\d.]*$/.test(head) ? "py" : null;
  if (kind === null || dir.k === "unknown") return false;
  const op = scriptOperand(words);
  if (op === null || op.dynamic || op.text.startsWith("/") || op.text.startsWith("~")) return false;
  if (dir.k === "abs") {
    if (!repoRoots.some((root) => gateDirTrusted(dir.path, root))) return false;
    return isScriptsGateFile(dir.path, op.text);
  }
  const joined = dir.k === "rel" ? `${dir.path}/${op.text}` : op.text;
  const p = normalizePath(joined);
  if (p.startsWith("/") || p.startsWith("..") || !p.startsWith("scripts/")) return false;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return GATE_BASE_RE.test(base);
}

/** `<dir>/scripts/<gate|check|verify|validate name>`, not a file nested under `scripts/`. */
function isScriptsGateFile(dir: string, operand: string): boolean {
  const script = normalizePath(`${dir}/${operand}`);
  const prefix = `${normalizePath(dir)}/scripts/`;
  if (!script.startsWith(prefix)) return false;
  const name = script.slice(prefix.length);
  return name !== "" && !name.includes("/") && GATE_BASE_RE.test(name);
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

/** Drops the common leading indent, the way `textwrap.dedent` does, so a quoted `-c` body binds at column 0. */
function dedent(src: string): string {
  const lines = src.split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const lead = /^[ \t]*/.exec(line);
    min = Math.min(min, lead ? lead[0].length : 0);
  }
  if (!Number.isFinite(min) || min === 0) return src;
  return lines.map((line) => (line.trim() === "" ? line : line.slice(min))).join("\n");
}

/** Comments and string contents blanked, so an escape or write API inside a literal is not one. Newlines stay. */
function pyCode(src: string): string {
  const stripped = stripPyComments(src);
  let out = "";
  let i = 0;
  while (i < stripped.length) {
    const c = stripped[i] as string;
    if (c !== '"' && c !== "'") {
      out += c;
      i++;
      continue;
    }
    const triple = stripped.startsWith(c + c + c, i);
    let j = i + (triple ? 3 : 1);
    if (triple) {
      const end = stripped.indexOf(c + c + c, j);
      j = end < 0 ? stripped.length : end + 3;
    } else {
      while (j < stripped.length && stripped[j] !== c && stripped[j] !== "\n") j += stripped[j] === "\\" ? 2 : 1;
      if (stripped[j] === c) j++;
    }
    for (let k = i; k < j; k++) out += stripped[k] === "\n" ? "\n" : " ";
    i = j;
  }
  return out;
}

/** Known `$VAR` / `${VAR}` inside a double-quoted `-c` source. Null when any reference is unknown or still dynamic. */
function substPySource(w: Word, vars: ReadonlyMap<string, string>): string | null {
  if (!w.dynamic) return w.text;
  if (w.text.includes("`") || w.text.includes("$(")) return null;
  let unknown = false;
  const out = w.text.replace(VAR_REF_RE, (_all, braced: string | undefined, bare: string | undefined) => {
    const v = vars.get((braced ?? bare) as string);
    if (v === undefined) unknown = true;
    return v ?? "";
  });
  if (unknown || out.includes("$") || out.includes("`")) return null;
  return out;
}

type PyC = { kind: "safe" } | { kind: "opaque" } | { kind: "write"; files: string[]; opaque?: boolean };

/** Positional or `mode=` argument of `open(…)`, or undefined for `open(path)` and keyword-only calls. */
function openModeArg(args: string): string | undefined {
  const parts = splitTop(args, ",").map((x) => x.trim());
  const kw = parts.find((x) => /^mode\s*=/.test(x));
  if (kw !== undefined) return kw.replace(/^mode\s*=\s*/, "").trim();
  const second = parts[1];
  if (second === undefined || /^\w+\s*=(?!=)/.test(second)) return undefined;
  return second.trim();
}

function modeLiteral(mode: string): string | null {
  const lit = /^(['"])([^'"\n]*)\1$/.exec(mode);
  return lit ? (lit[2] as string) : null;
}

/** Names a `python -c` source may use, besides keywords and names it assigns (C16). */
const PY_ALLOWED_IDENTS = new Set(
  (
    "print open len str int float bool list dict set tuple sorted min max sum range enumerate zip any all isinstance " +
    "read write replace split rsplit join strip lstrip rstrip splitlines startswith endswith lower upper format encode decode " +
    "get items keys values append extend count find json dumps loads re sub search match findall compile group math pi sqrt floor ceil"
  ).split(" "),
);

const PY_KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is " +
    "lambda nonlocal not or pass raise return try while with yield match case"
  ).split(" "),
);

/** The only import statements that stay non-opaque: `import json`, `import re`, `import math`. */
const PY_IMPORT_OK = new Set(["json", "re", "math"]);

/** Simple `name =` and `for name in` bindings, on code with strings blanked. */
function assignedNames(blank: string): Set<string> {
  const names = new Set<string>();
  for (const m of blank.matchAll(/(?:^|[^A-Za-z0-9_.])([A-Za-z_]\w*)\s*=(?!=)/g)) names.add(m[1] as string);
  for (const m of blank.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) names.add(m[1] as string);
  return names;
}

/**
 * Literal string bindings in effect before `at`. An indented binding poisons the name (it may not run).
 * Only a string literal, or a name already bound to one, counts. Concatenation does not.
 */
function literalBindsAt(src: string, at: number): Map<string, string | null> {
  const bound = new Map<string, string | null>();
  for (const m of src.matchAll(PY_BIND_RE)) {
    const name = m[1] as string;
    const bindAt = (m.index ?? 0) + m[0].indexOf(name);
    if (bindAt >= at) break;
    const lineStart = src.lastIndexOf("\n", bindAt - 1) + 1;
    const nested = (/^[ \t]*/.exec(src.slice(lineStart))?.[0] ?? "") !== "";
    if (nested) {
      bound.set(name, null);
      continue;
    }
    const expr = (m[2] as string).trim();
    const lit = /^(['"])([^'"\n]*)\1$/.exec(expr);
    if (lit) bound.set(name, lit[2] as string);
    else if (/^[A-Za-z_]\w*$/.test(expr) && bound.has(expr)) bound.set(name, bound.get(expr) ?? null);
    else bound.set(name, null);
  }
  return bound;
}

/** A path argument that is a string literal or a name bound to one. */
function literalPath(expr: string, bound: ReadonlyMap<string, string | null>): string | null {
  const e = expr.trim();
  const lit = /^(['"])([^'"\n]*)\1$/.exec(e);
  if (lit) return lit[2] as string;
  if (/^[A-Za-z_]\w*$/.test(e)) {
    if (!bound.has(e)) return null;
    return bound.get(e) ?? null;
  }
  return null;
}

/** Absent, or one of r/w/a/x plus optional t, b and +. */
function pyModeAllowed(mode: string | undefined): boolean {
  if (mode === undefined) return true;
  const lit = modeLiteral(mode.trim());
  if (lit === null) return false;
  if (!/^[rwaxtb+]+$/.test(lit)) return false;
  return [...lit].filter((c) => "rwax".includes(c)).length === 1;
}

/**
 * Every `open(` has a literal or locally-assigned literal path and a literal mode
 * (absent, "r", "rb", "w", "a", "x", with optional "t" / "b" / "+").
 */
function pyOpensAllowed(stripped: string, blank: string): boolean {
  for (const m of blank.matchAll(/\bopen\s*\(/g)) {
    const at = m.index ?? 0;
    const paren = at + m[0].length - 1;
    const args = balancedArgs(stripped, paren);
    if (args === null) return false;
    const parts = splitTop(args, ",").map((x) => x.trim());
    const path = parts[0] ?? "";
    if (path === "" || /^\w+\s*=(?!=)/.test(path)) return false;
    const bound = literalBindsAt(stripped, at);
    if (literalPath(path, bound) === null) return false;
    if (!pyModeAllowed(openModeArg(args))) return false;
  }
  return true;
}

/**
 * True when every identifier is a keyword, an allowed name, or a simple assignment / `for` target;
 * imports are only `import json` / `import re` / `import math`; attribute names are in the allowed set.
 * Strings and comments are ignored. Anything else is opaque (C16).
 */
function pyAllow(src: string): boolean {
  const blank = pyCode(src);
  const stripped = stripPyComments(src);
  if (/\bfrom\s+\S+\s+import\b/.test(blank)) return false;
  for (const m of blank.matchAll(/\bimport\s+([^#;\n]*)/g)) {
    if (!PY_IMPORT_OK.has((m[1] ?? "").trim())) return false;
  }
  for (const m of blank.matchAll(/\.(\s*)([A-Za-z_]\w*)/g)) {
    if (!PY_ALLOWED_IDENTS.has(m[2] as string)) return false;
  }
  const assigned = assignedNames(blank);
  for (const m of blank.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const name = m[0];
    if (PY_KEYWORDS.has(name) || PY_ALLOWED_IDENTS.has(name) || assigned.has(name)) continue;
    return false;
  }
  return pyOpensAllowed(stripped, blank);
}

/**
 * `python -c <src>` (optional `-u`/`-B`/`-I`/`-E`/`-s`/`-S`/`-O` before `-c`). Null when this is not `-c`:
 * a script, `-m`, `-` or a dash-less heredoc (`python3 <<EOF`) so the heredoc writer scan still runs.
 * `-c` with no source, or another positional after the source, is opaque.
 * The source is non-opaque only when `pyAllow` accepts it. A resolved write in that source is the edit.
 * Anything else is opaque and contributes no edit, the same as an unrecognised `python -c` on main.
 */
function classifyPyC(words: Word[], vars: ReadonlyMap<string, string>): PyC | null {
  const head = words[0]?.text ?? "";
  if (!/^python[\d.]*$/.test(head)) return null;
  let sawC = false;
  let src: Word | null = null;
  let trailing = false;
  for (let i = 1; i < words.length; i++) {
    const t = (words[i] as Word).text;
    if (!sawC) {
      if (t === "-c") {
        sawC = true;
        src = (words[i + 1] as Word | undefined) ?? null;
        if (src !== null) i++;
        continue;
      }
      if (t === "-m" || t === "-" || !t.startsWith("-")) return null;
      if (/^-[uBIEsSO]+$/.test(t)) continue;
      if (t.startsWith("-")) continue;
      return null;
    }
    if (t.startsWith("-") && t !== "-") continue;
    trailing = true;
    break;
  }
  if (!sawC) return null;
  if (src === null || trailing) return { kind: "opaque" };
  const text = substPySource(src, vars);
  if (text === null) return { kind: "opaque" };
  const code = dedent(text);
  if (!pyAllow(code)) return { kind: "opaque" };
  const info = inspectPythonWrites(code, []);
  if (info.unresolved) return { kind: "opaque" };
  if (info.files.length > 0) return { kind: "write", files: info.files };
  return { kind: "safe" };
}

/** Segments known not to write files (beyond what `segmentMutation` already reported). */
function isKnownNonWriting(rawWords: Word[], redirects: Redirect[], dir: Dir, vars: ReadonlyMap<string, string>, repoRoots: readonly string[]): boolean {
  const words = unwrapXargs(rawWords.map((w) => substituteVars(w, vars)));
  const head = words[0]?.text;
  if (head === undefined) return redirects.length === 0;
  // A write redirect to an unknown target is a write we cannot see.
  if (redirects.some(writesUnseen)) return false;
  if (/^[A-Za-z_]\w*=/.test(head)) return true;
  const git = gitSub(words);
  if (git !== null) {
    // `git diff --output=f` and friends write a file.
    if (SAFE_GIT.has(git.sub)) return !git.args.some((w) => /^--out(?:p(?:ut?)?)?(?:=|$)/.test(w.text));
    if (git.sub === "worktree") return SAFE_WORKTREE.has(git.args[0]?.text ?? "");
    if (git.sub === "config") return git.args.some((w) => w.text === "--get" || w.text === "--get-all" || w.text === "--list" || w.text === "-l");
    return false;
  }
  if (isFrozenInstall(words) || isGateScript(words, dir, repoRoots)) return true;
  const pyc = classifyPyC(words, vars);
  if (pyc?.kind === "safe") return true;
  if (pyc !== null) return false;
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
): SegMut | null {
  const words = unwrapXargs(rawWords.map((w) => substituteVars(w, vars)));
  for (const r of redirects) if (r.target !== null) r.target = substituteVars(r.target, vars);
  const head = words[0]?.text ?? "";
  const files: MutFile[] = [];
  let gitOp = false;
  let history = false;
  let mutating = false;
  let segmentOpaque = false;

  const git = gitSub(words);
  if (git !== null) {
    if (git.sub === "rm") {
      const hasCached = git.args.some((w) => w.text === "--cached");
      if (!hasCached) {
        const ops = git.args.filter((w) => !isOption(w));
        const targets = operandFiles(ops);
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
            for (const f of operandFiles([src])) {
              files.push({ file: f, kind: "D" });
            }
          }
          for (const f of operandFiles([dest])) {
            files.push({ file: f, kind: "A" });
          }
        } else if (ops.length === 1) {
          for (const f of operandFiles(ops)) {
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
    const f = sedFiles(words.slice(1));
    if (f !== null) {
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    }
  } else if (head === "perl") {
    const f = perlFiles(words.slice(1));
    if (f !== null) {
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    }
  } else if (head === "tee" && !pipedFromCheck) {
    const f = teeFiles(words.slice(1));
    mutating = f.length > 0;
    files.push(...f.map((file) => ({ file, kind: "M" as const })));
  } else if (/^python[\d.]*$/.test(head)) {
    const pyc = classifyPyC(words, vars);
    if (pyc?.kind === "write") {
      mutating = true;
      if (pyc.opaque) segmentOpaque = true;
      files.push(...pyc.files.map((file) => ({ file, kind: "M" as const })));
    } else if (pyc === null && (heredoc !== null || heredocUnsure)) {
      const dash = words.findIndex((w) => w.text === "-");
      const argv = dash < 0 ? [] : words.slice(dash + 1).map((w) => shellArg(w, vars));
      const f = heredoc === null ? [SHELL_EDIT_FILE] : pythonWrites(heredoc, argv);
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    }
  }

  // `cmd > file` / `cmd >> file`; a check's own redirects capture its log, not an edit.
  if (!isCheck) {
    for (const r of redirects) {
      if ((r.fd !== "" && r.fd !== "1") || r.target === null) continue;
      if (tempPrefixKind(r.target.text) === "climb") {
        mutating = true;
        files.push({ file: SHELL_EDIT_FILE, kind: "M" as const });
        continue;
      }
      if (isUnknownTarget(r.target) || isIgnoredPath(r.target.text)) continue;
      mutating = true;
      files.push({ file: r.target.text, kind: "M" as const });
    }
  }
  return mutating ? { gitOp, history, files, ...(segmentOpaque ? { opaque: true } : {}) } : null;
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
    const dirStack: Dir[] = [];
    segs.forEach((seg, i) => {
      collectAssignments(seg.text, vars);
      // Vars first, then `$E` when E is only NAME=value words, then prefix stripping (C8).
      const expanded = expandEnvSlots(seg.text, vars);
      // `$(...)` closed inside this segment is not a subshell around the command.
      // `splitSegments` drops a trailing `)`, which is what closes `cd $(pwd)`.
      const seenParens = unquotedParens(seg.text);
      const restored = seg.text + ")".repeat(Math.max(0, seg.closes - seenParens.closes));
      const buried = containedCommandSubs(restored);
      const groupOpens = Math.max(0, seg.opens - buried);
      const groupCloses = Math.max(0, seg.closes - buried);
      for (let n = 0; n < groupOpens; n++) dirStack.push(dir);
      // The heredoc fed to this segment's stdin: its own, or the one that opened the pipeline it belongs to.
      const own = HEREDOC_START_RE.test(seg.text) ? heredocs++ : null;
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
      if (hides) {
        hasCd = true;
        dir = { k: "unknown" };
        sawCd = true;
      } else if (head === "cd" || head === "pushd") {
        hasCd = true;
        dir = nextDir(subWords, dir);
        sawCd = true;
      } else if (head === "popd") {
        // No stack to restore: an unknown directory change from here on (fail closed).
        hasCd = true;
        dir = { k: "unknown" };
        sawCd = true;
      }
      const m = segmentMutation(words, redirects, isCheck, prevPipe && prevCheck, heredoc, unsure, vars);
      if (m?.opaque) opaque = true;
      if (m === null && !isCheck && !isKnownNonWriting(words, redirects, placeDir, vars, repoRoots)) opaque = true;
      prevCheck = isCheck;
      prevPipe = seg.op === "|";
      if (isCheck) checkIdx.push(i);
      if (m !== null) {
        anyMutating = true;
        if (m.history) hasHistoryGitOp = true;
        if (!m.gitOp) {
          anyPlain = true;
          plainIdx.push(i);
        }
        for (const f of m.files) {
          const placed = placeFile(f.file, placeDir, placeSaw);
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
      for (let n = 0; n < groupCloses; n++) dir = dirStack.pop() ?? { k: "session" };
    });
    // A relative edit from before the first `cd` still belongs to the session cwd.
    if (hasCd) {
      for (const e of edits) {
        if (e.baseDir !== undefined || e.file === SHELL_EDIT_FILE || e.file.startsWith("/") || e.file.startsWith("~")) continue;
        e.baseDir = "";
      }
    }
    // No parsed edit used to drop `opaque`. Keep it: a rejected `python -c` (`vars(sys)`, …) stays opaque
    // with no edit, and `cd /tmp/other && node scripts/gate.mjs` stays opaque (C13).
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
