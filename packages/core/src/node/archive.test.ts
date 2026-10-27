import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { archiveDirFor, archiveSessions, defaultArchiveRoot } from "./archive.js";
import { discoverAllSessions, discoverRootSessions } from "./discover.js";
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

  test("finds hashed archive dir for >200 char repo path when live projectDir is gone", () =>
    withTmp(async (dir) => {
      const archiveRoot = join(dir, "archiveRoot");
      mkdirSync(archiveRoot, { recursive: true });

      const longPrefix = "a".repeat(200);
      const hashedName = `${longPrefix}-hash9876`;
      mkdirSync(join(archiveRoot, hashedName));
      writeFileSync(join(archiveRoot, hashedName, "s.jsonl"), "{}\n");

      // projectDir does not exist, name is 200 chars prefix
      const nonExistentLive = join(dir, "projects", longPrefix);
      const resolvedArchive = archiveDirFor(nonExistentLive, archiveRoot);
      expect(resolvedArchive).toBe(join(archiveRoot, hashedName));
    }));
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

      writeFileSync(join(liveDir, "sess-a.jsonl"), "live-data");
      writeFileSync(join(archiveDir, "sess-a.jsonl"), "archive");
      utimesSync(join(liveDir, "sess-a.jsonl"), 2000, 2000);
      utimesSync(join(archiveDir, "sess-a.jsonl"), 1000, 1000);

      const found = await discoverAllSessions(liveDir, archiveDir);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe("sess-a");
      expect(found[0].path).toBe(join(liveDir, "sess-a.jsonl"));
      expect(found[0].archived).toBeUndefined();
    }));

  test("archived copy wins when session exists in both live and archive and archive is larger", () =>
    withTmp(async (dir) => {
      const liveDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(liveDir, { recursive: true });
      mkdirSync(archiveDir, { recursive: true });

      writeFileSync(join(liveDir, "sess-a.jsonl"), "short");
      writeFileSync(join(archiveDir, "sess-a.jsonl"), "longer-archived-content");

      const found = await discoverAllSessions(liveDir, archiveDir);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe("sess-a");
      expect(found[0].path).toBe(join(archiveDir, "sess-a.jsonl"));
      expect(found[0].archived).toBe(true);
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

  test.skipIf(process.platform === "win32")("returns archived sessions with warning when live projectDir is unreadable (EACCES)", () =>
    withTmp(async (dir) => {
      const liveDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(liveDir, { recursive: true });
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, "sess-arch.jsonl"), "content");
      chmodSync(liveDir, 0o000);
      try {
        const warnings: string[] = [];
        const found = await discoverAllSessions(liveDir, archiveDir, warnings);
        expect(found).toHaveLength(1);
        expect(found[0].id).toBe("sess-arch");
        expect(found[0].archived).toBe(true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`${liveDir}: unreadable`);
        expect(warnings[0]).toContain("showing archived sessions only");

        // without archive, keeps throwing
        await expect(discoverAllSessions(liveDir, null)).rejects.toThrow();
      } finally {
        chmodSync(liveDir, 0o755);
      }
    }));

  test("skips dotfiles and 0-byte files in live and archive directories", () =>
    withTmp(async (dir) => {
      const liveDir = join(dir, "live");
      const archiveDir = join(dir, "archive");
      mkdirSync(liveDir, { recursive: true });
      mkdirSync(archiveDir, { recursive: true });

      writeFileSync(join(liveDir, "empty-live.jsonl"), "");
      writeFileSync(join(liveDir, ".dot-live.jsonl"), "content");
      writeFileSync(join(liveDir, "valid-live.jsonl"), "content");

      writeFileSync(join(archiveDir, "empty-arch.jsonl"), "");
      writeFileSync(join(archiveDir, ".dot-arch.jsonl"), "content");
      writeFileSync(join(archiveDir, "valid-arch.jsonl"), "content");

      const found = await discoverAllSessions(liveDir, archiveDir);
      expect(found.map((f) => f.id).sort()).toEqual(["valid-arch", "valid-live"]);
    }));
});

