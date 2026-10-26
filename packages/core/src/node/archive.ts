import { randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";

export interface ArchiveResult {
  copied: number;
  unchanged: number;
  bytes: number;
  warnings: string[];
}

/**
 * Returns the default archive root directory:
 * env `LGTM_REVIEW_ARCHIVE` when set and non-empty, otherwise `~/.lgtm-review/archive`.
 */
export function defaultArchiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.LGTM_REVIEW_ARCHIVE;
  if (custom && custom.trim() !== "") {
    return custom;
  }
  return join(homedir(), ".lgtm-review", "archive");
}

/**
 * Computes `<archiveRoot>/<basename(projectDir)>`.
 */
export function archiveDirFor(projectDir: string, archiveRoot: string): string {
  return join(archiveRoot, basename(projectDir));
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

function isSafeName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

/**
 * Copies new and updated session files from `projectDir` to `archiveDir`.
 * Mirrors `*.jsonl` directly in `projectDir` and all regular files in `<id>/subagents/`
 * for each session id found.
 *
 * Session ids must match `[A-Za-z0-9_-]+`; other names are skipped. Skips symlinks (files and the
 * `<id>` / `subagents` source directories) and refuses to write through symlinks in the archive
 * (all with warnings). Logs are append-only: a destination larger than its source is never overwritten.
 * Unchanged files (same size, destination mtime within 1000ms of the source) are skipped. Atomic copies
 * use a temporary file created 0600 and cleaned up on error. Best-effort POSIX permissions 0700 for directories.
 */
export async function archiveSessions(projectDir: string, archiveDir: string): Promise<ArchiveResult> {
  const entries = await readdir(projectDir, { withFileTypes: true });
  const result: ArchiveResult = {
    copied: 0,
    unchanged: 0,
    bytes: 0,
    warnings: [],
  };

  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(archiveDir, 0o700).catch(() => undefined);
  }

  /** Creates each directory between `archiveDir` and `dir`; false when one is a symlink or not a directory. */
  async function ensureDestDir(dir: string, relDesc: string): Promise<boolean> {
    const parts = relative(archiveDir, dir).split(sep).filter((p) => p !== "");
    let cur = archiveDir;
    for (const part of parts) {
      cur = join(cur, part);
      try {
        const st = await lstat(cur);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          result.warnings.push(`${relDesc}: archive path ${cur} is ${st.isSymbolicLink() ? "a symlink" : "not a directory"}, skipped`);
          return false;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          result.warnings.push(`${relDesc}: archive path ${cur} unreadable (${err instanceof Error ? err.message : String(err)})`);
          return false;
        }
        await mkdir(cur, { mode: 0o700 });
      }
      if (process.platform !== "win32") {
        await chmod(cur, 0o700).catch(() => undefined);
      }
    }
    return true;
  }

  /** True when the archive holds a usable copy afterwards (copied or already up to date). */
  async function copyOrSkip(srcPath: string, destPath: string, relDesc: string): Promise<boolean> {
    let srcSt;
    try {
      srcSt = await lstat(srcPath);
    } catch (err) {
      result.warnings.push(`${relDesc}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }

    if (srcSt.isSymbolicLink()) {
      result.warnings.push(`${relDesc}: symlink skipped`);
      return false;
    }
    if (!srcSt.isFile()) {
      result.warnings.push(`${relDesc}: non-regular file skipped`);
      return false;
    }

    try {
      const destSt = await lstat(destPath);
      if (destSt.isSymbolicLink() || !destSt.isFile()) {
        result.warnings.push(`${relDesc}: archive copy is ${destSt.isSymbolicLink() ? "a symlink" : "not a regular file"}, skipped`);
        return false;
      }
      // Logs are append-only: a larger archived copy is never replaced by a truncated or older source
      if (destSt.size > srcSt.size) {
        result.warnings.push(`${relDesc}: archive copy is larger than the source, kept`);
        return true;
      }
      // Skip when dest exists with the same size and dest mtime is at least src mtime - 1000ms
      if (destSt.size === srcSt.size && destSt.mtimeMs >= srcSt.mtimeMs - 1000) {
        result.unchanged++;
        return true;
      }
    } catch {
      // Dest does not exist or cannot be stated; proceed with copying
    }

    if (!(await ensureDestDir(dirname(destPath), relDesc))) return false;

    const tmpPath = `${destPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      const fh = await open(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await pipeline(createReadStream(srcPath), fh.createWriteStream());
      await rename(tmpPath, destPath);
      await utimes(destPath, new Date(srcSt.atimeMs), new Date(srcSt.mtimeMs));
      result.copied++;
      result.bytes += srcSt.size;
      return true;
    } catch (err) {
      result.warnings.push(`failed to archive ${relDesc}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    const sessionId = entry.name.slice(0, -".jsonl".length);
    if (!SESSION_ID_RE.test(sessionId)) {
      result.warnings.push(`${entry.name}: invalid session id skipped`);
      continue;
    }
    await copyOrSkip(join(projectDir, entry.name), join(archiveDir, entry.name), entry.name);

    // Look for subagents directory for this session; a symlinked directory would leak files from elsewhere
    const subagentsSrcDir = join(projectDir, sessionId, "subagents");
    let subEntries;
    try {
      const idSt = await lstat(join(projectDir, sessionId));
      if (idSt.isSymbolicLink()) {
        result.warnings.push(`${sessionId}: symlink skipped`);
        continue;
      }
      if (!idSt.isDirectory()) continue;
      const subSt = await lstat(subagentsSrcDir);
      if (subSt.isSymbolicLink()) {
        result.warnings.push(`${sessionId}/subagents: symlink skipped`);
        continue;
      }
      if (!subSt.isDirectory()) continue;
      subEntries = await readdir(subagentsSrcDir, { withFileTypes: true });
    } catch {
      continue;
    }

    // Metas first: a transcript without its meta.json is dropped on read, so it is not archived alone
    const names = subEntries.map((e) => e.name).sort((a, b) => Number(b.endsWith(".meta.json")) - Number(a.endsWith(".meta.json")) || (a < b ? -1 : a > b ? 1 : 0));
    const failedMetas = new Set<string>();
    for (const name of names) {
      const desc = `${sessionId}/subagents/${name}`;
      if (!isSafeName(name)) {
        result.warnings.push(`${desc}: invalid file name skipped`);
        continue;
      }
      const isMeta = name.endsWith(".meta.json");
      if (!isMeta && name.endsWith(".jsonl") && failedMetas.has(`${name.slice(0, -".jsonl".length)}.meta.json`)) {
        result.warnings.push(`${desc}: meta.json not archived, transcript skipped`);
        continue;
      }
      const ok = await copyOrSkip(join(subagentsSrcDir, name), join(archiveDir, sessionId, "subagents", name), desc);
      if (!ok && isMeta) failedMetas.add(name);
    }
  }

  return result;
}
