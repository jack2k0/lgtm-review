/**
 * Heuristic detection of file edits made through Bash (`sed -i`, `tee`, `> file`, `git apply`, ...), for
 * sessions whose log carries no `bashEditDiff` (the session did not start inside the repo), and of
 * commands whose only mutating segments are git operations (merge, rebase, checkout, ...).
 * Pure string logic on the command, regex/linear, never throws.
 */
import { matchSegment, normalizeFirstToken, splitSegments, stripHeredocs, stripPrefixes, type RepoScripts } from "./check-patterns.js";

/** File name used when the target of a shell edit cannot be read off the command. */
export const SHELL_EDIT_FILE = "(shell edit)";

export interface ShellEditTarget {
  /** Target path as written in the command, or `SHELL_EDIT_FILE`. */
  file: string;
  /** The edit comes from a git operation (`git mv`, `git rm`): it never changes the status. */
  gitOp: boolean;
  kind?: "M" | "A" | "D";
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
  /** The command changes directory: relative targets cannot be resolved against the session cwd. */
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
      const fd = m[1] ?? "";
      const op = m[2] as string;
      if (op === ">" || op === ">>" || op === ">|") redirects.push({ fd, target: readWord() });
      else readWord(); // `>&2`, `<file`, `<<EOF`, `<<<str`: nothing written to a file
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

/**
 * Files written by the Python code of one heredoc (`open(path, 'w')`, `.write_text(`). A path resolves when it is a
 * string literal, `sys.argv[N]` (of `python3 - args`), a name bound to such a value by an assignment above the
 * write (the binding in effect at the write counts), or a concatenation / `Path` / `os.path.join` of those.
 */
function pythonWrites(raw: string, argv: (string | null)[]): string[] {
  const body = stripPyComments(raw);
  const out: string[] = [];
  let unknown = false;
  const binds: { at: number; name: string; expr: string; nested: boolean }[] = [];
  for (const m of body.matchAll(PY_BIND_RE)) {
    const name = m[1] as string;
    const at = (m.index ?? 0) + m[0].indexOf(name);
    const lineStart = body.lastIndexOf("\n", at - 1) + 1;
    // An indented binding (inside if / for / with / def) may or may not run: the name is then unresolved.
    const nested = (/^[ \t]*/.exec(body.slice(lineStart))?.[0] ?? "") !== "";
    binds.push({ at, name, expr: m[2] as string, nested });
  }
  const writes: { at: number; expr: string | null }[] = [];
  for (const m of body.matchAll(PY_OPEN_CALL_RE)) {
    const at = m.index ?? 0;
    const args = balancedArgs(body, at + m[0].length - 1);
    if (args === null) {
      // Cannot tell what is written: stay conservative.
      writes.push({ at, expr: null });
      continue;
    }
    const parts = splitTop(args, ",").map((x) => x.trim());
    const kw = parts.find((x) => /^mode\s*=/.test(x));
    const mode = kw !== undefined ? kw.replace(/^mode\s*=\s*/, "") : parts[1] !== undefined && !/^\w+\s*=(?!=)/.test(parts[1]) ? parts[1] : undefined;
    if (mode === undefined) continue; // open(path): read
    const lit = /^(['"])([^'"\n]*)\1$/.exec(mode);
    if (lit && !/[wax+]/.test(lit[2] as string)) continue; // a literal read mode
    writes.push({ at, expr: lit ? (parts[0] ?? null) : null }); // a non-literal mode might write
  }
  for (const m of body.matchAll(PY_WRITE_RE)) {
    const at = m.index ?? 0;
    writes.push({ at, expr: receiverOf(body.slice(Math.max(0, at - 300), at)) });
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
    else if (!isIgnoredPath(v)) out.push(v);
    if (out.length >= FILES_MAX) {
      unknown = true; // cut: more writes may follow
      break;
    }
  }
  if (unknown) out.push(SHELL_EDIT_FILE);
  return out;
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

const ASSIGN_RE = /^(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|"'`$]*)(?=\s|$)\s*/;

/** Literal `NAME=value` assignments at the start of a segment (also `export NAME=value` and inline env prefixes). */
function collectAssignments(seg: string, vars: Map<string, string>): void {
  let s = seg.trim();
  const exported = s.startsWith("export ");
  const found: [string, string | null][] = [];
  for (let guard = 0; guard < 10; guard++) {
    const m = ASSIGN_RE.exec(s);
    if (!m) break;
    const raw = m[2] as string;
    const v = /^(["'])([\s\S]*)\1$/.test(raw) ? raw.slice(1, -1) : raw;
    found.push([m[1] as string, v.includes("$") || v.includes("`") || v === "" ? null : v]);
    s = s.slice(m[0].length);
  }
  // `NAME=x cmd` sets NAME for cmd only: later segments do not see it (and `$NAME` in cmd is expanded before it).
  if (s.trim() !== "" && !exported) return;
  for (const [name, v] of found) {
    if (v === null) vars.delete(name);
    else vars.set(name, v);
  }
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

/** `sed` that neither edits in place nor writes a file with a `w` command / flag. */
function isReadOnlySed(words: Word[]): boolean {
  for (const w of words.slice(1)) {
    const t = w.text;
    if (t === "--in-place" || t.startsWith("--in-place=") || /^-[A-Za-z]*i/.test(t)) return false;
    if (/(?:^|[;{}\s])w\s*\S/.test(t) || /\/[A-Za-z0-9]*w\s*\S/.test(t)) return false;
  }
  return true;
}

/** Segments known not to write files (beyond what `segmentMutation` already reported). */
function isKnownNonWriting(words: Word[], redirects: Redirect[]): boolean {
  const head = words[0]?.text;
  if (head === undefined) return redirects.length === 0;
  // A write redirect to an unknown target is a write we cannot see.
  if (redirects.some((r) => (r.fd === "" || r.fd === "1") && (r.target === null || isUnknownTarget(r.target)))) return false;
  if (/^[A-Za-z_]\w*=/.test(head)) return true;
  const git = gitSub(words);
  if (git !== null) {
    if (SAFE_GIT.has(git.sub)) return true;
    if (git.sub === "worktree") return SAFE_WORKTREE.has(git.args[0]?.text ?? "");
    if (git.sub === "config") return git.args.some((w) => w.text === "--get" || w.text === "--get-all" || w.text === "--list" || w.text === "-l");
    return false;
  }
  if (head === "sed" || head === "gsed") return isReadOnlySed(words);
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
  } else if (/^python[\d.]*$/.test(head) && (heredoc !== null || heredocUnsure)) {
    const dash = words.findIndex((w) => w.text === "-");
    const argv = dash < 0 ? [] : words.slice(dash + 1).map((w) => shellArg(w, vars));
    const f = heredoc === null ? [SHELL_EDIT_FILE] : pythonWrites(heredoc, argv);
    mutating = f.length > 0;
    files.push(...f.map((file) => ({ file, kind: "M" as const })));
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
  return mutating ? { gitOp, history, files } : null;
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

/** Makes a relative target absolute with the session cwd (only when it is known and the command did not `cd`). */
export function resolveTarget(file: string, cwd: string | null, hasCd: boolean): string {
  if (file === SHELL_EDIT_FILE || file.startsWith("/") || file.startsWith("~") || hasCd || cwd === null || cwd === "") return file;
  if (!cwd.startsWith("/")) return file;
  return normalizePath(`${cwd}/${file}`);
}

/**
 * Heuristic view of a Bash command's file mutations. Does not decide whether the command succeeded:
 * the caller counts the result only for successful calls.
 */
export function classifyShellMutation(command: string, repo?: RepoScripts): ShellMutation {
  try {
    if (typeof command !== "string" || command.trim() === "") return NONE;
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
    segs.forEach((seg, i) => {
      collectAssignments(seg.text, vars);
      // The heredoc fed to this segment's stdin: its own, or the one that opened the pipeline it belongs to.
      const own = HEREDOC_START_RE.test(seg.text) ? heredocs++ : null;
      if (!prevPipe) pipeHeredoc = null;
      if (own !== null) pipeHeredoc = own;
      const fed = own ?? (prevPipe ? pipeHeredoc : null);
      const heredoc = fed === null ? null : (bodies[fed] ?? null);
      // A piped python with no heredoc in its pipeline, while the command has one elsewhere: unsure, not "no write".
      const unsure = heredoc === null && prevPipe && heredocs > 0 && pipeHeredoc === null;
      const isCheck = matchSegment(seg.text, repo);
      const { words, redirects } = parseWords(normalizeFirstToken(stripPrefixes(seg.text)));
      const head = words[0]?.text;
      if (head === "cd" || head === "pushd") hasCd = true;
      const m = segmentMutation(words, redirects, isCheck, prevPipe && prevCheck, heredoc, unsure, vars);
      if (m === null && !isCheck && !isKnownNonWriting(words, redirects)) opaque = true;
      prevCheck = isCheck;
      prevPipe = seg.op === "|";
      if (isCheck) checkIdx.push(i);
      if (m === null) return;
      anyMutating = true;
      if (m.history) hasHistoryGitOp = true;
      if (!m.gitOp) {
        anyPlain = true;
        plainIdx.push(i);
      }
      for (const f of m.files) {
        const kind = f.kind ?? "M";
        const key = `${m.gitOp ? "g" : "e"}\u0000${kind}\u0000${f.file}`;
        if (seen.has(key)) continue;
        if (edits.length >= FILES_MAX) {
          truncated = true;
          continue;
        }
        seen.add(key);
        edits.push({ file: f.file, gitOp: m.gitOp, kind });
      }
    });
    if (!anyMutating) return NONE;
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
