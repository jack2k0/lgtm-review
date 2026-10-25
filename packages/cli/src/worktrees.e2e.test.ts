import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { projectDirFor } from "@lgtm/core/node";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");
const fixtures = join(here, "../../core/fixtures/sessions");

let tmp: string;
let repo: string;
let wt: string;
let plain: string;
let projects: string;
let wtId: string;
let mainId: string;

function run(args: string[]) {
  return spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}
function git(cwd: string, args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function put(dir: string, prefix: string, fixture: string, cwd: string): string {
  mkdirSync(dir, { recursive: true });
  const id = `${prefix}-${fixture}`;
  const text = readFileSync(join(fixtures, `${fixture}.jsonl`), "utf8").replaceAll('"uuid":"', `"uuid":"${prefix}-`).replaceAll("/home/user/project", cwd);
  writeFileSync(join(dir, `${id}.jsonl`), text);
  return id;
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-wt-e2e-")));
  repo = join(tmp, "repo");
  wt = join(tmp, "wt");
  plain = join(tmp, "plain");
  projects = join(tmp, "projects");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["worktree", "add", "-q", wt, "-b", "feature"]);
  mkdirSync(plain);
  mainId = put(projectDirFor(repo, projects), "aaaa1111", "checked-basic", repo);
  wtId = put(projectDirFor(wt, projects), "bbbb2222", "failing-check", wt);
  put(projectDirFor(plain, projects), "cccc3333", "checked-basic", plain);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function sessions(args: string[]): { sessionId: string; worktree?: string }[] {
  const r = run(["--list", "--json", "--projects-dir", projects, ...args]);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout).sessions;
}

describe("worktree sessions (CLI)", () => {
  test("--dir main lists both worktrees", () => {
    const s = sessions(["--dir", repo]);
    expect(s.map((x) => [x.sessionId, x.worktree]).sort()).toEqual([[mainId, "."], [wtId, "../wt"]].sort());
  });

  test("--dir linked worktree lists both worktrees", () => {
    const s = sessions(["--dir", wt]);
    expect(s.map((x) => [x.sessionId, x.worktree]).sort()).toEqual([[mainId, "."], [wtId, "../wt"]].sort());
  });

  test("--no-worktrees: one session, no worktree key", () => {
    const r = run(["--list", "--json", "--projects-dir", projects, "--dir", repo, "--no-worktrees"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).sessions).toHaveLength(1);
    expect(r.stdout).not.toContain('"worktree"');
  });

  test("--list text marks the worktree session once", () => {
    const r = run(["--list", "--projects-dir", projects, "--dir", repo]);
    expect(r.status).toBe(0);
    expect(r.stdout.split("[worktree ../wt]")).toHaveLength(2);
  });

  test("--summary and --export work for a worktree session", () => {
    const s = run(["--summary", "--session", wtId.slice(0, 12), "--projects-dir", projects, "--dir", repo]);
    expect(s.status).toBe(0);
    const out = join(tmp, "x.html");
    const e = run(["--export", wtId.slice(0, 12), "--out", out, "--projects-dir", projects, "--dir", repo]);
    expect(e.status).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("&lt;repo&gt;");
    expect(html).not.toContain(wt);
  });

  test("--archive archives every worktree", () => {
    const arch = join(tmp, "arch");
    const r = run(["--archive", "--archive-dir", arch, "--projects-dir", projects, "--dir", repo]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(2);
    expect(r.stdout).toContain("[worktree .]");
    expect(existsSync(join(arch, projectDirFor(repo, projects).split("/").pop()!))).toBe(true);
    expect(existsSync(join(arch, projectDirFor(wt, projects).split("/").pop()!))).toBe(true);
  });

  test("non-repository dir behaves as before", () => {
    const s = sessions(["--dir", plain]);
    expect(s).toHaveLength(1);
    expect(s[0]).not.toHaveProperty("worktree");
  });
});