describe("archiveSessions safety", () => {
  const setup = (dir: string) => {
    const projectDir = join(dir, "live");
    const archiveDir = join(dir, "archive");
    mkdirSync(projectDir, { recursive: true });
    return { projectDir, archiveDir };
  };

  test("skips a symlinked <id> directory and a symlinked subagents directory", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      const outside = join(dir, "outside");
      mkdirSync(join(outside, "subagents"), { recursive: true });
      writeFileSync(join(outside, "subagents", "agent-x.jsonl"), "secret\n");
      writeFileSync(join(projectDir, "a1.jsonl"), "{}\n");
      symlinkSync(outside, join(projectDir, "a1"));
      writeFileSync(join(projectDir, "b1.jsonl"), "{}\n");
      mkdirSync(join(projectDir, "b1"));
      symlinkSync(join(outside, "subagents"), join(projectDir, "b1", "subagents"));

      const r = await archiveSessions(projectDir, archiveDir);
      expect(r.copied).toBe(2);
      expect(r.warnings.some((w) => w.includes("a1: symlink skipped"))).toBe(true);
      expect(r.warnings.some((w) => w.includes("b1/subagents: symlink skipped"))).toBe(true);
      expect(readdirSync(archiveDir).sort()).toEqual(["a1.jsonl", "b1.jsonl"]);
    }));

  test("never replaces a larger archived copy with a smaller source", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      writeFileSync(join(projectDir, "s.jsonl"), "line1\nline2\nline3\n");
      await archiveSessions(projectDir, archiveDir);
      writeFileSync(join(projectDir, "s.jsonl"), "line1\n");
      const r = await archiveSessions(projectDir, archiveDir);
      expect(r.copied).toBe(0);
      expect(r.warnings.some((w) => w.includes("larger than the source"))).toBe(true);
      expect(readFileSync(join(archiveDir, "s.jsonl"), "utf8")).toBe("line1\nline2\nline3\n");
    }));

  test("skips invalid session ids and subagent names", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      writeFileSync(join(projectDir, "bad@1.jsonl"), "{}\n");
      writeFileSync(join(projectDir, "bad#2.jsonl"), "{}\n");
      writeFileSync(join(projectDir, "a b.jsonl"), "{}\n");
      writeFileSync(join(projectDir, "ok-1_x.jsonl"), "{}\n");
      const r = await archiveSessions(projectDir, archiveDir);
      expect(r.copied).toBe(1);
      expect(r.warnings.filter((w) => w.includes("invalid session id"))).toHaveLength(3);
      expect(readdirSync(archiveDir)).toEqual(["ok-1_x.jsonl"]);
      expect(readdirSync(dir).sort()).toEqual(["archive", "live"]);
    }));

  test("refuses to write through symlinked destination directories and files", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      const outside = join(dir, "outside");
      mkdirSync(outside);
      mkdirSync(archiveDir);
      for (const id of ["d1", "d2"]) {
        writeFileSync(join(projectDir, `${id}.jsonl`), "{}\n");
        mkdirSync(join(projectDir, id, "subagents"), { recursive: true });
        writeFileSync(join(projectDir, id, "subagents", "agent-a.jsonl"), "x\n");
        writeFileSync(join(projectDir, id, "subagents", "agent-a.meta.json"), "{}\n");
      }
      symlinkSync(outside, join(archiveDir, "d1"));
      mkdirSync(join(archiveDir, "d2"));
      symlinkSync(outside, join(archiveDir, "d2", "subagents"));
      writeFileSync(join(dir, "target.jsonl"), "keep\n");
      writeFileSync(join(projectDir, "f1.jsonl"), "{}\n");
      symlinkSync(join(dir, "target.jsonl"), join(archiveDir, "f1.jsonl"));

      const r = await archiveSessions(projectDir, archiveDir);
      expect(readdirSync(outside)).toEqual([]);
      expect(readFileSync(join(dir, "target.jsonl"), "utf8")).toBe("keep\n");
      expect(r.warnings.filter((w) => w.includes("symlink")).length).toBeGreaterThanOrEqual(3);
    }));

  test.skipIf(process.platform === "win32")("temp file is created 0600 (not chmod'ed afterwards)", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      writeFileSync(join(projectDir, "s.jsonl"), "{}\n", { mode: 0o644 });
      const oldMask = process.umask(0);
      try {
        await archiveSessions(projectDir, archiveDir);
      } finally {
        process.umask(oldMask);
      }
      expect((await lstat(join(archiveDir, "s.jsonl"))).mode & 0o777).toBe(0o600);
      // the temp file must already be 0600 when created: umask 0 would make copyFile produce 0644
      const src = readFileSync(new URL("./archive.ts", import.meta.url), "utf8");
      expect(src).toContain("0o600)");
      expect(src).not.toContain("copyFile");
    }));

  test("does not archive a subagent transcript whose meta.json cannot be copied, copies metas", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      writeFileSync(join(projectDir, "s.jsonl"), "{}\n");
      const sub = join(projectDir, "s", "subagents");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "agent-a.jsonl"), "a\n");
      writeFileSync(join(sub, "agent-a.meta.json"), "{}");
      writeFileSync(join(sub, "agent-b.jsonl"), "b\n");
      writeFileSync(join(sub, "agent-b.meta.json"), "{}");
      // block agent-b's meta copy: archive-side symlink
      mkdirSync(join(archiveDir, "s", "subagents"), { recursive: true });
      writeFileSync(join(dir, "t"), "x");
      symlinkSync(join(dir, "t"), join(archiveDir, "s", "subagents", "agent-b.meta.json"));

      const r = await archiveSessions(projectDir, archiveDir);
      const got = readdirSync(join(archiveDir, "s", "subagents")).sort();
      expect(got).toEqual(["agent-a.jsonl", "agent-a.meta.json", "agent-b.meta.json"]);
      expect(r.warnings.some((w) => w.includes("agent-b.jsonl: meta.json not archived"))).toBe(true);
    }));

  test("skips subagent transcript when meta.json is absent from source", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      writeFileSync(join(projectDir, "sess.jsonl"), "{}\n");
      const sub = join(projectDir, "sess", "subagents");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "agent-orphan.jsonl"), "orphan transcript\n");

      const r = await archiveSessions(projectDir, archiveDir);
      expect(r.copied).toBe(1);
      expect(r.warnings.some((w) => w.includes("agent-orphan.jsonl: meta.json not archived, transcript skipped"))).toBe(true);
      expect(existsSync(join(archiveDir, "sess", "subagents", "agent-orphan.jsonl"))).toBe(false);
    }));

  test("only archives agent-*.jsonl and agent-*.meta.json from subagents, skipping extraneous files", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      writeFileSync(join(projectDir, "sess.jsonl"), "{}\n");
      const sub = join(projectDir, "sess", "subagents");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "agent-1.jsonl"), "t1\n");
      writeFileSync(join(sub, "agent-1.meta.json"), "{}\n");
      writeFileSync(join(sub, "notes.txt"), "some notes\n");
      writeFileSync(join(sub, ".DS_Store"), "binary\n");
      writeFileSync(join(sub, "agent-1.tmp"), "temp data\n");

      const r = await archiveSessions(projectDir, archiveDir);
      expect(r.copied).toBe(3);
      const archivedFiles = readdirSync(join(archiveDir, "sess", "subagents")).sort();
      expect(archivedFiles).toEqual(["agent-1.jsonl", "agent-1.meta.json"]);
    }));

  test("skips dotfiles silently and skips 0-byte top-level session files", () =>
    withTmp(async (dir) => {
      const { projectDir, archiveDir } = setup(dir);
      writeFileSync(join(projectDir, "valid.jsonl"), "session data\n");
      writeFileSync(join(projectDir, ".hidden.jsonl"), "secret\n");
      writeFileSync(join(projectDir, "empty.jsonl"), "");

      const r = await archiveSessions(projectDir, archiveDir);
      expect(r.copied).toBe(1);
      expect(r.warnings).toEqual([]);
      expect(readdirSync(archiveDir)).toEqual(["valid.jsonl"]);
    }));
});

