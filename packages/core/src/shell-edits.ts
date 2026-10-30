/**
 * Heuristic detection of file edits made through Bash (`sed -i`, `tee`, `> file`, `git apply`, ...), for
 * sessions whose log carries no `bashEditDiff` (the session did not start inside the repo), and of
 * commands whose only mutating segments are git operations (merge, rebase, checkout, ...).
 * Pure string logic on the command, regex/linear, never throws.
 */

/** File name used when the target of a shell edit cannot be read off the command. */

export {
  SHELL_EDIT_FILE,
  normalizePath,
  type ShellEditTarget,
  type ShellMutation,
} from "./shell-edits-words.js";

import { isDocPath } from "./hints.js";

import {
  matchSegment,
  normalizeFirstToken,
  parseHeredocStarts,
  splitSegments,
  stripHeredocs,
  stripPrefixes,
  type RepoScripts,
  type Segment,
} from "./check-patterns.js";

import {
  canonicalizeEditPath,
  collapseSlashes,
  FILES_MAX,
  GIT_OPS,
  gitSub,
  isCheckLogTarget,
  isIgnoredPath,
  isOption,
  isUnknownTarget,
  NONE,
  nonLiteralClimb,
  normalizePath,
  operandFiles,
  parseWords,
  perlFiles,
  sedFiles,
  SHELL_EDIT_FILE,
  teeFiles,
  tempPrefixKind,
  type Redirect,
  type ShellEditTarget,
  type ShellMutation,
  type Word,
} from "./shell-edits-words.js";

import {
  GIT_APPLY_READONLY,
  pythonHasSurface,
  pythonWrites,
} from "./shell-edits-python.js";

import {
  collectAssignments,
  expandEnvSlots,
  heredocBodies,
  heredocParts,
  isReadOnlySed,
  SAFE_GIT,
  SAFE_HEADS,
  SAFE_WORKTREE,
  shellArg,
  substituteKeepingClimb,
  substituteVars,
  writesOutputFile,
  writesUnseen,
  type MutFile,
  type SegMut,
} from "./shell-edits-env.js";

import {
  aliasDefinesDirChange,
  asRepoRoots,
  assignsLoader,
  bareDirWordCount,
  commandHead,
  COMPOUND_DEC,
  COMPOUND_INC,
  COMPOUND_OPEN,
  consumeGroupingParens,
  countBraces,
  groupingDepth,
  hidesDirectory,
  isFrozenInstall,
  isGateScript,
  listEndsWithAmp,
  literalAbsPath,
  nextDir,
  placeFile,
  poisonTempNamesInSegment,
  precededByOr,
  restoredSegment,
  segmentGateBlocked,
  startsFunction,
  substitutionBodies,
  unquotedParens,
  type Dir,
  type ListMark,
} from "./shell-edits-dir.js";

