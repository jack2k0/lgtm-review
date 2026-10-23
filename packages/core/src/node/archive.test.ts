import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { archiveDirFor, archiveSessions, defaultArchiveRoot } from "./archive.js";
import { discoverAllSessions } from "./discover.js";
import { analyzeFile } from "./read.js";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lgtm-archive-test-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("defaultArchiveRoot", () => {
  test("uses env var when set and non-empty", () => {
    expect(defaultArchiveRoot({ LGTM_REVIEW_ARCHIVE: "/custom/archive" })).toBe("/custom/archive");
  });

  test("falls back when env var is missing or empty", () => {
    const expected = join(homedir(), ".lgtm-review", "archive");
    expect(defaultArchiveRoot({})).toBe(expected);
    expect(defaultArchiveRoot({ LGTM_REVIEW_ARCHIVE: "" })).toBe(expected);
    expect(defaultArchiveRoot({ LGTM_REVIEW_ARCHIVE: "   " })).toBe(expected);
  });
});

describe("archiveDirFor", () => {
  test("joins archiveRoot with basename of projectDir", () => {
    expect(archiveDirFor("/home/user/.claude/projects/-home-user-repo", "/home/user/.lgtm-review/archive")).toBe(
      "/home/user/.lgtm-review/archive/-home-user-repo",
    );
  });
});

describe("archiveSessions", () => {
  test("first copy copies files, second run skips unchanged (C4), grown file recopies", () =>
    withTmp(async (dir) => {
      const projectDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(projectDir, { recursive: true });

      const sessionFile = join(projectDir, "sess-1.jsonl");
      writeFileSync(sessionFile, '{"type":"session","id":"sess-1"}\n');
      utimesSync(sessionFile, 1000, 1000);

      // 1. First copy
      const r1 = await archiveSessions(projectDir, archiveDir);
      expect(r1.copied).toBe(1);
      expect(r1.unchanged).toBe(0);
      expect(r1.bytes).toBeGreaterThan(0);
      expect(r1.warnings).toEqual([]);
      expect(readFileSync(join(archiveDir, "sess-1.jsonl"), "utf8")).toBe('{"type":"session","id":"sess-1"}\n');

      // 2. Unchanged second run
      const r2 = await archiveSessions(projectDir, archiveDir);
      expect(r2.copied).toBe(0);
      expect(r2.unchanged).toBe(1);
      expect(r2.bytes).toBe(0);
      expect(r2.warnings).toEqual([]);

      // 3. Grown file recopied
      appendFileSync(sessionFile, '{"type":"prompt","text":"next"}\n');
      utimesSync(sessionFile, 2000, 2000);
      const r3 = await archiveSessions(projectDir, archiveDir);
      expect(r3.copied).toBe(1);
      expect(r3.unchanged).toBe(0);
      expect(readFileSync(join(archiveDir, "sess-1.jsonl"), "utf8")).toContain('"text":"next"');
    }));

  test("skips symlinks with warnings", () =>
    withTmp(async (dir) => {
      const projectDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(projectDir, { recursive: true });

      const realFile = join(dir, "outside.jsonl");
      writeFileSync(realFile, '{"type":"session"}\n');
      symlinkSync(realFile, join(projectDir, "linked.jsonl"));

      const r = await archiveSessions(projectDir, archiveDir);
      expect(r.copied).toBe(0);
      expect(r.warnings.some((w) => w.includes("symlink skipped"))).toBe(true);
      expect(readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
    }));

  test("mirrors subagent transcripts and meta.json (C1) and reads clean after live deleted", () =>
    withTmp(async (dir) => {
      const projectDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      const subDir = join(projectDir, "sess-sub", "subagents");
      mkdirSync(subDir, { recursive: true });

      // Session file that calls an agent
      const sessionFile = join(projectDir, "sess-sub.jsonl");
      const promptLine = JSON.stringify({
        type: "user",
        message: { role: "user", content: "run subagent" },
      });
      const agentCallLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "Agent",
              input: { prompt: "research something" },
            },
          ],
        },
      });
      writeFileSync(sessionFile, `${promptLine}\n${agentCallLine}\n`);

      // Subagent files: transcript and meta
      writeFileSync(
        join(subDir, "agent-sub1.jsonl"),
        JSON.stringify({ type: "user", message: { role: "user", content: "inner" } }) + "\n",
      );
      writeFileSync(
        join(subDir, "agent-sub1.meta.json"),
        JSON.stringify({ toolUseId: "toolu_01", description: "subagent task" }),
      );

      const r = await archiveSessions(projectDir, archiveDir);
      expect(r.copied).toBe(3); // sess-sub.jsonl, agent-sub1.jsonl, agent-sub1.meta.json
      expect(r.warnings).toEqual([]);

      // Delete live directory to simulate Claude Code cleanup
      rmSync(projectDir, { recursive: true, force: true });

      // The archived session should analyze cleanly and include the subagent without warnings
      const archivedSessionPath = join(archiveDir, "sess-sub.jsonl");
      const analysis = await analyzeFile(archivedSessionPath, { sessionId: "sess-sub", file: "sess-sub.jsonl" });
      expect(analysis.warnings).toEqual([]);
      expect(analysis.prompts).toHaveLength(1);
    }));

  test("creates directories 0700 and files 0600 (POSIX)", () =>
    withTmp(async (dir) => {
      if (process.platform === "win32") return;
      const projectDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(join(projectDir, "sess.jsonl"), '{"type":"session"}\n');
      await archiveSessions(projectDir, archiveDir);

      const dirSt = await stat(archiveDir);
      const fileSt = await stat(join(archiveDir, "sess.jsonl"));
      expect(dirSt.mode & 0o777).toBe(0o700);
      expect(fileSt.mode & 0o777).toBe(0o600);
    }));

  test("cleans up temporary *.tmp-* files on error (C5)", () =>
    withTmp(async (dir) => {
      const projectDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(projectDir, { recursive: true });

      const unreadable = join(projectDir, "unreadable.jsonl");
      writeFileSync(unreadable, '{"type":"session"}\n');
      if (process.platform !== "win32") {
        chmodSync(unreadable, 0o000);
      }

      try {
        const r = await archiveSessions(projectDir, archiveDir);
        if (process.platform !== "win32") {
          expect(r.warnings.length).toBeGreaterThan(0);
        }
        // Verify no leftover .tmp- files in archiveDir
        const entries = readdirSync(archiveDir);
        expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
      } finally {
        if (process.platform !== "win32") {
          chmodSync(unreadable, 0o600);
        }
      }
    }));
});

