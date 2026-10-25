import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GitCrosscheckResponse } from "@lgtm/core";
import { projectDirFor } from "@lgtm/core/node";
import { startServer, type RunningServer } from "./server.js";

let tmp: string;
let repo: string;
let plain: string;
let projectsDir: string;
let webRoot: string;
let srv: RunningServer;
let noGitSrv: RunningServer;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: any;
}

function get(
  s: RunningServer,
  path: string,
  token: string | null = s.token,
  extra: Record<string, string> = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${s.port}`, ...extra };
    if (token !== null) headers["X-Lgtm-Token"] = token;
    request({ host: "127.0.0.1", port: s.port, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: b ? JSON.parse(b) : null }));
    })
      .on("error", reject)
      .end();
  });
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-api-git-test-")));
  repo = join(tmp, "repo");
  plain = join(tmp, "plain");
  projectsDir = join(tmp, "projects");
  webRoot = join(tmp, "no-web");
  mkdirSync(repo);
  mkdirSync(plain);
  mkdirSync(projectsDir);
  mkdirSync(webRoot);

  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], {
      stdio: "ignore",
    });

  // 1. Setup git repo like phase-1 integration test
  git("init", "-q", "-b", "main");

  // Commit a.txt and d.txt dated 2026-01-01T08:00:00Z
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

  // Commit b.txt dated 2026-01-01T10:05:00Z
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

  // Working tree changes: modify a.txt, create untracked c.txt, git mv d.txt e.txt
  writeFileSync(join(repo, "a.txt"), "a 2");
  writeFileSync(join(repo, "c.txt"), "c 1");
  git("mv", "d.txt", "e.txt");

  // 2. Setup session in projectsDir
  const pdir = projectDirFor(repo, projectsDir);
  mkdirSync(pdir, { recursive: true });

  const sessionFile = join(pdir, "git-session.jsonl");
  const records = [
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000001",
      sessionId: "git-session",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: repo,
      gitBranch: "main",
      version: "2.1.0",
      message: { role: "user", content: "Edit a and x" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000002",
      parentUuid: "00000000-0000-4000-8000-000000000001",
      sessionId: "git-session",
      timestamp: "2026-01-01T10:00:01.000Z",
      cwd: repo,
      gitBranch: "main",
      version: "2.1.0",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Editing a.txt." },
          {
            type: "tool_use",
            id: "toolu_01",
            name: "Edit",
            input: { file_path: join(repo, "a.txt"), old_string: "a 1", new_string: "a 2" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000003",
      parentUuid: "00000000-0000-4000-8000-000000000002",
      sessionId: "git-session",
      timestamp: "2026-01-01T10:00:02.000Z",
      cwd: repo,
      gitBranch: "main",
      version: "2.1.0",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "File updated." }],
      },
      toolUseResult: {
        type: "update",
        filePath: join(repo, "a.txt"),
        oldString: "a 1",
        newString: "a 2",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a 1", "+a 2"] }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000004",
      parentUuid: "00000000-0000-4000-8000-000000000003",
      sessionId: "git-session",
      timestamp: "2026-01-01T10:00:03.000Z",
      cwd: repo,
      gitBranch: "main",
      version: "2.1.0",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Editing x.txt." },
          {
            type: "tool_use",
            id: "toolu_02",
            name: "Edit",
            input: { file_path: join(repo, "x.txt"), old_string: "x 1", new_string: "x 2" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000005",
      parentUuid: "00000000-0000-4000-8000-000000000004",
      sessionId: "git-session",
      timestamp: "2026-01-01T10:00:04.000Z",
      cwd: repo,
      gitBranch: "main",
      version: "2.1.0",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_02", content: "File updated." }],
      },
      toolUseResult: {
        type: "update",
        filePath: join(repo, "x.txt"),
        oldString: "x 1",
        newString: "x 2",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x 1", "+x 2"] }],
      },
    }),
  ];
  writeFileSync(sessionFile, records.join("\n") + "\n");
  const mtimeSec = Date.parse("2026-01-01T11:00:00Z") / 1000;
  utimesSync(sessionFile, mtimeSec, mtimeSec);

  srv = await startServer({ dir: repo, projectsDir, webRoot });

  // 3. Setup non-repo session
  const plainPdir = projectDirFor(plain, projectsDir);
  mkdirSync(plainPdir, { recursive: true });
  const plainSessionFile = join(plainPdir, "plain-session.jsonl");
  writeFileSync(
    plainSessionFile,
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000001",
      sessionId: "plain-session",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: plain,
      version: "2.1.0",
      message: { role: "user", content: "hello" },
    }) + "\n",
  );
  noGitSrv = await startServer({ dir: plain, projectsDir, webRoot });
});

afterAll(async () => {
  await srv?.close();
  await noGitSrv?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/sessions/:id/git", () => {
  test("returns 200 with GitCrosscheckResponse for valid git session", async () => {
    const res = await get(srv, "/api/sessions/git-session/git");
    expect(res.status).toBe(200);

    const parsed = GitCrosscheckResponse.safeParse(res.json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.available).toBe(true);
    expect(parsed.data.ref).toBe("main");
    expect(parsed.data.notInGit).toEqual(["x.txt"]);
    expect(parsed.data.uncommitted).toContainEqual({ path: "a.txt", status: "M", inLog: true });
    expect(parsed.data.uncommitted).toContainEqual({ path: "c.txt", status: "??", inLog: false });
  });

  test("returns 304 when If-None-Match matches ETag", async () => {
    const first = await get(srv, "/api/sessions/git-session/git");
    expect(first.status).toBe(200);
    const etag = first.headers.etag;
    expect(typeof etag).toBe("string");

    const second = await get(srv, "/api/sessions/git-session/git", srv.token, {
      "If-None-Match": etag as string,
    });
    expect(second.status).toBe(304);
  });

  test("returns 404 for unknown session id", async () => {
    const res = await get(srv, "/api/sessions/nope/git");
    expect(res.status).toBe(404);
  });

  test("returns 404 for subpath after /git", async () => {
    const res = await get(srv, "/api/sessions/git-session/git/x");
    expect(res.status).toBe(404);
  });

  test("returns 403 when token is missing or invalid", async () => {
    const noToken = await get(srv, "/api/sessions/git-session/git", null);
    expect(noToken.status).toBe(403);

    const wrongToken = await get(srv, "/api/sessions/git-session/git", "wrong-token");
    expect(wrongToken.status).toBe(403);
  });

  test("returns 200 with available: false when cwd is not a git repository", async () => {
    const res = await get(noGitSrv, "/api/sessions/plain-session/git");
    expect(res.status).toBe(200);

    const parsed = GitCrosscheckResponse.safeParse(res.json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.available).toBe(false);
    expect(parsed.data.uncommitted).toEqual([]);
    expect(parsed.data.committed).toEqual([]);
    expect(parsed.data.notInGit).toEqual([]);
  });
});