describe("discoverRootSessions live vs archived", () => {
  test("a live session in a later root wins over an archived copy in an earlier root", () =>
    withTmp(async (dir) => {
      const mk = (n: string) => ({ dir: join(dir, n), worktree: n, projectDir: join(dir, "pd", n), archiveDir: join(dir, "ad", n) });
      const a = mk("a");
      const b = mk("b");
      mkdirSync(a.archiveDir, { recursive: true });
      mkdirSync(b.projectDir, { recursive: true });
      writeFileSync(join(a.archiveDir, "s1.jsonl"), "{}\n");
      writeFileSync(join(b.projectDir, "s1.jsonl"), "{}\n");
      mkdirSync(a.projectDir, { recursive: true });
      const r = await discoverRootSessions([a, b]);
      expect(r).toHaveLength(1);
      expect(r[0]?.root).toBe(b.dir);
      expect(r[0]?.archived).toBeUndefined();
    }));

  test("for the same id across roots, the larger copy wins even if the earlier root is archived", () =>
    withTmp(async (dir) => {
      const mk = (n: string) => ({ dir: join(dir, n), worktree: n, projectDir: join(dir, "pd", n), archiveDir: join(dir, "ad", n) });
      const a = mk("a");
      const b = mk("b");
      mkdirSync(a.archiveDir, { recursive: true });
      mkdirSync(b.projectDir, { recursive: true });
      writeFileSync(join(a.archiveDir, "s1.jsonl"), "long-intact-archived-content");
      writeFileSync(join(b.projectDir, "s1.jsonl"), "short");
      const r = await discoverRootSessions([a, b]);
      expect(r).toHaveLength(1);
      expect(r[0]?.root).toBe(a.dir);
      expect(r[0]?.archived).toBe(true);
      expect(r[0]?.path).toBe(join(a.archiveDir, "s1.jsonl"));
    }));
});
