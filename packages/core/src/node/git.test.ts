import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  gitCrosscheck,
  parseLogNameStatus,
  parseStatusZ,
  runGit,
  type GitCrosscheckInput,
  type RunGit,
} from "./git.js";

describe("parseStatusZ", () => {
  it("parses porcelain v1 -z output including renames and untracked", () => {
    const raw = " M a.txt\0?? c.txt\0R  e.txt\0d.txt\0A  new.ts\0";
    expect(parseStatusZ(raw)).toEqual([
      { path: "a.txt", status: "M" },
      { path: "c.txt", status: "??" },
      { path: "e.txt", status: "R" },
      { path: "new.ts", status: "A" },
    ]);
  });

  it("handles empty string", () => {
    expect(parseStatusZ("")).toEqual([]);
  });

  it("keeps paths with spaces whole", () => {
    const raw = " M path with/spaces.txt\0";
    expect(parseStatusZ(raw)).toEqual([
      { path: "path with/spaces.txt", status: "M" },
    ]);
  });
});

describe("parseLogNameStatus", () => {
  it("handles empty string", () => {
    expect(parseLogNameStatus("")).toEqual({ commits: 0, files: [] });
  });

  it("parses plain entries and newest commit wins for duplicates", () => {
    const raw =
      "\x01h2\0\nM\0src/a.ts\0A\0src/b.ts\0\x01h1\0\nA\0src/a.ts\0D\0gone.ts\0";
    expect(parseLogNameStatus(raw)).toEqual({
      commits: 2,
      files: [
        { path: "src/a.ts", status: "M" },
        { path: "src/b.ts", status: "A" },
        { path: "gone.ts", status: "D" },
      ],
    });
  });

  it("parses rename entries taking the new path", () => {
    const raw = "\x01h1\0\nR100\0old.ts\0new.ts\0";
    expect(parseLogNameStatus(raw)).toEqual({
      commits: 1,
      files: [{ path: "new.ts", status: "R" }],
    });
  });

  it("parses paths containing tabs without corruption", () => {
    const raw = "\x01h1\0\nM\0src/path\twith\ttab/file.ts\0";
    expect(parseLogNameStatus(raw)).toEqual({
      commits: 1,
      files: [{ path: "src/path\twith\ttab/file.ts", status: "M" }],
    });
  });

  it("parses paths containing quotes, backslashes, and newlines unquoted", () => {
    const raw = '\x01h1\0\nA\0src/"quoted"\\path\nwith\nnewlines.ts\0';
    expect(parseLogNameStatus(raw)).toEqual({
      commits: 1,
      files: [
        {
          path: 'src/"quoted"\\path\nwith\nnewlines.ts',
          status: "A",
        },
      ],
    });
  });
});

describe("runGit", () => {
  it("returns null for a missing directory", async () => {
    const missing = join(tmpdir(), `missing-git-${Date.now()}-${Math.random()}`);
    const res = await runGit(missing, ["status"]);
    expect(res).toBeNull();
  });
});

