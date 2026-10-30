import { randomBytes } from "node:crypto";
import { chmod, link, lstat, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { markInherited } from "@lgtm/core";
import type { Analyzer, FileDiff, RepoScripts, SessionAnalysis } from "@lgtm/core";
import { analyzeFile, analyzeFileDetail, discoverRootSessions, loadRepoScripts, projectDirFor, type SessionFile, type SessionRoot } from "@lgtm/core/node";
import { renderExport, type ExportInput } from "./export-html.js";

/** Total diff text (characters) put into one export; further diffs are left out. */
export const EXPORT_DIFF_CHARS_MAX = 5 * 1024 * 1024;

/** Session logs larger than this get a warning on stderr. */
export const LARGE_SESSION_BYTES = 10 * 1024 * 1024;

function diffChars(d: FileDiff): number {
  let n = d.path.length;
  for (const h of d.hunks) {
    n += h.header.length;
    for (const l of h.lines) n += l.s.length + 1;
  }
  return n;
}

/**
 * Collects the steps and (optionally) the diffs of every prompt from a finished detail analyzer.
 * Diffs are taken in order until `capChars` characters are reached; `capped` tells the renderer that the rest was left out.
 */
export function buildExportInput(analysis: SessionAnalysis, analyzer: Analyzer, opts: { diffs: boolean; capChars?: number }): { input: ExportInput; capped: boolean } {
  const cap = opts.capChars ?? EXPORT_DIFF_CHARS_MAX;
  const diffs = new Map<number, FileDiff[]>();
  let total = 0;
  let capped = false;
  if (opts.diffs) {
    outer: for (const p of analysis.prompts) {
      if (p.inheritedFrom !== undefined) continue; // omitted from the HTML, so not counted against the cap
      for (const f of p.files) {
        const d = analyzer.diffFor(p.index, f.path);
        if (d === null) continue;
        const size = diffChars(d);
        if (total + size > cap) {
          capped = true;
          break outer;
        }
        total += size;
        diffs.set(p.index, [...(diffs.get(p.index) ?? []), d]);
      }
    }
  }
  return { input: { analysis, details: analyzer.details(), diffs }, capped };
}

/** OS user names whose occurrences are replaced in free text: `os.userInfo()` plus `USER`, `USERNAME`, `LOGNAME`. */
export function osUsernames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names: string[] = [];
  try {
    names.push(userInfo().username);
  } catch {
    // no passwd entry for this uid
  }
  for (const k of ["USER", "USERNAME", "LOGNAME"]) {
    const v = env[k];
    if (v) names.push(v);
  }
  return [...new Set(names)];
}

/**
 * The exported banner date (`YYYY-MM-DD`, UTC). `SOURCE_DATE_EPOCH` (the reproducible-builds.org convention, an
 * integer of seconds since the epoch) is used when `env` holds one, today otherwise; an invalid value is ignored.
 */
