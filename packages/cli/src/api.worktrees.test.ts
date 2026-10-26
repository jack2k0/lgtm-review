import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { projectDirFor, sessionRoots } from "@lgtm/core/node";
import { startServer, type RunningServer } from "./server.js";

let tmp: string;
let repo: string;
let wt: string;
let projects: string;
let srv: RunningServer;
let plainSrv: RunningServer;
let wtFile: string;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: any;
}

function get(s: RunningServer, path: string, extra: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${s.port}`, "X-Lgtm-Token": s.token, ...extra };
    request({ host: "127.0.0.1", port: s.port, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: b ? JSON.parse(b) : null }));
    })
      .on("error", reject)
      .end();
  });
}

function write(root: string, rel: string, text: string): void {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}

const git = (cwd: string, ...args: string[]): void => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });

let n = 0;
function session(sid: string, cwd: string, prompt: string, file: string): string {
  const rec = (type: string, extra: Record<string, unknown>): string => {
    n++;
    return JSON.stringify({
      type,
      uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      sessionId: sid,
      timestamp: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.000Z`,
      cwd,
      gitBranch: "main",
      ...extra,
    });
  };
  const id = `toolu_${sid}`;
  return `${[
    rec("user", { message: { role: "user", content: prompt } }),
    rec("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id, name: "Edit", input: { file_path: join(cwd, file), old_string: "a", new_string: "b" } }] } }),
    rec("user", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "File updated." }] },
      toolUseResult: { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] },
    }),
  ].join("\n")}\n`;
}

function projectDir(cwd: string): string {
  const d = projectDirFor(cwd, projects);
  mkdirSync(d, { recursive: true });
  return d;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-api-wt-")));
  repo = join(tmp, "repo");
  wt = join(tmp, "wt");
  projects = join(tmp, "projects");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  write(repo, "src/main.ts", "export const m = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", wt, "-b", "feature");
  write(wt, "src/only-in-wt.ts", "export const w = 1;\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "wt");

  writeFileSync(join(projectDir(repo), "main-session.jsonl"), session("main-session", repo, "main work", "src/main.ts"));
  wtFile = join(projectDir(wt), "wt-session.jsonl");
  writeFileSync(wtFile, session("wt-session", wt, "worktree work", "src/only-in-wt.ts"));

  const roots = await sessionRoots(repo, projects, null, { worktrees: true });
  srv = await startServer({ dir: repo, projectsDir: projects, roots, webRoot: join(tmp, "no-web") });
  plainSrv = await startServer({ dir: repo, projectsDir: projects, webRoot: join(tmp, "no-web") });
});

afterAll(async () => {
  await srv?.close();
  await plainSrv?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("sessions across worktrees", () => {
  test("list carries worktree labels", async () => {
    const r = await get(srv, "/api/sessions");
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.sessions.map((s: any) => [s.id, s]));
    expect(byId["main-session"].worktree).toBe(".");
    expect(byId["wt-session"].worktree).toBe("../wt");
    expect(r.json.dir).toBe(repo);
  });

  test("detail carries the worktree", async () => {
    const r = await get(srv, "/api/sessions/wt-session");
    expect(r.status).toBe(200);
    expect(r.json.worktree).toBe("../wt");
  });

  test("map scans the worktree's own tree", async () => {
    const r = await get(srv, "/api/sessions/wt-session/map");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).toContain("src/only-in-wt.ts");
    expect(r.json.nodes.some((x: any) => x.path === "src/only-in-wt.ts")).toBe(true);
  });

  test("ETag changes when a worktree session grows; unchanged list answers 304", async () => {
    const first = await get(srv, "/api/sessions");
    const etag = first.headers.etag as string;
    expect((await get(srv, "/api/sessions", { "If-None-Match": etag })).status).toBe(304);
    appendFileSync(wtFile, `${JSON.stringify({ type: "user", uuid: "00000000-0000-4000-8000-ffffffffffff", sessionId: "wt-session", timestamp: "2026-01-01T01:00:00.000Z", cwd: wt, message: { role: "user", content: "more" } })}\n`);
    const after = await get(srv, "/api/sessions", { "If-None-Match": etag });
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
  });

  test("a server without roots lists only --dir's sessions, without worktree", async () => {
    const r = await get(plainSrv, "/api/sessions");
    expect(r.json.sessions.map((s: any) => s.id)).toEqual(["main-session"]);
    expect(r.json.sessions[0].worktree).toBeUndefined();
  });
});

describe("worktree labels and the analysis cache", () => {
  let root: string;
  let repoDir: string;
  let wtDir: string;
  let projectsDir: string;
  let labelSrv: RunningServer;
  let mainFile: string;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-api-label-")));
    repoDir = join(root, "repo");
    wtDir = join(root, "wt");
    projectsDir = join(root, "projects");
    mkdirSync(repoDir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    write(repoDir, "src/main.ts", "export const m = 1;\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", "init");
    git(repoDir, "worktree", "add", "-q", wtDir, "-b", "feature");

    // Only the linked worktree has a session at start-up.
    const wtProjects = projectDirFor(wtDir, projectsDir);
    mkdirSync(wtProjects, { recursive: true });
    writeFileSync(join(wtProjects, "label-wt.jsonl"), session("label-wt", wtDir, "worktree work", "src/main.ts"));
    mainFile = join(projectDirFor(repoDir, projectsDir), "label-main.jsonl");

    const roots = await sessionRoots(wtDir, projectsDir, null, { worktrees: true });
    labelSrv = await startServer({ dir: wtDir, projectsDir, roots, webRoot: join(root, "no-web") });
  });

  afterAll(async () => {
    await labelSrv?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a label change refreshes cached analyses and summaries", async () => {
    // One contributing root: no label yet. These responses prime the cache.
    const before = await get(labelSrv, "/api/sessions");
    expect(before.status).toBe(200);
    expect(before.json.sessions).toHaveLength(1);
    expect(before.json.sessions[0]).toMatchObject({ id: "label-wt" });
    expect(before.json.sessions[0].worktree).toBeUndefined();
    const beforeDetail = await get(labelSrv, "/api/sessions/label-wt");
    expect(beforeDetail.status).toBe(200);
    expect(beforeDetail.json.worktree).toBeUndefined();

    // A session in the main checkout makes the linked worktree a second root.
    mkdirSync(dirname(mainFile), { recursive: true });
    writeFileSync(mainFile, session("label-main", repoDir, "main work", "src/main.ts"));

    const after = await get(labelSrv, "/api/sessions");
    expect(after.status).toBe(200);
    const byId = Object.fromEntries(after.json.sessions.map((x: any) => [x.id, x]));
    expect(byId["label-main"].worktree).toBe(".");
    expect(byId["label-wt"].worktree).toBe("../wt");
    const afterDetail = await get(labelSrv, "/api/sessions/label-wt");
    expect(afterDetail.status).toBe(200);
    expect(afterDetail.json.worktree).toBe("../wt");

    // Removing the main session drops the label again; the cached analysis must drop it too.
    rmSync(mainFile);
    const removed = await get(labelSrv, "/api/sessions");
    expect(removed.status).toBe(200);
    expect(removed.json.sessions).toHaveLength(1);
    expect(removed.json.sessions[0].worktree).toBeUndefined();
    expect("worktree" in removed.json.sessions[0]).toBe(false);
    const removedDetail = await get(labelSrv, "/api/sessions/label-wt");
    expect(removedDetail.status).toBe(200);
    expect(removedDetail.json.worktree).toBeUndefined();
    expect("worktree" in removedDetail.json).toBe(false);
  });
});
