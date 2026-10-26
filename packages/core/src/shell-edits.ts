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
  /** The edit comes from a git operation (`git mv`): it never changes the status. */
  gitOp: boolean;
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
  /** The command contains a git operation that can hide edits (commit, stash, checkout/switch/restore, reset, rebase, merge, cherry-pick, am, apply). */
  hasHidingGitOp: boolean;
}

const NONE: ShellMutation = { edits: [], gitOnly: false, order: "unknown", hasCd: false, hasHidingGitOp: false };
const FILES_MAX = 20;
const GIT_OPS = new Set(["merge", "rebase", "pull", "checkout", "stash", "cherry-pick", "mv", "restore", "reset"]);
/** Git operations that can hide file modifications from the working-tree snapshot. */
export const HIDING_GIT_OPS = new Set([
  "commit",
  "stash",
  "checkout",
  "switch",
  "restore",
  "reset",
  "rebase",
  "merge",
  "cherry-pick",
  "am",
  "apply",
]);

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

const PY_OPEN_RE = /\bopen\s*\(\s*([^,()]+?)\s*,\s*(?:mode\s*=\s*)?(['"])[wax][bt+]*\2/g;
const PY_WRITE_RE = /\.write_(?:text|bytes)\s*\(/;

/** Files written by the Python code of a heredoc (`open(path, 'w')`, `.write_text(`). */
function pythonWrites(command: string): string[] {
  const out: string[] = [];
  let unknown = false;
  for (const m of command.matchAll(PY_OPEN_RE)) {
    const arg = (m[1] as string).trim();
    const lit = /^(['"])([^'"\n]*)\1$/.exec(arg);
    if (lit && lit[2] !== undefined && lit[2] !== "") {
      if (!isIgnoredPath(lit[2])) out.push(lit[2]);
    } else unknown = true;
    if (out.length >= FILES_MAX) break;
  }
  if (PY_WRITE_RE.test(command)) unknown = true;
  if (unknown) out.push(SHELL_EDIT_FILE);
  return out;
}

interface SegMut {
  gitOp: boolean;
  files: string[];
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
  command: string,
): SegMut | null {
  const words = unwrapXargs(rawWords);
  const head = words[0]?.text ?? "";
  const files: string[] = [];
  let gitOp = false;
  let mutating = false;

  const git = gitSub(words);
  if (git !== null) {
    if (GIT_OPS.has(git.sub)) {
      gitOp = true;
      mutating = true;
      if (git.sub === "mv") {
        const ops = git.args.filter((w) => !isOption(w));
        const dest = ops[ops.length - 1];
        if (dest !== undefined) files.push(...operandFiles([dest]));
        else files.push(SHELL_EDIT_FILE);
      }
    } else if (git.sub === "apply" && !git.args.some((w) => GIT_APPLY_READONLY.has(w.text))) {
      mutating = true;
      files.push(SHELL_EDIT_FILE);
    }
  } else if (head === "sed" || head === "gsed") {
    const f = sedFiles(words.slice(1));
    if (f !== null) {
      mutating = f.length > 0;
      files.push(...f);
    }
  } else if (head === "perl") {
    const f = perlFiles(words.slice(1));
    if (f !== null) {
      mutating = f.length > 0;
      files.push(...f);
    }
  } else if (head === "tee" && !pipedFromCheck) {
    const f = teeFiles(words.slice(1));
    mutating = f.length > 0;
    files.push(...f);
  } else if (/^python[\d.]*$/.test(head) && command.includes("<<")) {
    const f = pythonWrites(command);
    mutating = f.length > 0;
    files.push(...f);
  }

  // `cmd > file` / `cmd >> file`; a check's own redirects capture its log, not an edit.
  if (!isCheck) {
    for (const r of redirects) {
      if ((r.fd !== "" && r.fd !== "1") || r.target === null) continue;
      if (isUnknownTarget(r.target) || isIgnoredPath(r.target.text)) continue;
      mutating = true;
      files.push(r.target.text);
    }
  }
  return mutating ? { gitOp, files } : null;
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
    let hasHidingGitOp = false;
    let prevCheck = false;
    let prevPipe = false;
    segs.forEach((seg, i) => {
      const isCheck = matchSegment(seg.text, repo);
      const { words, redirects } = parseWords(normalizeFirstToken(stripPrefixes(seg.text)));
      const head = words[0]?.text;
      if (head === "cd" || head === "pushd") hasCd = true;
      const git = gitSub(words);
      if (
        git !== null &&
        HIDING_GIT_OPS.has(git.sub) &&
        (git.sub !== "apply" || !git.args.some((w) => GIT_APPLY_READONLY.has(w.text)))
      ) {
        hasHidingGitOp = true;
      }
      const m = segmentMutation(words, redirects, isCheck, prevPipe && prevCheck, command);
      prevCheck = isCheck;
      prevPipe = seg.op === "|";
      if (isCheck) checkIdx.push(i);
      if (m === null) return;
      anyMutating = true;
      if (!m.gitOp) {
        anyPlain = true;
        plainIdx.push(i);
      }
      for (const f of m.files) {
        const key = `${m.gitOp ? "g" : "e"}\u0000${f}`;
        if (seen.has(key) || edits.length >= FILES_MAX) continue;
        seen.add(key);
        edits.push({ file: f, gitOp: m.gitOp });
      }
    });
    if (!anyMutating) return { edits: [], gitOnly: false, order: "unknown", hasCd, hasHidingGitOp };
    let order: ShellMutation["order"] = "unknown";
    if (checkIdx.length > 0 && plainIdx.length > 0) {
      const lastCheck = checkIdx[checkIdx.length - 1] as number;
      order = plainIdx.some((i) => i > lastCheck) ? "after-check" : "before-check";
    }
    return { edits, gitOnly: !anyPlain, order, hasCd, hasHidingGitOp };
  } catch {
    return NONE;
  }
}
