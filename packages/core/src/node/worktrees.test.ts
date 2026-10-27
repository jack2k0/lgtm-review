import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverRootSessions, projectDirFor, type SessionRoot } from "./discover.js";
import { listWorktrees, parseWorktreeList, sessionRoots } from "./worktrees.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-wt-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const rec = (...lines: string[]) => lines.join("\0") + "\0\0";

describe("parseWorktreeList", () => {
  it("parses main and linked worktrees", () => {
    const out =
      rec("worktree /r/main", "HEAD aaa", "branch refs/heads/main") +
      rec("worktree /r/wt", "HEAD bbb", "branch refs/heads/feature/x") +
      rec("worktree /r/det", "HEAD ccc", "detached");
    expect(parseWorktreeList(out)).toEqual({
      main: "/r/main",
      worktrees: [
        { path: "/r/main", branch: "main" },
        { path: "/r/wt", branch: "feature/x" },
        { path: "/r/det", branch: null },
      ],
    });
  });
  it("excludes bare and prunable records", () => {
    const out =
      rec("worktree /r/bare", "bare") +
      rec("worktree /r/wt", "HEAD b", "branch refs/heads/f") +
      rec("worktree /r/gone", "HEAD c", "detached", "prunable gitdir file points to non-existent location");
    expect(parseWorktreeList(out)).toEqual({ main: "/r/bare", worktrees: [{ path: "/r/wt", branch: "f" }] });
  });
  it("handles empty input and trailing NULs", () => {
    expect(parseWorktreeList("")).toEqual({ main: null, worktrees: [] });
    expect(parseWorktreeList(rec("worktree /a", "detached") + "\0\0")).toEqual({
      main: "/a",
      worktrees: [{ path: "/a", branch: null }],
    });
  });
});

describe("sessionRoots", () => {
  const main = "/r/main";
  const wt = "/r/wt";
  const both = async () => ({
    main,
    worktrees: [
      { path: main, branch: "main" },
      { path: wt, branch: "f" },
    ],
  });
  const pd = "/p";
  it("lists --dir first, then the others", async () => {
    const a = await sessionRoots(main, pd, null, { worktrees: true }, both);
    expect(a.map((r) => [r.dir, r.worktree])).toEqual([[main, "."], [wt, "../wt"]]);
    const b = await sessionRoots(wt, pd, null, { worktrees: true }, both);
    expect(b.map((r) => [r.dir, r.worktree])).toEqual([[wt, "../wt"], [main, "."]]);
    expect(a[0]?.archiveDir).toBeNull();
    expect(a[0]?.projectDir).toBe("/p/-r-main");
  });
  it("labels a subfolder of main as main and does not repeat main", async () => {
    const sub = join(tmp, "x");
    const list = async () => ({
      main: tmp,
      worktrees: [
        { path: tmp, branch: "main" },
        { path: "/elsewhere/wt", branch: null },
      ],
    });
    mkdirSync(sub, { recursive: true });
    const r = await sessionRoots(sub, pd, "/arch", { worktrees: true }, list);
    expect(r.map((x) => [x.dir, x.worktree])).toEqual([[sub, "."], ["/elsewhere/wt", "../../elsewhere/wt"]]);
    expect(r[0]?.archiveDir).toBe("/arch/" + r[0]?.projectDir.split("/").pop());
  });
  it("falls back to a single root", async () => {
    for (const [o, l] of [
      [{ worktrees: false }, both],
      [{ worktrees: true }, async () => null],
      [{ worktrees: true }, async () => ({ main, worktrees: [{ path: main, branch: "m" }] })],
    ] as const) {
      const r = await sessionRoots(wt, pd, null, o, l);
      expect(r.map((x) => [x.dir, x.worktree])).toEqual([[wt, "."]]);
    }
  });
  it("labels nested worktrees", async () => {
    const nested = `${main}/.claude/worktrees/x`;
    const r = await sessionRoots(main, pd, null, { worktrees: true }, async () => ({
      main,
      worktrees: [{ path: main, branch: null }, { path: nested, branch: null }],
    }));
    expect(r[1]?.worktree).toBe(".claude/worktrees/x");
  });
  it("derives roots[0] project dir from realpath of symlinked repo dir", async () => {
    const realRepo = join(tmp, "real-symlink-repo");
    const symlinkRepo = join(tmp, "symlink-to-repo");
    mkdirSync(realRepo, { recursive: true });
    symlinkSync(realRepo, symlinkRepo);
    const r = await sessionRoots(symlinkRepo, pd, null, { worktrees: false });
    expect(r).toHaveLength(1);
    expect(r[0]?.dir).toBe(symlinkRepo);
    expect(r[0]?.projectDir).toBe(projectDirFor(realRepo, pd));
    expect(r[0]?.projectDir).not.toBe(projectDirFor(symlinkRepo, pd));
  });
});

describe("listWorktrees (real git)", () => {
  it("lists main and a linked worktree; null for non-repo or missing dirs", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(repo, "a"), "a");
    git("add", ".");
    git("commit", "-q", "-m", "i");
    git("worktree", "add", "-q", "../wt", "-b", "feature");
    const res = await listWorktrees(repo);
    expect(res?.main).toBe(repo);
    expect(res?.worktrees.map((w) => w.path)).toEqual([repo, join(tmp, "wt")]);
    expect(res?.worktrees[1]?.branch).toBe("feature");
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(await listWorktrees(plain)).toBeNull();
    expect(await listWorktrees(join(tmp, "missing"))).toBeNull();
  });
});

describe("discoverRootSessions", () => {
  const mkRoot = (name: string, worktree: string, withArchive = false): SessionRoot => ({
    dir: join(tmp, name),
    worktree,
    projectDir: join(tmp, "pd", name),
    archiveDir: withArchive ? join(tmp, "ad", name) : null,
  });
  const put = (dir: string, id: string, mtime: number) => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, "{}\n");
    utimesSync(p, mtime, mtime);
  };

  it("merges roots newest first with labels and drops duplicate ids", async () => {
    const a = mkRoot("a", ".");
    const b = mkRoot("b", "../b");
    put(a.projectDir, "s1", 1000);
    put(b.projectDir, "s2", 2000);
    put(b.projectDir, "s1", 3000);
    const r = await discoverRootSessions([a, b]);
    expect(r.map((f) => [f.id, f.root, f.worktree])).toEqual([
      ["s2", b.dir, "../b"],
      ["s1", a.dir, "."],
    ]);
  });
  it("omits labels when only one root contributes; skips missing dirs; empty when all missing", async () => {
    const a = mkRoot("a2", ".");
    const b = mkRoot("b2", "../b2");
    put(a.projectDir, "only", 1000);
    const r = await discoverRootSessions([a, b]);
    expect(r).toHaveLength(1);
    expect(r[0]?.root).toBe(a.dir);
    expect("worktree" in (r[0] as object)).toBe(false);
    expect(await discoverRootSessions([mkRoot("n1", "."), mkRoot("n2", "../n2")])).toEqual([]);
  });
  it("includes archived-only sessions of a later root", async () => {
    const a = mkRoot("a3", ".", true);
    const b = mkRoot("b3", "../b3", true);
    put(a.projectDir, "live", 1000);
    put(b.archiveDir as string, "arch", 2000);
    const r = await discoverRootSessions([a, b]);
    const arch = r.find((f) => f.id === "arch");
    expect(arch).toMatchObject({ archived: true, worktree: "../b3", root: b.dir });
  });
});
