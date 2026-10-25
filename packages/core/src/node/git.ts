import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GitCrosscheckResponse, GitFileEntry } from "../schema.js";

export type RunGit = (dir: string, args: readonly string[]) => Promise<string | null>;

/** `git -C <dir> <args>` via execFile (fixed arguments, no shell, timeout 10 s, maxBuffer 32 MB, windowsHide, utf8); stdout, or null on any failure. */
export const runGit: RunGit = (dir, args) =>
  new Promise((resolve) => {
    try {
      execFile("git", ["-C", dir, ...args], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout) =>
        resolve(err ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });

/** `git status --porcelain=v1 -z`: entries `XY path`; for renames and copies (`R`/`C` in X or Y) the next NUL field is the source path and is skipped. Status = XY with spaces removed (`M`, `MM`, `A`, `D`, `R`, `??`). */
export function parseStatusZ(out: string): { path: string; status: string }[] {
  if (out === "") return [];
  const entries: { path: string; status: string }[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item) continue;
    if (item.length < 3) continue;
    const status = item.slice(0, 2).replace(/ /g, "");
    const path = item.slice(3);
    const isRenameOrCopy = item[0] === "R" || item[0] === "C" || item[1] === "R" || item[1] === "C";
    entries.push({ path, status });
    if (isRenameOrCopy) {
      i++;
    }
  }
  return entries;
}

/** `git log --name-status --format=%x01%H`: a line starting with \x01 starts a commit; other non-empty lines are `<status>\t<path>` or `<R|C><score>\t<old>\t<new>` (the last field is the path, the first letter the status). The first occurrence of a path (newest commit) wins. */
export function parseLogNameStatus(out: string): { commits: number; files: { path: string; status: string }[] } {
  if (out === "") return { commits: 0, files: [] };
  let commits = 0;
  const files: { path: string; status: string }[] = [];
  const seen = new Set<string>();

  const lines = out.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("\x01")) {
      commits++;
      continue;
    }
    if (line === "") continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) continue;
    const firstField = line.slice(0, tabIdx);
    const lastTabIdx = line.lastIndexOf("\t");
    const path = line.slice(lastTabIdx + 1);
    const status = firstField.charAt(0);
    if (!status || !path) continue;
    if (!seen.has(path)) {
      seen.add(path);
      files.push({ path, status });
    }
  }

  return { commits, files };
}

export interface GitCrosscheckInput {
  /** The session's directory (its worktree root, `file.root ?? --dir`). */
  dir: string;
  /** `SessionAnalysis.branch` ("unknown" or "" when the log has none). */
  branch: string;
  /** `SessionAnalysis.startedAt`. */
  startedAt: string | null;
  /** Last write of the session log (`SessionFile.mtimeMs`). */
  endedAtMs: number;
  /** Paths edited by the session's own (non-inherited) prompts, as in `PromptAnalysis.files[].path`. */
  sessionFiles: readonly string[];
}

export const GIT_FILES_MAX = 2000;
export const GIT_COMMITS_MAX = 500;
export const GIT_WINDOW_MARGIN_MS = 10 * 60 * 1000;