describe("gitCrosscheck (mocked run)", () => {
  it("returns available: false when not a repository", async () => {
    const fakeRun: RunGit = async () => null;
    const res = await gitCrosscheck(
      {
        dir: "/not-a-repo",
        branch: "main",
        startedAt: "2026-01-01T10:00:00Z",
        endedAtMs: 1700000000000,
        sessionFiles: ["/not-a-repo/a.ts"],
      },
      fakeRun,
    );
    expect(res).toEqual({
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
    });
  });

  it("falls back to ref: HEAD when branch is unknown or missing", async () => {
    const fakeRun: RunGit = async (_dir, args) => {
      const cmd = args[0] === "-c" ? args[2] : args[0];
      if (cmd === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (cmd === "status") return "";
      if (cmd === "check-ref-format") return null;
      if (cmd === "log") return "";
      return null;
    };

    const resUnknown = await gitCrosscheck(
      {
        dir: "/repo",
        branch: "feature-missing",
        startedAt: "2026-01-01T10:00:00Z",
        endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
        sessionFiles: [],
      },
      fakeRun,
    );
    expect(resUnknown.ref).toBe("HEAD");
    expect(resUnknown.notes).toContain(
      'Branch "feature-missing" was not found; commits of HEAD were read.',
    );

    const resNoBranch = await gitCrosscheck(
      {
        dir: "/repo",
        branch: "unknown",
        startedAt: "2026-01-01T10:00:00Z",
        endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
        sessionFiles: [],
      },
      fakeRun,
    );
    expect(resNoBranch.ref).toBe("HEAD");
    expect(resNoBranch.notes).toContain(
      "The log names no branch; commits of HEAD were read.",
    );
  });

  it("skips log when startedAt is null", async () => {
    let logCalled = false;
    const fakeRun: RunGit = async (_dir, args) => {
      const cmd = args[0] === "-c" ? args[2] : args[0];
      if (cmd === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (cmd === "status") return " M file.ts\0";
      if (cmd === "log") {
        logCalled = true;
        return "";
      }
      return null;
    };

    const res = await gitCrosscheck(
      {
        dir: "/repo",
        branch: "main",
        startedAt: null,
        endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
        sessionFiles: ["/repo/file.ts"],
      },
      fakeRun,
    );

    expect(logCalled).toBe(false);
    expect(res.committed).toEqual([]);
    expect(res.commitCount).toBe(0);
    expect(res.since).toBeNull();
    expect(res.until).toBeNull();
    expect(res.ref).toBeNull();
    expect(res.notes).toContain(
      "The session start is unknown, so commits were not read.",
    );
  });

  it("ignores non-absolute paths like (shell edit) and counts outsideRepo", async () => {
    const fakeRun: RunGit = async (_dir, args) => {
      const cmd = args[0] === "-c" ? args[2] : args[0];
      if (cmd === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (cmd === "status") return "";
      if (cmd === "check-ref-format") return "";
      if (cmd === "rev-parse") return "abc\n";
      if (cmd === "log") return "";
      return null;
    };

    const res = await gitCrosscheck(
      {
        dir: "/repo",
        branch: "main",
        startedAt: "2026-01-01T10:00:00Z",
        endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
        sessionFiles: [
          "(shell edit)",
          "/elsewhere/x.ts",
          "/repo/in-repo.ts",
        ],
      },
      fakeRun,
    );

    expect(res.outsideRepo).toBe(1);
    expect(res.notInGit).toEqual(["in-repo.ts"]);
  });

  it("flags truncated when log reaches GIT_COMMITS_MAX", async () => {
    const fakeRun: RunGit = async (_dir, args) => {
      const cmd = args[0] === "-c" ? args[2] : args[0];
      if (cmd === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (cmd === "status") return "";
      if (cmd === "check-ref-format") return "";
      if (cmd === "rev-parse") return "abc\n";
      if (cmd === "log") {
        let commits = "";
        for (let i = 0; i < 500; i++) {
          commits += `\x01commit${i}\0`;
        }
        return commits;
      }
      return null;
    };

    const res = await gitCrosscheck(
      {
        dir: "/repo",
        branch: "main",
        startedAt: "2026-01-01T10:00:00Z",
        endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
        sessionFiles: [],
      },
      fakeRun,
    );

    expect(res.commitCount).toBe(500);
    expect(res.truncated).toBe(true);
  });
});

describe("gitCrosscheck (real git integration)", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-git-")));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("computes crosscheck against real git repository", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], {
        stdio: "ignore",
      });

    // 1. git init -q -b main
    git("init", "-q", "-b", "main");

    // 2. Commit a.txt and d.txt dated 2026-01-01T08:00:00Z
    writeFileSync(join(repo, "a.txt"), "a 1");
    writeFileSync(join(repo, "d.txt"), "d 1");
    git("add", ".");
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, "commit", "-q", "-m", "first"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-01-01T08:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T08:00:00Z",
        },
        stdio: "ignore",
      },
    );

    // 3. Commit b.txt dated 2026-01-01T10:05:00Z
    writeFileSync(join(repo, "b.txt"), "b 1");
    git("add", "b.txt");
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, "commit", "-q", "-m", "second"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-01-01T10:05:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T10:05:00Z",
        },
        stdio: "ignore",
      },
    );

    // 4. Working tree changes: modify a.txt, create untracked c.txt, git mv d.txt e.txt
    writeFileSync(join(repo, "a.txt"), "a 2");
    writeFileSync(join(repo, "c.txt"), "c 1");
    git("mv", "d.txt", "e.txt");

    // 5. Input
    const input: GitCrosscheckInput = {
      dir: repo,
      branch: "main",
      startedAt: "2026-01-01T10:00:00Z",
      endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
      sessionFiles: [
        join(repo, "a.txt"),
        join(repo, "b.txt"),
        join(repo, "x.txt"),
        "/elsewhere/y.txt",
      ],
    };

    const res = await gitCrosscheck(input);

    expect(res.available).toBe(true);
    expect(res.ref).toBe("main");
    expect(res.commitCount).toBe(1);
    expect(res.committed).toEqual([{ path: "b.txt", status: "A", inLog: true }]);
    expect(res.uncommitted).toEqual([
      { path: "a.txt", status: "M", inLog: true },
      { path: "c.txt", status: "??", inLog: false },
      { path: "e.txt", status: "R", inLog: false },
    ]);
    expect(res.notInGit).toEqual(["x.txt"]);
    expect(res.outsideRepo).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it("detects a committed file with a tab in its filename", async () => {
    const tabRepo = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-git-tab-")));
    try {
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", tabRepo, "init", "-q", "-b", "main"],
        { stdio: "ignore" },
      );
      const tabFile = "tab\tfile.txt";
      writeFileSync(join(tabRepo, tabFile), "tab content");
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", tabRepo, "add", "."],
        { stdio: "ignore" },
      );
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", tabRepo, "commit", "-q", "-m", "add tab file"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2026-01-01T10:05:00Z",
            GIT_COMMITTER_DATE: "2026-01-01T10:05:00Z",
          },
          stdio: "ignore",
        },
      );

      const res = await gitCrosscheck({
        dir: tabRepo,
        branch: "main",
        startedAt: "2026-01-01T10:00:00Z",
        endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
        sessionFiles: [join(tabRepo, tabFile)],
      });

      expect(res.available).toBe(true);
      expect(res.committed).toEqual([{ path: tabFile, status: "A", inLog: true }]);
      expect(res.outsideRepo).toBe(0);
    } finally {
      rmSync(tabRepo, { recursive: true, force: true });
    }
  });

  it("handles dir being a symlink to the repository", async () => {
    const realRepo = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-real-repo-")));
    const symDir = mkdtempSync(join(tmpdir(), "lgtm-sym-root-"));
    const symRepo = join(symDir, "sym-repo");
    symlinkSync(realRepo, symRepo);

    try {
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", realRepo, "init", "-q", "-b", "main"],
        { stdio: "ignore" },
      );
      writeFileSync(join(realRepo, "app.ts"), "export const x = 1;");
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", realRepo, "add", "."],
        { stdio: "ignore" },
      );
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", realRepo, "commit", "-q", "-m", "init"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2026-01-01T10:05:00Z",
            GIT_COMMITTER_DATE: "2026-01-01T10:05:00Z",
          },
          stdio: "ignore",
        },
      );

      const res = await gitCrosscheck({
        dir: symRepo,
        branch: "main",
        startedAt: "2026-01-01T10:00:00Z",
        endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
        sessionFiles: [join(symRepo, "app.ts")],
      });

      expect(res.available).toBe(true);
      expect(res.committed).toEqual([{ path: "app.ts", status: "A", inLog: true }]);
      expect(res.outsideRepo).toBe(0);
    } finally {
      rmSync(realRepo, { recursive: true, force: true });
      rmSync(symDir, { recursive: true, force: true });
    }
  });

  it("handles dir being a symlink to a subdirectory", async () => {
    const realRepo = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-real-sub-")));
    const realSub = join(realRepo, "pkg");
    mkdirSync(realSub);

    const symDir = mkdtempSync(join(tmpdir(), "lgtm-sym-subroot-"));
    const symSub = join(symDir, "pkg");
    symlinkSync(realSub, symSub);

    try {
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", realRepo, "init", "-q", "-b", "main"],
        { stdio: "ignore" },
      );
      writeFileSync(join(realSub, "subfile.ts"), "export const sub = true;");
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", realRepo, "add", "."],
        { stdio: "ignore" },
      );
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-C", realRepo, "commit", "-q", "-m", "sub commit"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2026-01-01T10:05:00Z",
            GIT_COMMITTER_DATE: "2026-01-01T10:05:00Z",
          },
          stdio: "ignore",
        },
      );

      const res = await gitCrosscheck({
        dir: symSub,
        branch: "main",
        startedAt: "2026-01-01T10:00:00Z",
        endedAtMs: Date.parse("2026-01-01T11:00:00Z"),
        sessionFiles: [join(symSub, "subfile.ts")],
      });

      expect(res.available).toBe(true);
      expect(res.committed).toEqual([{ path: "pkg/subfile.ts", status: "A", inLog: true }]);
      expect(res.outsideRepo).toBe(0);
    } finally {
      rmSync(realRepo, { recursive: true, force: true });
      rmSync(symDir, { recursive: true, force: true });
    }
  });
});