describe("discoverAllSessions", () => {
  test("live wins when session exists in both live and archive", () =>
    withTmp(async (dir) => {
      const liveDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(liveDir, { recursive: true });
      mkdirSync(archiveDir, { recursive: true });

      writeFileSync(join(liveDir, "sess-a.jsonl"), "live");
      writeFileSync(join(archiveDir, "sess-a.jsonl"), "archive");
      utimesSync(join(liveDir, "sess-a.jsonl"), 2000, 2000);
      utimesSync(join(archiveDir, "sess-a.jsonl"), 1000, 1000);

      const found = await discoverAllSessions(liveDir, archiveDir);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe("sess-a");
      expect(found[0].path).toBe(join(liveDir, "sess-a.jsonl"));
      expect(found[0].archived).toBeUndefined();
    }));

  test("marks archive-only session with archived: true", () =>
    withTmp(async (dir) => {
      const liveDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(liveDir, { recursive: true });
      mkdirSync(archiveDir, { recursive: true });

      writeFileSync(join(liveDir, "sess-live.jsonl"), "live");
      writeFileSync(join(archiveDir, "sess-archived.jsonl"), "archive");
      utimesSync(join(liveDir, "sess-live.jsonl"), 1000, 1000);
      utimesSync(join(archiveDir, "sess-archived.jsonl"), 2000, 2000);

      const found = await discoverAllSessions(liveDir, archiveDir);
      expect(found).toHaveLength(2);
      expect(found[0].id).toBe("sess-archived");
      expect(found[0].archived).toBe(true);
      expect(found[0].path).toBe(join(archiveDir, "sess-archived.jsonl"));
      expect(found[1].id).toBe("sess-live");
      expect(found[1].archived).toBeUndefined();
    }));

  test("both missing throws error identical to discoverSessions", () =>
    withTmp(async (dir) => {
      const missingLive = join(dir, "nonexistent-live");
      const missingArchive = join(dir, "nonexistent-archive");

      await expect(discoverAllSessions(missingLive, missingArchive)).rejects.toThrow();
      await expect(discoverAllSessions(missingLive, null)).rejects.toThrow();
    }));

  test("project dir missing but archive present returns archive sessions without throw", () =>
    withTmp(async (dir) => {
      const missingLive = join(dir, "nonexistent-live");
      const archiveDir = join(dir, "archive");
      mkdirSync(archiveDir, { recursive: true });

      writeFileSync(join(archiveDir, "old-sess.jsonl"), "old");

      const found = await discoverAllSessions(missingLive, archiveDir);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe("old-sess");
      expect(found[0].archived).toBe(true);
    }));
});