export async function gitCrosscheck(
  input: GitCrosscheckInput,
  run: RunGit = runGit,
): Promise<Omit<GitCrosscheckResponse, "sessionId">> {
  const dir = input.dir;
  const notes: string[] = [];
  let truncated = false;

  // 1. rev-parse --show-toplevel
  const topOut = await run(dir, ["rev-parse", "--show-toplevel"]);
  if (topOut === null) {
    return {
      available: false,
      ref: null,
      since: null,
      until: null,
      commitCount: 0,
      uncommitted: [],
      committed: [],
      notInGit: [],
      outsideRepo: 0,
      truncated: false,
      notes: ["Not a git repository, or git is not available."],
    };
  }
  const top = topOut.trim();
  if (!top) {
    return {
      available: false,
      ref: null,
      since: null,
      until: null,
      commitCount: 0,
      uncommitted: [],
      committed: [],
      notInGit: [],
      outsideRepo: 0,
      truncated: false,
      notes: ["Not a git repository, or git is not available."],
    };
  }

  // 2. status --porcelain=v1 -z
  const statusOut = await run(dir, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  let rawUncommitted: { path: string; status: string }[] = [];
  if (statusOut === null) {
    notes.push("git status failed.");
  } else {
    rawUncommitted = parseStatusZ(statusOut);
  }

  // 3. Window & 4. Ref and log
  let ref: string | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let commitCount = 0;
  let rawCommitted: { path: string; status: string }[] = [];

  const startParsed = input.startedAt !== null ? Date.parse(input.startedAt) : NaN;
  if (Number.isNaN(startParsed)) {
    notes.push("The session start is unknown, so commits were not read.");
  } else {
    since = new Date(startParsed - GIT_WINDOW_MARGIN_MS).toISOString();
    until = new Date(input.endedAtMs + GIT_WINDOW_MARGIN_MS).toISOString();

    let refArg = "HEAD";
    const branchCandidate = input.branch.trim();
    const hasBranch = branchCandidate !== "" && branchCandidate !== "unknown" && branchCandidate !== "HEAD";

    if (hasBranch) {
      const checkFmt = await run(dir, ["check-ref-format", "--branch", branchCandidate]);
      const verifyRef = checkFmt !== null
        ? await run(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branchCandidate}^{commit}`])
        : null;

      if (checkFmt !== null && verifyRef !== null) {
        ref = branchCandidate;
        refArg = `refs/heads/${branchCandidate}`;
      } else {
        ref = "HEAD";
        refArg = "HEAD";
        notes.push(`Branch "${branchCandidate.slice(0, 60)}" was not found; commits of HEAD were read.`);
      }
    } else {
      ref = "HEAD";
      refArg = "HEAD";
      notes.push("The log names no branch; commits of HEAD were read.");
    }

    const logOut = await run(dir, [
      "-c",
      "core.quotePath=false",
      "log",
      "--no-merges",
      "--name-status",
      "--format=%x01%H",
      `--max-count=${GIT_COMMITS_MAX}`,
      `--since=${since}`,
      `--until=${until}`,
      "--end-of-options",
      refArg,
      "--",
    ]);

    if (logOut === null) {
      notes.push("git log failed.");
    } else {
      const parsedLog = parseLogNameStatus(logOut);
      commitCount = parsedLog.commits;
      if (commitCount === GIT_COMMITS_MAX) {
        truncated = true;
      }
      rawCommitted = parsedLog.files;
    }
  }

  // 5. Session paths
  const roots = [top];
  try {
    const real = realpathSync(top);
    if (real !== top) {
      roots.push(real);
    }
  } catch {
    // keep top
  }

  let outsideRepo = 0;
  const sessionSet = new Set<string>();

  for (const sessionPath of input.sessionFiles) {
    if (!isAbsolute(sessionPath)) {
      continue;
    }
    let matched = false;
    for (const r of roots) {
      const prefix = r === "/" ? "/" : r + "/";
      if (sessionPath.startsWith(prefix)) {
        sessionSet.add(sessionPath.slice(prefix.length));
        matched = true;
        break;
      }
    }
    if (!matched) {
      outsideRepo++;
    }
  }

  // 6. Entries
  let uncommitted: GitFileEntry[] = rawUncommitted
    .map((item) => ({
      path: item.path,
      status: item.status,
      inLog: sessionSet.has(item.path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (uncommitted.length > GIT_FILES_MAX) {
    truncated = true;
    uncommitted = uncommitted.slice(0, GIT_FILES_MAX);
  }

  let committed: GitFileEntry[] = rawCommitted
    .map((item) => ({
      path: item.path,
      status: item.status,
      inLog: sessionSet.has(item.path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (committed.length > GIT_FILES_MAX) {
    truncated = true;
    committed = committed.slice(0, GIT_FILES_MAX);
  }

  const gitPaths = new Set<string>();
  for (const item of rawUncommitted) {
    gitPaths.add(item.path);
  }
  for (const item of rawCommitted) {
    gitPaths.add(item.path);
  }

  let notInGit: string[] = [];
  for (const sp of sessionSet) {
    if (!gitPaths.has(sp)) {
      notInGit.push(sp);
    }
  }
  notInGit.sort((a, b) => a.localeCompare(b));

  if (notInGit.length > GIT_FILES_MAX) {
    truncated = true;
    notInGit = notInGit.slice(0, GIT_FILES_MAX);
  }

  // 7. Return
  return {
    available: true,
    ref,
    since,
    until,
    commitCount,
    uncommitted,
    committed,
    notInGit,
    outsideRepo,
    truncated,
    notes,
  };
}
