import { isDocPath } from "./hints.js";
import {
  checkArithmeticOpener,
  isArithmeticCommandStart,
  isGroupingSubshellOpen,
  normalizeFirstToken,
  scanBracketPairEnd,
  scanParenPairEnd,
  stripPrefixes,
  type Segment,
} from "./check-patterns.js";
import {
  KNOWN_SCRATCH_ENV_NAMES,
} from "./shell-edits-words.js";
import {
  canonicalizeEditPath,
  collapseSlashes,
  isMktempValue,
  isTempRootValue,
  normalizePath,
  parseWords,
  SHELL_EDIT_FILE,
  type Word,
} from "./shell-edits-words.js";
import {
  assignmentValue,
  ASSIGN_RE,
  DECL_PREFIX_RE,
} from "./shell-edits-env.js";

export type Dir = { k: "session" } | { k: "abs"; path: string } | { k: "rel"; path: string } | { k: "unknown" };

export const CD_FLAGS = new Set(["--", "-P", "-L", "-n", "--physical", "--logical"]);

/** One `cd` / `pushd` operand. Unknown forms (`-`, `~`, `$()`, an unset var) poison the directory. */
export function concreteDir(w: Word, dir: Dir): Dir {
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
export function closeParen(text: string, open: number): number {
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
export function unquotedParens(text: string): { opens: number; closes: number } {
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
 * Grouping subshell parentheses in this segment. `stack` remembers opens from earlier segments,
 * so a `)` in a later segment still closes the subshell it belongs to. `$(…)`, function `name()`,
 * and array `name=(…)` do not: a `cd` there is not isolated by this stack.
 */
export function consumeGroupingParens(text: string, stack: boolean[]): { opens: number; closes: number } {
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

export function leadingToken(s: string): string {
  const m = /^(?:\\+)?(\S+)/.exec(s);
  return (m?.[1] ?? "").replace(/^\\+/, "");
}

/** `sudo [-u user] … command` → `command`. Flags that take a value keep that value out of the head. */
export function peelSudo(s: string): string {
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
export function stripHiderWrappers(segment: string): string {
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
export function hidesDirectory(segment: string): boolean {
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
export function nextDir(words: Word[], dir: Dir): Dir {
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
export function literalAbsPath(words: Word[]): string | null {
  const placed = nextDir(words, { k: "unknown" });
  return placed.k === "abs" ? placed.path : null;
}

/** Operator that closed a segment, at the grouping and compound depth it actually sits at. */
export interface ListMark {
  afterParen: number;
  afterCompound: number;
  op: string;
}

export function groupingDepth(stack: readonly boolean[]): number {
  let n = 0;
  for (const open of stack) if (open) n++;
  return n;
}

export function restoredSegment(seg: Segment): string {
  const seen = unquotedParens(seg.text);
  return seg.text + ")".repeat(Math.max(0, seg.closes - seen.closes));
}

/**
 * A `||` earlier in this and-or list, at the same grouping and compound depth.
 * Nested `(…)` / `if` bodies are a different list: an outer `||` does not count.
 */
export function precededByOr(history: readonly ListMark[], baseParen: number, baseCompound: number): boolean {
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
export function listEndsWithAmp(
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
export function placeFile(file: string, dir: Dir, sawCd: boolean, docDir: string | null): { file: string; baseDir?: string } {
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
export function isFrozenInstall(words: Word[]): boolean {
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
export function scriptOperand(words: Word[]): Word | null {
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
export function isGateScript(words: Word[], dir: Dir, repoRoots: readonly string[]): boolean {
  if ((words[0]?.text ?? "") !== "node" || dir.k === "unknown") return false;
  const op = scriptOperand(words);
  if (op === null || op.dynamic || op.text.startsWith("/") || op.text.startsWith("~")) return false;
  if (dir.k === "abs") {
    if (!repoRoots.some((root) => gateDirTrusted(dir.path, root))) return false;
    return isScriptsGateFile(dir.path, op.text);
  }
  if (dir.k === "rel" && dir.path.startsWith("../")) {
    for (const root of repoRoots) {
      const resolved = normalizePath(`${root}/${dir.path}`);
      if (gateDirTrusted(resolved, root) && isScriptsGateFile(resolved, op.text)) {
        return true;
      }
    }
    return false;
  }
  const joined = dir.k === "rel" ? `${dir.path}/${op.text}` : op.text;
  return normalizePath(joined) === "scripts/gate.mjs";
}

/** `<dir>/scripts/gate.mjs`, not a file nested under `scripts/` and not another script name. */
export function isScriptsGateFile(dir: string, operand: string): boolean {
  const script = normalizePath(`${dir}/${operand}`);
  return script === `${normalizePath(dir)}/scripts/gate.mjs`;
}

/**
 * Absolute directory that may hold a repo gate script (C13). `<anything>` in the sibling form is one
 * path segment: the worktree directory itself, not a directory under that worktree.
 */
export function gateDirTrusted(dir: string, repoRoot: string): boolean {
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

export function asRepoRoots(repoRoot: string | readonly (string | null | undefined)[] | null | undefined): string[] {
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

export const DIR_CMD = new Set(["cd", "pushd", "popd"]);
export const COMPOUND_INC = new Set(["if", "while", "until", "for", "case"]);
export const COMPOUND_OPEN = new Set(["if", "elif", "while", "until", "for", "case"]);
export const COMPOUND_DEC = new Set(["fi", "done", "esac"]);

/** Command word after the same prefix strip the mutation scan uses. */
export function commandHead(segment: string): string {
  const { words } = parseWords(normalizeFirstToken(stripPrefixes(segment)));
  return words[0]?.text ?? "";
}

/** Body of `` `...` `` or `$(...)` starting at `i`, and the index just after it. */
export function readCommandNest(s: string, i: number): { body: string; next: number } {
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
export function substitutionBodies(cmd: string, heredocBody = false): { bodies: string[]; unsure: boolean } {
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
      const arith = checkArithmeticOpener(cmd, i, false);
      if (arith !== null) {
        i += 2; // arithmetic or a nested group: keep scanning inside it
        continue;
      }
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
export function bareDirWordCount(s: string): number {
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
export function startsFunction(segment: string): boolean {
  const t = segment.trim().replace(/^[({!]+\s*/, "");
  if (/^function\s+[A-Za-z_]\w*/.test(t)) return true;
  return /^[A-Za-z_]\w*\s*\(\s*\)/.test(t);
}

/** An alias whose text names `cd` / `pushd` / `popd` (quotes included: the value is the definition). */
export function aliasDefinesDirChange(segment: string): boolean {
  if (commandHead(segment) !== "alias") return false;
  return /(^|[^A-Za-z0-9_])(cd|pushd|popd)(?![A-Za-z0-9_])/.test(segment);
}

export function countBraces(segment: string): { open: number; close: number } {
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
export function poisonTempNamesInSegment(
  text: string,
  vars: ReadonlyMap<string, string>,
  poisoned: Set<string>,
  tempVars: Set<string>,
): void {
  let s = text.trim();
  const declMatch = DECL_PREFIX_RE.exec(s);
  const isDecl = declMatch !== null;
  if (declMatch) s = s.slice(declMatch[0].length);
  const found: [string, string | null, string][] = [];
  for (let guard = 0; guard < 10; guard++) {
    const m = ASSIGN_RE.exec(s);
    if (!m) break;
    found.push([m[1] as string, assignmentValue(m[2] as string, vars), m[2] as string]);
    s = s.slice(m[0].length);
  }
  if (s.trim() === "" || isDecl) {
    for (const [name, value, raw] of found) {
      if (isMktempValue(raw)) {
        tempVars.add(name);
      } else if (isTempRootValue(value)) {
        tempVars.add(name);
      } else if (tempVars.has(name) || KNOWN_SCRATCH_ENV_NAMES.has(name)) {
        if (!isTempRootValue(value)) poisoned.add(name);
      }
    }
  }
  const { words } = parseWords(text);
  for (let i = 0; i < words.length; i++) {
    const t = (words[i] as Word).text;
    const defMatch = /^\$\{([A-Za-z_]\w*)(?::=|=)(.*)\}$/.exec(t);
    if (defMatch) {
      const name = defMatch[1] as string;
      const raw = defMatch[2] as string;
      const value = assignmentValue(raw, vars);
      if (isMktempValue(raw)) {
        tempVars.add(name);
      } else if (isTempRootValue(value)) {
        tempVars.add(name);
      } else if (tempVars.has(name) || KNOWN_SCRATCH_ENV_NAMES.has(name)) {
        if (!isTempRootValue(value)) poisoned.add(name);
      }
    }
    if (t === "for") {
      const name = words[i + 1]?.text ?? "";
      if (KNOWN_SCRATCH_ENV_NAMES.has(name) || tempVars.has(name)) poisoned.add(name);
    } else if (t === "read") {
      let j = i + 1;
      while (j < words.length && /^-[A-Za-z]+$/.test((words[j] as Word).text)) j++;
      while (j < words.length) {
        const name = (words[j] as Word).text;
        if (KNOWN_SCRATCH_ENV_NAMES.has(name) || tempVars.has(name)) poisoned.add(name);
        j++;
      }
    }
  }
}

/** `NODE_OPTIONS` / `PYTHONPATH` assigned in this segment (they stay in the environment for later segments). */
export function assignsLoader(raw: string): boolean {
  let s = raw.trim();
  for (let guard = 0; guard < 10; guard++) {
    s = s.replace(/^[({!]+\s*/, "");
    const name = /^(?:(?:local|declare|typeset|readonly|export)(?:\s+-[A-Za-z]+)*\s+)?([A-Za-z_]\w*)=/.exec(s);
    if (!name) return false;
    if (name[1] === "NODE_OPTIONS" || name[1] === "PYTHONPATH") return true;
    const full = /^(?:(?:local|declare|typeset|readonly|export)(?:\s+-[A-Za-z]+)*\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*/.exec(s);
    if (!full) return false;
    s = s.slice(full[0].length);
    if (s.trim() === "") return false;
  }
  return false;
}

export function looseTokens(s: string): string[] {
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
export function envChangesDir(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "--chdir" || t.startsWith("--chdir=") || t === "-C" || t.startsWith("-C")) return true;
    if (t.startsWith("-") || /^[A-Za-z_]\w*=/.test(t)) continue;
    return false;
  }
  return false;
}

/** `sudo --chdir` before the command word. */
export function sudoChangesDir(tokens: string[]): boolean {
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
export function segmentGateBlocked(raw: string): boolean {
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