export function exportDate(env: NodeJS.ProcessEnv = process.env): string {
  const ms = /^\d+$/.test(env.SOURCE_DATE_EPOCH ?? "") ? Number(env.SOURCE_DATE_EPOCH) * 1000 : NaN;
  // 8.64e15 ms is the largest moment a Date can hold; anything past it is ignored like any other invalid value
  return ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

export interface ExportCommand {
  dir: string;
  projectsDir: string;
  archiveDir?: string;
  /** From `sessionRoots`; default: `dir` alone. */
  roots?: SessionRoot[];
  prefix: string;
  /** Output file; default `lgtm-review-<8 chars of the id>.html` in the current directory. */
  out?: string;
  force: boolean;
  diffs: boolean;
  titles: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** True when `path` is `dir` itself or sits below it (both absolute); a child named `..foo` still sits below it. */
function insideDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * The place a write to `path` would land at: the real path of the closest existing ancestor (symlinked directories
 * in the parent chain are followed) with the missing names joined on lexically. An existing `path` resolves to its
 * real path.
 */
async function resolveTarget(path: string): Promise<string> {
  const tail: string[] = [];
  let p = resolve(path);
  for (;;) {
    try {
      return join(await realpath(p), ...tail.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || dirname(p) === p) throw err;
      tail.push(basename(p));
      p = dirname(p);
    }
  }
}

/** Writes through a temp file in the target directory; without `force` the target is never replaced (hard link fails if it exists). */
async function writeAtomic(target: string, data: string, force: boolean): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await chmod(tmp, 0o644);
    if (force) await rename(tmp, target);
    else await link(tmp, target);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** `--export`: writes one session as an HTML file and prints one line: the path and the number of redactions. */
export async function runExport(cmd: ExportCommand): Promise<number> {
  const projectDir = projectDirFor(cmd.dir, cmd.projectsDir);
  let files: SessionFile[];
  try {
    files = await discoverRootSessions(cmd.roots ?? [{ dir: cmd.dir, worktree: ".", projectDir, archiveDir: cmd.archiveDir ?? null }]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`lgtm-review: cannot read ${projectDir}: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
    files = [];
  }
  if (files.length === 0) {
    console.error(`lgtm-review: no Claude Code sessions found for ${cmd.dir}`);
    return 1;
  }
  const pool = files.filter((f) => f.id.startsWith(cmd.prefix));
  if (pool.length === 0) {
    console.error(`lgtm-review: no session id starts with "${cmd.prefix}"`);
    return 1;
  }
  if (pool.length > 1) {
    console.error(`lgtm-review: "${cmd.prefix}" matches ${pool.length} sessions (${pool.slice(0, 5).map((f) => f.id.slice(0, 12)).join(", ")}${pool.length > 5 ? ", …" : ""}); use a longer prefix`);
    return 1;
  }
  const file = pool[0]!;
  const out = resolve(cmd.out ?? `lgtm-review-${file.id.slice(0, 8)}.html`);
  try {
    // `--out` must never land on the session log being read, or inside session storage, with or without --force
    // (it would destroy the log or pollute session storage). Symlinks in the parent chain are resolved before
    // comparing. Storage is the projects dir plus every root's project dir and archive dir (other worktrees have
    // their own of both), so all of them are checked.
    const target = await resolveTarget(out);
    if (target === (await resolveTarget(file.path))) {
      console.error(`lgtm-review: --out ${out} is the session log ${file.path} that is being read; refusing to overwrite it; choose another --out`);
      return 1;
    }
    const storage = new Map<string, string>([[cmd.projectsDir, "a Claude projects directory"]]);
    if (cmd.archiveDir !== undefined) storage.set(cmd.archiveDir, "an archive directory");
    for (const root of cmd.roots ?? []) {
      storage.set(root.projectDir, "a Claude projects directory");
      if (root.archiveDir !== null) storage.set(root.archiveDir, "an archive directory");
    }
    for (const [dir, what] of storage) {
      const real = await resolveTarget(dir);
      if (insideDir(target, real)) {
        console.error(`lgtm-review: --out ${out} resolves to ${target}, inside ${real} (${what}); refusing to write there; choose another --out`);
        return 1;
      }
    }
  } catch (err) {
    console.error(`lgtm-review: cannot check --out ${out}: ${err instanceof Error ? err.message : err}; refusing to write it`);
    return 1;
  }
  try {
    if (!cmd.force && (await exists(out))) {
      console.error(`lgtm-review: ${out} already exists; use --force to overwrite or --out to choose another file`);
      return 1;
    }
  } catch (err) {
    console.error(`lgtm-review: cannot write ${out}: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  try {
    const size = (await stat(file.path)).size;
    if (size > LARGE_SESSION_BYTES) console.error(`warning: ${file.id}.jsonl is ${(size / 1024 / 1024).toFixed(1)} MB; the export can be large and slow`);
  } catch {
    // reported by the analysis below
  }

  let result;
  try {
    const repos = new Map<string, Promise<RepoScripts>>();
    const repoFor = (d: string) => {
      let p = repos.get(d);
      if (!p) repos.set(d, (p = loadRepoScripts(d)));
      return p;
    };
    const repo = await repoFor(file.root ?? cmd.dir);
    const detail = await analyzeFileDetail(file.path, { repo, sessionId: file.id, file: `${file.id}.jsonl` });
    if (file.archived) detail.analysis.archived = true;
    if (file.worktree !== undefined) detail.analysis.worktree = file.worktree;
    const { analyzer } = detail;
    // Inheritance depends on the other sessions of the project; unreadable ones are skipped.
    const all: SessionAnalysis[] = [detail.analysis];
    for (const f of files) {
      if (f === file) continue;
      try {
        const a = await analyzeFile(f.path, { repo: await repoFor(f.root ?? cmd.dir), sessionId: f.id, file: `${f.id}.jsonl` });
        if (f.archived) a.archived = true;
        if (f.worktree !== undefined) a.worktree = f.worktree;
        all.push(a);
      } catch {
        // skipped, like the list does
      }
    }
    const analysis = markInherited(all)[0]!;
    const { input, capped } = buildExportInput(analysis, analyzer, { diffs: cmd.diffs });
    if (capped) console.error("warning: diffs omitted (size cap)");
    result = renderExport(input, {
      titles: cmd.titles,
      diffs: cmd.diffs,
      exportedAt: exportDate(),
      redact: { usernames: osUsernames(), repoDir: file.root ?? cmd.dir },
      diffsCapped: capped,
    });
  } catch (err) {
    console.error(`lgtm-review: cannot read ${file.id}.jsonl: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  try {
    await writeAtomic(out, result.html, cmd.force);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") console.error(`lgtm-review: ${out} already exists; use --force to overwrite or --out to choose another file`);
    else console.error(`lgtm-review: cannot write ${out}: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  process.stdout.write(`${out}  (${result.redactions} ${result.redactions === 1 ? "redaction" : "redactions"})\n`);
  return 0;
}
