import { readdirSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RepoScripts } from "../check-patterns.js";

export interface SessionFile {
  path: string;
  /** File name without ".jsonl". */
  id: string;
  mtimeMs: number;
  /** File size in bytes. */
  size?: number;
  /** True only when the session was discovered from the local archive. */
  archived?: true;
  /** Directory of the root the session was found under. */
  root?: string;
  /** Worktree label; set only when sessions came from more than one root. */
  worktree?: string;
}

export interface SessionRoot {
  /** Directory whose Claude Code project dir is read: `--dir` itself, or another worktree's root. */
  dir: string;
  /** Path of the root's worktree relative to the main checkout, "/"-separated; "." for the main checkout. */
  worktree: string;
  projectDir: string;
  /** Archive dir of this root's project dir; null when no archive root is used. */
  archiveDir: string | null;
}

export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Claude Code names a project dir after the cwd with trailing slashes stripped (keeping `/` itself)
 * and every non-alphanumeric character replaced by `-`.
 * When longer than 200 characters, Claude Code appends a hash (`name.slice(0, 200) + '-' + hash`);
 * if a single entry in `projectsDir` matches `name.slice(0, 200) + '-'`, it is used; otherwise,
 * `name.slice(0, 200)` is returned so no wrong session is read.
 */
export function projectDirFor(cwd: string, projectsDir: string = defaultProjectsDir()): string {
  const stripped = cwd.replace(/[/\\]+$/, "");
  const clean = stripped === "" && cwd !== "" ? "/" : stripped;
  const name = clean.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) {
    return join(projectsDir, name);
  }
  const prefix = name.slice(0, 200) + "-";
  let matches: string[] = [];
  try {
    matches = readdirSync(projectsDir).filter((e) => e.startsWith(prefix));
  } catch {
    // projectsDir missing or unreadable
  }
  if (matches.length === 1) {
    return join(projectsDir, matches[0]!);
  }
  return join(projectsDir, name.slice(0, 200));
}

/**
 * Non-empty `*.jsonl` files directly in the project dir (subagent transcripts live deeper and are not read;
 * dotfiles and 0-byte files are skipped), newest first. Unreadable entries are skipped and described in
 * `warnings` when given. Throws if the directory itself cannot be read.
 */
export async function discoverSessions(dir: string, warnings?: string[]): Promise<SessionFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: SessionFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".") || !e.name.endsWith(".jsonl")) continue;
    const path = join(dir, e.name);
    try {
      const st = await stat(path);
      if (st.size === 0) continue;
      out.push({ path, id: e.name.slice(0, -".jsonl".length), mtimeMs: st.mtimeMs, size: st.size });
    } catch (err) {
      warnings?.push(`${e.name}: unreadable (${err instanceof Error ? err.message : "error"})`);
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Discovers all sessions by merging live sessions from `projectDir` with archived sessions
 * from `archiveDir` (when provided).
 *
 * - When a session is present in both: if the archived copy is larger than the live copy,
 *   the archived copy is used with `archived: true` (a shorter live log is considered damaged);
 *   otherwise the live copy wins.
 * - A session present only in the archive is returned with `archived: true`.
 * - If `projectDir` is missing (ENOENT) but `archiveDir` exists, returns the archived sessions without throwing.
 * - If both directories are missing, throws the ENOENT for `projectDir` (identical to `discoverSessions`).
 * - Sorted newest first by mtime, then by id.
 */
export async function discoverAllSessions(
  projectDir: string,
  archiveDir: string | null,
  warnings?: string[],
): Promise<SessionFile[]> {
  let archiveExists = false;
  let archiveFiles: SessionFile[] = [];
  if (archiveDir !== null) {
    try {
      const st = await stat(archiveDir);
      if (st.isDirectory()) {
        archiveExists = true;
        archiveFiles = await discoverSessions(archiveDir, warnings);
      }
    } catch {
      // Archive directory does not exist or cannot be read
    }
  }

  let liveFiles: SessionFile[];
  try {
    liveFiles = await discoverSessions(projectDir, warnings);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (!archiveExists) {
        throw err;
      }
      liveFiles = [];
    } else {
      throw err;
    }
  }

  const archiveMap = new Map<string, SessionFile>();
  for (const f of archiveFiles) {
    archiveMap.set(f.id, f);
  }

  const resultFiles: SessionFile[] = [];
  const processedIds = new Set<string>();

  for (const live of liveFiles) {
    processedIds.add(live.id);
    const arch = archiveMap.get(live.id);
    if (arch !== undefined && (arch.size ?? 0) > (live.size ?? 0)) {
      resultFiles.push({ ...arch, archived: true as const });
    } else {
      resultFiles.push(live);
    }
  }

  for (const arch of archiveFiles) {
    if (!processedIds.has(arch.id)) {
      resultFiles.push({ ...arch, archived: true as const });
    }
  }

  return resultFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Sessions of every root: live and archived (`discoverAllSessions` per root), tagged with `root`; a live session wins over an archived one of the same id in any root, otherwise an id seen in an earlier root wins; newest first like `discoverSessions`. */
export async function discoverRootSessions(
  roots: readonly SessionRoot[],
  warnings?: string[],
): Promise<SessionFile[]> {
  const byId = new Map<string, SessionFile>();
  for (const [i, root] of roots.entries()) {
    let files: SessionFile[];
    try {
      files = await discoverAllSessions(root.projectDir, root.archiveDir, warnings);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (i === 0) throw err;
      warnings?.push(`${root.projectDir}: unreadable (${err instanceof Error ? err.message : "error"})`);
      continue;
    }
    for (const f of files) {
      const prev = byId.get(f.id);
      if (prev && !(prev.archived && !f.archived)) continue;
      byId.set(f.id, { ...f, root: root.dir, worktree: root.worktree });
    }
  }
  const out = [...byId.values()];
  if (new Set(out.map((f) => f.root)).size < 2) for (const f of out) delete f.worktree;
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const PKG_SCRIPTS = new Set(["test", "lint", "typecheck", "check", "build"]);
const MAKE_TARGETS = new Set(["test", "check", "lint", "build"]);
const SCRIPT_FILE_RE = /^(check|test|lint|ci|verify|validate|gate|mutation|smoke)[^/\s]*\.sh$/;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Reads only the root package.json scripts, the root Makefile targets and root scripts/*.sh names. */
export async function loadRepoScripts(cwd: string): Promise<RepoScripts> {
  const res: RepoScripts = { packageScripts: [], makeTargets: [], scriptFiles: [] };

  const pkg = await readText(join(cwd, "package.json"));
  if (pkg !== null) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: unknown }).scripts;
      if (scripts && typeof scripts === "object") {
        res.packageScripts = Object.keys(scripts).filter((k) => PKG_SCRIPTS.has(k)).sort();
      }
    } catch {
      // malformed package.json: no scripts
    }
  }

  const mk = await readText(join(cwd, "Makefile"));
  if (mk !== null) {
    const found = new Set<string>();
    for (const m of mk.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) {
      if (MAKE_TARGETS.has(m[1] as string)) found.add(m[1] as string);
    }
    res.makeTargets = [...found].sort();
  }

  try {
    const names = await readdir(join(cwd, "scripts"));
    res.scriptFiles = names.filter((n) => SCRIPT_FILE_RE.test(n)).sort().map((n) => `scripts/${n}`);
  } catch {
    // no scripts dir
  }
  return res;
}
