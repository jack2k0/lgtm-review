import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RepoScripts } from "../check-patterns.js";

export interface SessionFile {
  path: string;
  /** File name without ".jsonl". */
  id: string;
  mtimeMs: number;
}

export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** Claude Code names a project dir after the cwd with `/` and `.` replaced by `-`. */
export function projectDirFor(cwd: string, projectsDir: string = defaultProjectsDir()): string {
  return join(projectsDir, cwd.replace(/[/.]/g, "-"));
}

/**
 * `*.jsonl` files directly in the project dir (subagent transcripts live deeper and are not read),
 * newest first. Unreadable entries are skipped and described in `warnings` when given.
 * Throws if the directory itself cannot be read.
 */
export async function discoverSessions(dir: string, warnings?: string[]): Promise<SessionFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: SessionFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const path = join(dir, e.name);
    try {
      const st = await stat(path);
      out.push({ path, id: e.name.slice(0, -".jsonl".length), mtimeMs: st.mtimeMs });
    } catch (err) {
      warnings?.push(`${e.name}: unreadable (${err instanceof Error ? err.message : "error"})`);
    }
  }
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
