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

const TMP_VAR = /^\$\{?(?:TMPDIR|TMP|TEMP|S|SCRATCH\w*)\}?(?:\/|$)/;
const IGNORED_PATH_RES: RegExp[] = [
  /^\/dev\//,
  /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/,
  TMP_VAR,
  /(?:^|\/)\.cache(?:\/|$)/,
  /(?:^|\/)scratch[^/]*(?:\/|$)/,
  /(?:^|\/)[^/]*\.(?:log|out|err)$/,
  /(?:^|\/)(?:log|out|output|err|stdout|stderr)$/,
];

/** Scratch, cache and log-capture targets are not edits of the work tree. */
function isIgnoredPath(p: string): boolean {
  return IGNORED_PATH_RES.some((re) => re.test(p));
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
  const live = ops.filter((w) => !TMP_VAR.test(w.text) && !isIgnoredPath(w.text));
  if (live.length === 0 && ops.length > 0) return [];
  if (live.length === 0 || live.some((w) => w.dynamic)) return [SHELL_EDIT_FILE];
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
  const resolvedOpens: number[] = [];
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
      if (w.openAt !== null) resolvedOpens.push(w.openAt);
      if (w.span !== null) {
        for (const id of forbiddenIdents(w.span.text)) owned.add(w.span.abs + id.index);
      }
    }
    if (out.length >= FILES_MAX) {
      unknown = true; // cut: more writes may follow
      break;
    }
  }
  if (unknown) out.push(SHELL_EDIT_FILE);
  // `json.dump(..., open(...))`: `dump` belongs to the open when that open resolved.
  if (resolvedOpens.length > 0) {
    for (const m of body.matchAll(/\bdump\s*\(/g)) {
      const paren = (m.index ?? 0) + m[0].length - 1;
      const args = balancedArgs(body, paren);
      if (args === null) continue;
      const begin = paren + 1;
      const end = begin + args.length;
      if (resolvedOpens.some((openAt) => openAt >= begin && openAt < end)) owned.add(m.index ?? 0);
    }
  }
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
    "tail head grep egrep fgrep rg cut wc tr sort uniq diff cmp jq column nl basename dirname realpath readlink stat file du df date which type whoami hostname -v " +
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
  if (dir.k === "unknown") return { file: SHELL_EDIT_FILE };
  if (dir.k === "abs") return { file: normalizePath(`${dir.path}/${file}`) };
  if (dir.k === "rel") return { file, baseDir: dir.path };
  return sawCd ? { file, baseDir: "" } : { file };
}

/** `npm ci`, or `npm` / `pnpm` / `yarn` `install`|`i` with `--frozen-lockfile` / `--immutable` (any order, plus `-C` / `--dir` / `--prefix`). */
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
  const frozen = args.includes("--frozen-lockfile") || args.includes("--immutable");
  if (head === "npm" && positional[0] === "ci") return true;
  return (positional[0] === "install" || positional[0] === "i") && frozen;
}

const NODE_VALUE_OPTS = new Set(["-r", "--require", "--import", "--loader"]);
const GATE_BASE_RE = /^(?:gate|check|verify|validate)[\w.-]*\.(?:mjs|cjs|js|py|ts)$/;

/** First positional operand, skipping the flags C9 names. Null when `-c` / `-m` takes that slot. */
function scriptOperand(words: Word[], kind: "node" | "py"): Word | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as Word;
    const t = w.text;
    if (kind === "node") {
      if (NODE_VALUE_OPTS.has(t)) {
        i++;
        continue;
      }
      if (t.startsWith("--require=") || t.startsWith("--import=") || t.startsWith("--loader=")) continue;
      if (t.startsWith("-") && t !== "-") continue;
      return w;
    }
    if (t === "-c" || t === "-m") return null;
    if (/^-[uBIEsSO]+$/.test(t)) continue;
    if (t.startsWith("-") && t !== "-") continue;
    return w;
  }
  return null;
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
  const op = scriptOperand(words, kind);
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

