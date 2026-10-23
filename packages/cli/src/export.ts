import { randomBytes } from "node:crypto";
import { chmod, link, lstat, rename, stat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { markInherited } from "@lgtm/core";
import type { Analyzer, FileDiff, SessionAnalysis } from "@lgtm/core";
import { analyzeFile, analyzeFileDetail, discoverAllSessions, loadRepoScripts, projectDirFor, type SessionFile } from "@lgtm/core/node";
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

export interface ExportCommand {
  dir: string;
  projectsDir: string;
  archiveDir?: string;
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
    files = await discoverAllSessions(projectDir, cmd.archiveDir ?? null);
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
    const repo = await loadRepoScripts(cmd.dir);
    const detail = await analyzeFileDetail(file.path, { repo, sessionId: file.id, file: `${file.id}.jsonl` });
    if (file.archived) detail.analysis.archived = true;
    const { analyzer } = detail;
    // Inheritance depends on the other sessions of the project; unreadable ones are skipped.
    const all: SessionAnalysis[] = [detail.analysis];
    for (const f of files) {
      if (f === file) continue;
      try {
        const a = await analyzeFile(f.path, { repo, sessionId: f.id, file: `${f.id}.jsonl` });
        if (f.archived) a.archived = true;
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
      exportedAt: new Date().toISOString().slice(0, 10),
      redact: { usernames: osUsernames(), repoDir: cmd.dir },
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