function isKnownNonWriting(
  rawWords: Word[],
  redirects: Redirect[],
  dir: Dir,
  vars: ReadonlyMap<string, string>,
  repoRoots: readonly string[],
  poisoned: ReadonlySet<string>,
  gateBlocked: boolean,
  tempVars?: ReadonlySet<string>,
): boolean {
  const words = unwrapXargs(rawWords.map((w) => substituteKeepingClimb(w, vars, poisoned, tempVars)));
  const head = words[0]?.text;
  if (head === undefined) return redirects.length === 0;
  // A write redirect to an unknown target is a write we cannot see.
  if (redirects.some((r) => writesUnseen(r, poisoned, tempVars))) return false;
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
  tempVars: ReadonlySet<string>,
): SegMut | null {
  const words = unwrapXargs(rawWords.map((w) => substituteKeepingClimb(w, vars, poisoned, tempVars)));
  for (const r of redirects) if (r.target !== null) r.target = substituteKeepingClimb(r.target, vars, poisoned, tempVars);
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
        const targets = operandFiles(ops, poisoned, tempVars);
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
            for (const f of operandFiles([src], poisoned, tempVars)) {
              files.push({ file: f, kind: "D" });
            }
          }
          for (const f of operandFiles([dest], poisoned, tempVars)) {
            files.push({ file: f, kind: "A" });
          }
        } else if (ops.length === 1) {
          for (const f of operandFiles(ops, poisoned, tempVars)) {
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
    const f = sedFiles(words.slice(1), poisoned, tempVars);
    if (f !== null) {
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    }
  } else if (head === "perl") {
    const f = perlFiles(words.slice(1), poisoned, tempVars);
    if (f !== null) {
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    }
  } else if (head === "tee") {
    if (!pipedFromCheck) {
      const f = teeFiles(words.slice(1), poisoned, tempVars);
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    } else {
      const f = teeFiles(words.slice(1), poisoned, tempVars).filter((p) => !isCheckLogTarget(p, poisoned, tempVars));
      mutating = f.length > 0;
      files.push(...f.map((file) => ({ file, kind: "M" as const })));
    }
  } else if (/^python[\d.]*$/.test(head) && (heredoc !== null || heredocUnsure)) {
    // `python -c` is not scanned (C17: same as main). A heredoc, including a dash-less one, still is.
    const dash = words.findIndex((w) => w.text === "-");
    const argv = dash < 0 ? [] : words.slice(dash + 1).map((w) => shellArg(w, vars));
    const f = heredoc === null ? [SHELL_EDIT_FILE] : pythonWrites(heredoc, argv);
    surface = heredoc !== null && pythonHasSurface(heredoc);
    mutating = f.length > 0;
    files.push(...f.map((file) => ({ file, kind: "M" as const })));
  }

  let targetOpaque = false;
  // `cmd > file` / `cmd >> file`; a check's own redirects capture its log, not an edit.
  for (const r of redirects) {
    if (r.target === null) continue;
    if (r.op === ">&" && isUnknownTarget(r.target)) {
      targetOpaque = true;
      continue;
    }
    if (tempPrefixKind(r.target.text, poisoned, tempVars) === "climb" || nonLiteralClimb(r.target.text)) {
      mutating = true;
      files.push({ file: SHELL_EDIT_FILE, kind: "M" as const });
      continue;
    }
    if (isCheck && isCheckLogTarget(r.target.text, poisoned, tempVars)) continue;
    if (isIgnoredPath(r.target.text, poisoned, tempVars)) continue;
    if (r.target.text.startsWith("(") || r.target.text.startsWith(">(")) continue;
    if (isUnknownTarget(r.target)) {
      mutating = true;
      targetOpaque = true;
      files.push({ file: SHELL_EDIT_FILE, kind: "M" as const });
      continue;
    }
    mutating = true;
    files.push({ file: r.target.text, kind: "M" as const });
  }
  const fdOpaque = redirects.some(
    (r) =>
      r.fd !== "" &&
      r.fd !== "1" &&
      r.target !== null &&
      !(isCheck && isCheckLogTarget(r.target.text, poisoned, tempVars)) &&
      !isIgnoredPath(r.target.text, poisoned, tempVars) &&
      !isDocPath(r.target.text),
  );
  return mutating ? { gitOp, history, files, ...(surface || targetOpaque || fdOpaque ? { opaque: true } : {}) } : null;
}

/** Normalizes `.`/`..` segments of a path without touching the file system. */

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
    const tempVars = new Set<string>();
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
      const segText = restoredSegment(seg);
      poisonTempNamesInSegment(segText, vars, poisoned, tempVars);
      collectAssignments(segText, vars);
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
      const m = segmentMutation(words, redirects, isCheck, prevPipe && prevCheck, heredoc, unsure, vars, poisoned, tempVars);
      if (m === null && !isCheck && !isKnownNonWriting(words, redirects, placeDir, vars, repoRoots, poisoned, gateBlocked, tempVars)) opaque = true;
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