/** `os.environ[k] = v` / `.update(` is not a read. A subscript or `.get(` with no assignment is a read. */
function environWrite(rest: string): boolean {
  const s = rest.trimStart();
  if (s.startsWith("=") && !s.startsWith("==")) return true;
  if (/^\.\s*(?:update|setdefault|pop|clear|__setitem__)\s*\(/.test(s)) return true;
  if (!s.startsWith("[")) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) {
      const tail = s.slice(i + 1).trimStart();
      return tail.startsWith("=") && !tail.startsWith("==");
    }
  }
  return false;
}

/**
 * Escape surface of a `python -c` body (C1). True when the segment must stay opaque:
 * exec/eval/compile/__import__, os.system/popen/exec-star/spawn-star, subprocess, pty, shutil,
 * or `import os` / `from os` together with any `os` use other than `os.path`, `os.getcwd`, or an `os.environ` read.
 */
function hasEscape(src: string): boolean {
  const s = pyCode(src);
  if (/\b(?:exec|eval|compile|__import__)\s*\(/.test(s)) return true;
  if (/\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*)\s*\(/.test(s)) return true;
  if (/\bsubprocess\b/.test(s) || /\bpty\b/.test(s)) return true;
  if (/\bimport\s+shutil\b/.test(s) || /\bfrom\s+shutil\b/.test(s)) return true;
  const importsOs = /\bimport\s+os\b(?!\s*\.)/.test(s) || /\bfrom\s+os\s+import\b/.test(s);
  if (!importsOs) return false;
  for (const m of s.matchAll(/\bfrom\s+os\s+import\s+([^\n#]+)/g)) {
    const names = (m[1] as string).split(",").map((part) => part.trim().split(/\s+as\s+/)[0] ?? "");
    if (names.some((name) => name !== "" && name !== "path" && name !== "getcwd" && name !== "environ")) return true;
  }
  for (const m of s.matchAll(/\bos\s*\.\s*(\w+)/g)) {
    const name = m[1] as string;
    if (name === "path" || name === "getcwd") continue;
    if (name === "environ" && !environWrite(s.slice((m.index ?? 0) + m[0].length))) continue;
    return true;
  }
  return false;
}

/** Write APIs `pythonWrites` does not parse. A bare `str.replace` is not one; `Path(...).replace` is. */
function hasExtraWrite(src: string): boolean {
  const s = pyCode(src);
  if (/\bshutil\s*\./.test(s)) return true;
  if (/\bos\s*\.\s*(?:rename|replace|remove|unlink)\s*\(/.test(s)) return true;
  if (/\.\s*(?:unlink|touch|mkdir)\s*\(/.test(s)) return true;
  return /Path\s*\([^)]*\)\s*\.\s*(?:replace|rename)\s*\(/.test(s);
}

/** Modules a `python -c` source may import and still be non-writing (C12). Anything else is opaque. */
const PY_ALLOW_IMPORTS = new Set([
  "json", "sys", "re", "math", "datetime", "time", "collections", "itertools", "functools", "textwrap", "pprint",
  "statistics", "random", "string", "decimal", "fractions", "operator", "typing", "enum", "dataclasses", "uuid",
  "hashlib", "base64", "platform",
]);

/**
 * Names that keep a `python -c` source from being non-writing (C12). Word match, so `write_text` is not `write`
 * and `dumps` is not `dump`. Matched on code with strings and comments blanked.
 */
const PY_FORBIDDEN_RE =
  /\b(?:__import__|__builtins__|makedirs|getattr|globals|compile|replace|rename|unlink|remove|rmdir|symlink|truncate|system|popen|spawn|write|mkdir|open|Path|exec|eval|copy|move|touch|dump|chmod)\b/g;

function forbiddenIdents(src: string): { index: number }[] {
  const s = pyCode(src);
  PY_FORBIDDEN_RE.lastIndex = 0;
  return [...s.matchAll(PY_FORBIDDEN_RE)].map((m) => ({ index: m.index ?? 0 }));
}

/** Top-level module is on the allow-list. A relative import, or a name we cannot read, is not. */
function moduleAllowed(name: string): boolean {
  if (name === "" || name.startsWith(".")) return false;
  const root = name.split(".")[0] ?? "";
  return PY_ALLOW_IMPORTS.has(root);
}

/**
 * Every `import` / `from ... import` names an allow-listed module (C12). An alias does not hide the module
 * (`import os as o` is still `os`). An unreadable clause is rejected. Strings and comments are ignored.
 */
function pyImportsAllowed(src: string): boolean {
  const s = pyCode(src);
  let ok = true;
  const withoutFrom = s.replace(/\bfrom\s+(\S+)\s+import\b/g, (all, mod: string) => {
    if (!moduleAllowed(mod)) ok = false;
    return " ".repeat(all.length);
  });
  if (!ok) return false;
  // Stop at `;` so `import json; print(...)` is not one clause. A later `import` is its own match.
  for (const m of withoutFrom.matchAll(/\bimport\s+([^#;\n]*)/g)) {
    const raw = m[1] ?? "";
    if (raw.includes("\\") || raw.trim() === "") return false;
    for (const part of raw.split(",")) {
      const mod = (part.trim().split(/\s+as\s+/)[0] ?? "").trim().split(/\s+/)[0] ?? "";
      if (!moduleAllowed(mod)) return false;
    }
  }
  return true;
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

/** `open(path)` or `open(path, "r"|"rb")` (C14). Other literal modes are not reads for this exemption. */
function isReadOpenArgs(args: string): boolean {
  const mode = openModeArg(args);
  if (mode === undefined) return true;
  const lit = modeLiteral(mode);
  return lit === "r" || lit === "rb";
}

/** `open(p, m)` / `open(p, mode)`: the mode is not a string literal, so the call may write (C14). */
function hasNonLiteralOpenMode(src: string): boolean {
  const blank = pyCode(src);
  const stripped = stripPyComments(src);
  for (const m of blank.matchAll(/\bopen\s*\(/g)) {
    const at = m.index ?? 0;
    const paren = at + m[0].length - 1;
    const args = balancedArgs(stripped, paren);
    if (args === null) continue;
    const mode = openModeArg(args);
    if (mode !== undefined && modeLiteral(mode) === null) return true;
  }
  return false;
}

/** `Path(…).replace(`, which is not `str.replace` (C14). */
function pathReplaceCall(src: string): boolean {
  return /Path\s*\([^)]*\)\s*\.\s*replace\s*\(/.test(pyCode(src));
}

/**
 * Indexes C14 ignores on a resolved write: read `open` and `.replace(`. Only when every import is
 * allow-listed and the source has no `Path`, `pathlib`, or `os` import. A source with no resolved write
 * still uses the full forbidden list, so a bare read or `str.replace` stays opaque.
 */
function c14Exempt(src: string): Set<number> {
  if (!pyImportsAllowed(src)) return new Set();
  const blank = pyCode(src);
  if (/\bPath\b/.test(blank) || /\bpathlib\b/.test(blank)) return new Set();
  if (/\bimport\s+os\b/.test(blank) || /\bfrom\s+os\b/.test(blank)) return new Set();
  const exempt = new Set<number>();
  for (const m of blank.matchAll(/\.\s*replace\s*\(/g)) {
    exempt.add((m.index ?? 0) + m[0].lastIndexOf("replace"));
  }
  const stripped = stripPyComments(src);
  for (const m of blank.matchAll(/\bopen\s*\(/g)) {
    const at = m.index ?? 0;
    const paren = at + m[0].length - 1;
    const args = balancedArgs(stripped, paren);
    if (args !== null && isReadOpenArgs(args)) exempt.add(at);
  }
  return exempt;
}

/**
 * `python -c <src>` (optional `-u`/`-B`/`-I`/`-E`/`-s`/`-S`/`-O` before `-c`). Null when this is not `-c`
 * (a script operand or `-` for a heredoc). An escape (C1) drops a parsed write. Otherwise C12: non-writing only
 * when every import is allow-listed and no forbidden name occurs; a resolved write stays, and is non-opaque
 * only when those same conditions hold and every forbidden name belongs to that write. C14: on that resolved
 * write, a read `open` and `str.replace` do not count, and a non-literal `open` mode stays opaque.
 */
function classifyPyC(words: Word[], vars: ReadonlyMap<string, string>): PyC | null {
  const head = words[0]?.text ?? "";
  if (!/^python[\d.]*$/.test(head)) return null;
  let src: Word | null = null;
  for (let i = 1; i < words.length; i++) {
    const t = (words[i] as Word).text;
    if (t === "-c") {
      src = (words[i + 1] as Word | undefined) ?? null;
      break;
    }
    if (t === "-m" || t === "-" || !t.startsWith("-")) return null;
    if (/^-[uBIEsSO]+$/.test(t)) continue;
    if (t.startsWith("-")) continue;
    return null;
  }
  if (src === null) return { kind: "opaque" };
  const text = substPySource(src, vars);
  if (text === null) return { kind: "opaque" };
  const code = dedent(text);
  if (hasEscape(code)) return { kind: "opaque" };
  const info = inspectPythonWrites(code, []);
  const extra = hasExtraWrite(code);
  const importsOk = pyImportsAllowed(code);
  const forbidden = forbiddenIdents(code);
  // A non-literal mode can hide a write. Keep the shell edit and refuse a per-file split (C14).
  if (hasNonLiteralOpenMode(code)) {
    const files = info.files.length > 0 ? [...info.files] : [SHELL_EDIT_FILE];
    if (!files.includes(SHELL_EDIT_FILE)) files.push(SHELL_EDIT_FILE);
    return { kind: "write", files, opaque: true };
  }
  // `Path(…).replace` is not `str.replace`. It stays a shell edit and opaque (C14).
  if (pathReplaceCall(code)) {
    const files = info.files.length > 0 ? [...info.files] : [SHELL_EDIT_FILE];
    if (!files.includes(SHELL_EDIT_FILE)) files.push(SHELL_EDIT_FILE);
    return { kind: "write", files, opaque: true };
  }
  const exempt = c14Exempt(code);
  const allow = importsOk && forbidden.every((id) => info.owned.has(id.index) || exempt.has(id.index));
  // A path we resolved, and no write we failed to resolve and no extra API.
  if (info.resolved && !info.unresolved && !extra) {
    if (info.files.length === 0) return allow ? { kind: "safe" } : { kind: "opaque" };
    return allow ? { kind: "write", files: info.files } : { kind: "write", files: info.files, opaque: true };
  }
  // No write API at all: the allow-list is the only way to stay non-writing.
  if (!info.resolved && !info.unresolved && !extra) {
    if (importsOk && forbidden.length === 0) return { kind: "safe" };
    return { kind: "opaque" };
  }
  const files = info.files.length > 0 ? [...info.files] : [SHELL_EDIT_FILE];
  if ((extra || info.unresolved) && !files.includes(SHELL_EDIT_FILE)) files.push(SHELL_EDIT_FILE);
  // Alias / disallowed import on an open or write_text we could not resolve: keep the shell edit, refuse a split.
  // A bare extra API (`Path.unlink`) stays a shell edit and is not opaque (existing expectation).
  if (info.unresolved && !importsOk) return { kind: "write", files, opaque: true };
  if (info.resolved && !allow) return { kind: "write", files, opaque: true };
  return { kind: "write", files };
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
      const { words, redirects } = parseWords(normalizeFirstToken(stripPrefixes(expanded)));
      const subWords = words.map((w) => substituteVars(w, vars));
      const head = subWords[0]?.text;
      // Bash applies this segment's redirections before `cd`, so they belong to the directory we are in now.
      const placeDir = dir;
      const placeSaw = sawCd;
      if (head === "cd" || head === "pushd") {
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
    // No parsed edit drops `opaque`, so an escaped `python -c` alone stays non-opaque (existing expectation).
    // After `cd`, keep it: `cd /tmp/other && node scripts/gate.mjs` is opaque (C13) even with no edit.
    if (!anyMutating) return opaque && hasCd ? { ...NONE, hasCd: true, opaque: true } : NONE;
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
