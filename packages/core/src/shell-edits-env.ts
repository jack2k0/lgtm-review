import { isDocPath } from "./hints.js";
import {
  heredocEnds,
  parseHeredocStarts,
  type HeredocStart,
} from "./check-patterns.js";
import {
  GIT_OPS,
  isIgnoredPath,
  isUnknownTarget,
  nonLiteralClimb,
  tempPrefixKind,
  type Redirect,
  type Word,
} from "./shell-edits-words.js";

export interface MutFile {
  file: string;
  kind?: "M" | "A" | "D";
}

export interface SegMut {
  /** The segment writes files we resolved, but also runs code we cannot read (R2). */
  opaque?: boolean;
  gitOp: boolean;
  /** A history-moving git operation (`GIT_OPS`), as opposed to `git rm` / `git apply`. */
  history: boolean;
  files: MutFile[];
}

/** A command-line argument as a literal: itself, or `$VAR` / `"$VAR"` / `${VAR}` assigned a literal earlier; null otherwise. */
export function shellArg(w: Word, vars: ReadonlyMap<string, string>): string | null {
  const ref = /^\$(?:\{(\w+)\}|(\w+))$/.exec(w.text);
  if (ref) return vars.get((ref[1] ?? ref[2]) as string) ?? null;
  return w.dynamic ? null : w.text;
}

const VAR_REF_RE = /\$(?:\{(\w+)\}|(\w+))/g;

/** Replaces `$VAR` / `${VAR}` in a word by the literal assigned earlier in the command, when all of them are known. */
export function substituteVars(w: Word, vars: ReadonlyMap<string, string>): Word {
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
export function substituteKeepingClimb(
  w: Word,
  vars: ReadonlyMap<string, string>,
  poisoned?: ReadonlySet<string>,
  tempVars?: ReadonlySet<string>,
): Word {
  if (nonLiteralClimb(w.text) || tempPrefixKind(w.text, poisoned, tempVars) === "climb") return w;
  return substituteVars(w, vars);
}

/** Bodies of the heredocs of a command, in order of their start. */
export function heredocBodies(cmd: string): string[] {
  return heredocParts(cmd).map((h) => h.body);
}

/** Heredocs with their bodies, whether the delimiter was quoted (a quoted body is literal) and whether it was closed. */
export function heredocParts(cmd: string): { body: string; quoted: boolean; closed: boolean }[] {
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

export const DECL_PREFIX_RE = /^(?:(?:local|declare|typeset|readonly|export)(?:\s+-[A-Za-z]+)*\s+)/;
export const ASSIGN_RE = /^(?:(?:local|declare|typeset|readonly|export)(?:\s+-[A-Za-z]+)*\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\$\([^)]*\)|`[^`]*`|[^\s;&|]+)(?=\s|$)\s*/;

/** Expands `$NAME` / `${NAME}` in an assignment value. Null when any reference is unknown or the value is empty. */
export function assignmentValue(raw: string, vars: ReadonlyMap<string, string>): string | null {
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
export function collectAssignments(seg: string, vars: Map<string, string>): void {
  let s = seg.trim();
  const declMatch = DECL_PREFIX_RE.exec(s);
  const isDecl = declMatch !== null;
  if (declMatch) s = s.slice(declMatch[0].length);
  const found: [string, string | null][] = [];
  for (let guard = 0; guard < 10; guard++) {
    const m = ASSIGN_RE.exec(s);
    if (!m) break;
    // Same-segment assignments are not visible to each other: the shell expands the values first.
    found.push([m[1] as string, assignmentValue(m[2] as string, vars)]);
    s = s.slice(m[0].length);
  }
  // `NAME=x cmd` sets NAME for cmd only: later segments do not see it (and `$NAME` in cmd is expanded before it).
  if (s.trim() !== "" && !isDecl) return;
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
export function expandEnvSlots(seg: string, vars: ReadonlyMap<string, string>): string {
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

export const SAFE_HEADS = new Set(
  (
    "cd pushd popd echo printf ls cat true false : test [ [[ sleep export set unset pwd " +
    // read-only text and system tools
    "tail head grep egrep fgrep rg cut wc tr sort uniq diff cmp jq column nl basename dirname realpath readlink stat file du df date seq which type whoami hostname -v -V " +
    // shell keywords and grouping
    "for do done if then else elif fi while until case esac break continue exit return { } ( ) " +
    // creates directories only; terminal control
    "mkdir rmdir herdr"
  ).split(" "),
);
export const SAFE_GIT = new Set(["add", "commit", "status", "log", "diff", "show", "branch", "push", "fetch", "remote", "rev-parse", "rev-list", "merge-base", "show-ref", "grep", "ls-files", "tag", "describe"]);
export const SAFE_WORKTREE = new Set(["add", "remove", "prune", "list"]);

const SED_SUBST_WRITE_RE = /(?:^|[;{}\s!])s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[0-9gIiMmp]*[we]/;

/** `sed` that neither edits in place nor writes a file (`w` / `W`), nor runs a command (`e`, `s///e`). */
export function isReadOnlySed(words: Word[]): boolean {
  for (const w of words.slice(1)) {
    const t = w.text;
    if (t === "--in-place" || t.startsWith("--in-place=") || /^-[A-Za-z]*i/.test(t)) return false;
    if (/(?:^|[;{}\s!])[wW]\s*\S/.test(t) || /(?:^|[;{}\s!])e(?:\s|$|;|\})/.test(t) || SED_SUBST_WRITE_RE.test(t)) return false;
  }
  return true;
}

/** `sort -o f` / `--output=f`, `uniq in out`: read-only tools with an output file. */
export function writesOutputFile(head: string, words: Word[]): boolean {
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
export function writesUnseen(
  r: Redirect,
  poisoned?: ReadonlySet<string>,
  tempVars?: ReadonlySet<string>,
): boolean {
  if (r.target === null) return true;
  // `$S/…`, `$TMPDIR/…`, logs and other scratch targets are not work-tree writes, even before `$S` is substituted.
  if (isIgnoredPath(r.target.text, poisoned, tempVars)) return false;
  if (isUnknownTarget(r.target)) return true;
  if (r.fd === "" || r.fd === "1") return false;
  return !isDocPath(r.target.text);
}
