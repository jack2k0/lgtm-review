import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { archiveDirFor } from "./archive.js";
import { projectDirFor, type SessionRoot } from "./discover.js";

export interface Worktree {
  /** Absolute path as git reports it. */
  path: string;
  /** Branch name without `refs/heads/`, or null (detached HEAD). */
  branch: string | null;
}

export interface WorktreeList {
  main: string | null;
  worktrees: Worktree[];
}

/**
 * Parses `git worktree list --porcelain -z`: NUL-terminated lines, records separated by an empty line,
 * each starting with `worktree <path>`. The first record is the main worktree; its path is returned as
 * `main` even when it is `bare`. Records marked `bare` or `prunable` are left out of `worktrees`.
 */
export function parseWorktreeList(stdout: string): WorktreeList {
  const records: string[][] = [];
  let cur: string[] = [];
  for (const line of stdout.split("\0")) {
    if (line === "") {
      if (cur.length > 0) records.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) records.push(cur);

  let main: string | null = null;
  const worktrees: Worktree[] = [];
  for (const [i, rec] of records.entries()) {
    const first = rec[0];
    if (first === undefined || !first.startsWith("worktree ")) continue;
    const path = first.slice("worktree ".length);
    if (i === 0) main = path;
    if (rec.some((l) => l === "bare" || l === "prunable" || l.startsWith("prunable "))) continue;
    const b = rec.find((l) => l.startsWith("branch "));
    const branch = b === undefined ? null : b.slice("branch ".length).replace(/^refs\/heads\//, "");
    worktrees.push({ path, branch });
  }
  return { main, worktrees };
}

/** `git -C <dir> worktree list --porcelain -z`; null on any failure (git missing, not a repository, `dir` missing). */
export function listWorktrees(dir: string): Promise<WorktreeList | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-C", dir, "worktree", "list", "--porcelain", "-z"],
        { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" },
        (err, stdout) => resolve(err ? null : parseWorktreeList(stdout)),
      );
    } catch {
      resolve(null);
    }
  });
}

function labelFor(main: string, path: string): string {
  const rel = relative(main, path).split(sep).join("/");
  return rel === "" ? "." : rel;
}

/** `--dir` first, then every other listed worktree in git's order. Only `--dir` (worktree ".") when `opts.worktrees` is false, git fails or one worktree is listed. `list` is injectable for tests. */
export async function sessionRoots(
  dir: string,
  projectsDir: string,
  archiveRoot: string | null,
  opts: { worktrees: boolean },
  list: typeof listWorktrees = listWorktrees,
): Promise<SessionRoot[]> {
  const realOf = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const real = realOf(dir);
  const mk = (d: string, worktree: string, pdirTarget: string = d): SessionRoot => {
    const projectDir = projectDirFor(pdirTarget, projectsDir);
    return { dir: d, worktree, projectDir, archiveDir: archiveRoot === null ? null : archiveDirFor(projectDir, archiveRoot) };
  };
  const single = [mk(dir, ".", real)];
  if (!opts.worktrees) return single;
  const res = await list(dir);
  if (res === null || res.main === null || res.worktrees.length <= 1) return single;
  const main = res.main;

  let own: Worktree | null = null;
  for (const w of res.worktrees) {
    if (real === w.path || real.startsWith(w.path.endsWith("/") ? w.path : w.path + "/")) {
      if (own === null || w.path.length > own.path.length) own = w;
    }
  }
  const roots = [mk(dir, own === null ? "." : labelFor(main, own.path), real)];
  for (const w of res.worktrees) {
    if (w === own) continue;
    roots.push(mk(w.path, labelFor(main, w.path), realOf(w.path)));
  }
  return roots;
}
