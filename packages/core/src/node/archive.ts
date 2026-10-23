import { randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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

/**
 * Copies new and updated session files from `projectDir` to `archiveDir`.
 * Mirrors `*.jsonl` directly in `projectDir` and all regular files in `<id>/subagents/`
 * for each session id found.
 *
 * Skips symlinks (with warnings). Skips unchanged files where size matches and destination
 * mtime is within 1000ms of source mtime. Atomic copies use a temporary file cleaned up
 * on error. Best-effort POSIX permissions 0700 for directories and 0600 for files.
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

  async function copyOrSkip(srcPath: string, destPath: string, relDesc: string): Promise<void> {
    let srcSt;
    try {
      srcSt = await lstat(srcPath);
    } catch (err) {
      result.warnings.push(`${relDesc}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      return;
    }

    if (srcSt.isSymbolicLink()) {
      result.warnings.push(`${relDesc}: symlink skipped`);
      return;
    }
    if (!srcSt.isFile()) {
      result.warnings.push(`${relDesc}: non-regular file skipped`);
      return;
    }

    try {
      const destSt = await stat(destPath);
      // Skip when dest exists with the same size and dest mtime is at least src mtime - 1000ms
      if (destSt.size === srcSt.size && destSt.mtimeMs >= srcSt.mtimeMs - 1000) {
        result.unchanged++;
        return;
      }
    } catch {
      // Dest does not exist or cannot be stated; proceed with copying
    }

    const destParent = dirname(destPath);
    await mkdir(destParent, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(destParent, 0o700).catch(() => undefined);
    }

    const tmpPath = `${destPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await copyFile(srcPath, tmpPath);
      if (process.platform !== "win32") {
        await chmod(tmpPath, 0o600).catch(() => undefined);
      }
      await rename(tmpPath, destPath);
      await utimes(destPath, new Date(srcSt.atimeMs), new Date(srcSt.mtimeMs));
      if (process.platform !== "win32") {
        await chmod(destPath, 0o600).catch(() => undefined);
      }
      result.copied++;
      result.bytes += srcSt.size;
    } catch (err) {
      result.warnings.push(`failed to archive ${relDesc}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    const sessionSrc = join(projectDir, entry.name);
    const sessionDest = join(archiveDir, entry.name);
    await copyOrSkip(sessionSrc, sessionDest, entry.name);

    // Look for subagents directory for this session
    const sessionId = entry.name.slice(0, -".jsonl".length);
    const subagentsSrcDir = join(projectDir, sessionId, "subagents");
    let subEntries;
    try {
      subEntries = await readdir(subagentsSrcDir, { withFileTypes: true });
    } catch {
      subEntries = null;
    }

    if (subEntries) {
      for (const sub of subEntries) {
        const subSrc = join(subagentsSrcDir, sub.name);
        const subDest = join(archiveDir, sessionId, "subagents", sub.name);
        await copyOrSkip(subSrc, subDest, `${sessionId}/subagents/${sub.name}`);
      }
    }
  }

  return result;
}
