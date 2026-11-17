import { splitSegments, stripHeredocs } from "./check-patterns-segments.js";
import { stripRedirects } from "./check-patterns-scope.js";
import { matchSegment, normalizeFirstToken, stripPrefixes, tokens, unquote, type RepoScripts } from "./check-patterns-classify.js";

/**
 * What a command does to the working tree, in segment order (S-37, F4): it reverts edits
 * (`git stash`, `git checkout -- <path>`, `git restore <path>`), brings them back
 * (`git stash pop|apply`), or runs a check. Pure string logic, best effort, never throws.
 */
export type TreeOp =
  /** `paths: null` reverts every edit; otherwise only edits at or under these paths (as written). */
  | { kind: "revert"; paths: string[] | null }
  | { kind: "restore" }
  | { kind: "check" };

const GIT = /^git\s+/;
/** Characters that make a path argument unplaceable: the whole tree is assumed reverted. */
const UNPLACEABLE = /[*?[\]{}$`~:]/;
/** `git restore` options whose value is the next token. */
const RESTORE_VALUE_OPTS = new Set(["-s", "--source", "--pathspec-from-file"]);

/** Path arguments, or null (every edit) when one is `.`/`:/`, a glob, or no path is given. */
function pathArgs(args: readonly string[]): string[] | null {
  if (args.length === 0) return null;
  const out: string[] = [];
  for (const a of args) {
    if (a === "." || a === "./" || UNPLACEABLE.test(a)) return null;
    out.push(a);
  }
  return out;
}

/** `-f`, `--force`, `--discard-changes` (also inside a short-flag group): the working tree is thrown away. */
const FORCE = /^(?:--force|--discard-changes|-[a-zA-Z]*f[a-zA-Z]*)$/;

function gitOp(toks: readonly string[]): TreeOp | null {
  // Global options are transparent: `-c k=v` and `-C dir` take a value, `--no-pager` and the like do not.
  // `-C dir` changes what a relative path means, so a path-specific revert under it reverts everything.
  let i = 1;
  let moved = false;
  while (i < toks.length && (toks[i] as string).startsWith("-")) {
    if (toks[i] === "-c" || toks[i] === "-C") {
      if (toks[i] === "-C") moved = true;
      i += 2;
    } else i++;
  }
  const op = subOp(toks[i], toks.slice(i + 1));
  return op !== null && op.kind === "revert" && moved ? { kind: "revert", paths: null } : op;
}

function subOp(sub: string | undefined, rest: readonly string[]): TreeOp | null {
  if (sub === "stash") {
    const verb = rest[0];
    if (verb === "pop" || verb === "apply") return { kind: "restore" };
    if (verb === undefined || verb === "push" || verb === "save" || verb.startsWith("-")) {
      const dd = rest.indexOf("--");
      return { kind: "revert", paths: dd < 0 ? null : pathArgs(rest.slice(dd + 1)) };
    }
    return null;
  }
  if (sub === "restore") {
    const paths: string[] = [];
    let staged = false;
    let worktree = false;
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j] as string;
      if (t === "--staged" || t === "-S") staged = true;
      else if (t === "--worktree" || t === "-W") worktree = true;
      else if (RESTORE_VALUE_OPTS.has(t)) j++;
      else if (t === "--") paths.push(...rest.slice(j + 1));
      else if (!t.startsWith("-")) paths.push(t);
      if (t === "--") break;
    }
    if (staged && !worktree) return null;
    return { kind: "revert", paths: pathArgs(paths) };
  }
  if ((sub === "checkout" || sub === "switch") && rest.some((t) => FORCE.test(t))) return { kind: "revert", paths: null };
  if (sub === "checkout") {
    if (rest.some((t) => t === "-b" || t === "-B" || t === "--orphan")) return null;
    const dd = rest.indexOf("--");
    if (dd >= 0) return { kind: "revert", paths: pathArgs(rest.slice(dd + 1)) };
    // `git checkout .` and `git checkout path/file` (no `--`); a bare branch name has no dot or slash.
    const paths = rest.filter((t) => !t.startsWith("-") && /[./]/.test(t));
    return paths.length === 0 ? null : { kind: "revert", paths: pathArgs(paths) };
  }
  return null;
}

/** Tree operations and checks of a command, in order. Empty when it has none. */
export function treeOps(command: string, repo?: RepoScripts): TreeOp[] {
  try {
    if (typeof command !== "string" || command.trim() === "") return [];
    const out: TreeOp[] = [];
    for (const seg of splitSegments(stripHeredocs(command))) {
      const s = normalizeFirstToken(stripPrefixes(seg.text));
      if (GIT.test(s)) {
        const op = gitOp(stripRedirects(tokens(s).map(unquote)));
        if (op !== null) out.push(op);
      } else if (matchSegment(seg.text, repo)) out.push({ kind: "check" });
    }
    return out;
  } catch {
    return [];
  }
}
