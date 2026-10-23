import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PlayResponse } from "@lgtm/core";
import { startServer, type RunningServer } from "./server.js";

let tmp: string;
let repo: string;
let srv: RunningServer;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: any;
}

function get(s: RunningServer, path: string, token: string | null = s.token, extra: Record<string, string> = {}): Promise<Res> {
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

function write(root: string, rel: string, text: string): void {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}

let n = 0;
const rec = (type: string, cwd: string, extra: Record<string, unknown>): string => {
  n++;
  return JSON.stringify({
    type,
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    sessionId: "play-session",
    timestamp: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.000Z`,
    cwd,
    gitBranch: "main",
    ...extra,
  });
};

function projectDir(root: string, cwd: string): string {
  const d = join(root, "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(d, { recursive: true });
  return d;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-play-test-")));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  write(repo, "src/a.ts", 'import { b } from "./b";\nimport { c } from "./c";\nexport const a = 1;\n');
  write(repo, "src/b.ts", "export const b = 2;\n");
  write(repo, "src/c.ts", "export const c = 3;\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo });

  const root = join(tmp, "p");
  const pDir = projectDir(root, repo);

  // play-session:
  // Prompt 0:
  // Step 1: edit src/a.ts adding import to c
  // Step 2: edit src/b.ts
  // Step 3: Bash pnpm test -> passed
  const lines: string[] = [];
  lines.push(rec("user", repo, { message: { role: "user", content: "Implement feature" } }));
  // Tool 1: Edit a.ts
  lines.push(
    rec("assistant", repo, {
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(repo, "src/a.ts"), old_string: "x", new_string: "y" } }] },
    }),
  );
  lines.push(
    rec("user", repo, {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      toolUseResult: {
        type: "update",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-export const a = 1;", '+import { c } from "./c";', "+export const a = 1;"] }],
      },
    }),
  );
  // Tool 2: Edit b.ts
  lines.push(
    rec("assistant", repo, {
      message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: join(repo, "src/b.ts"), old_string: "x", new_string: "y" } }] },
    }),
  );
  lines.push(
    rec("user", repo, {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
      toolUseResult: {
        type: "update",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-export const b = 2;", "+export const b = 22;"] }],
      },
    }),
  );
  // Tool 2b: Write a scratch note outside the repo (no beat expected)
  lines.push(
    rec("assistant", repo, {
      message: { role: "assistant", content: [{ type: "tool_use", id: "t2b", name: "Write", input: { file_path: join(tmp, "scratch/brief.md"), content: "notes\n" } }] },
    }),
  );
  lines.push(
    rec("user", repo, {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2b", content: "ok" }] },
      toolUseResult: { type: "create", filePath: join(tmp, "scratch/brief.md"), content: "notes\n", structuredPatch: [] },
    }),
  );
  // Tool 3: Bash test
  lines.push(
    rec("assistant", repo, {
      message: { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "pnpm test" } }] },
    }),
  );
  lines.push(
    rec("user", repo, {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "Tests passed" }] },
      toolUseResult: { exitCode: 0, stdout: "Tests passed\n" },
    }),
  );

  writeFileSync(join(pDir, "play-session.jsonl"), lines.join("\n") + "\n");

  // Forked sessions for inheritance test:
  const sharedUuid = "00000000-0000-4000-8000-ffffffff0001";
  const forkALines = [
    JSON.stringify({ type: "user", uuid: sharedUuid, sessionId: "fork-a", timestamp: "2026-01-01T00:00:01.000Z", cwd: repo, gitBranch: "main", message: { role: "user", content: "First" } }),
    JSON.stringify({ type: "assistant", uuid: "00000000-0000-4000-8000-ffffffff0002", sessionId: "fork-a", timestamp: "2026-01-01T00:00:02.000Z", cwd: repo, gitBranch: "main", message: { role: "assistant", content: [{ type: "tool_use", id: "fa1", name: "Edit", input: { file_path: join(repo, "src/b.ts") } }] } }),
    JSON.stringify({ type: "user", uuid: "00000000-0000-4000-8000-ffffffff0003", sessionId: "fork-a", timestamp: "2026-01-01T00:00:03.000Z", cwd: repo, gitBranch: "main", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "fa1", content: "ok" }] }, toolUseResult: { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-b=2", "+b=3"] }] } }),
  ];
  writeFileSync(join(pDir, "fork-a.jsonl"), forkALines.join("\n") + "\n");

  const forkBLines = [
    JSON.stringify({ type: "user", uuid: sharedUuid, sessionId: "fork-b", timestamp: "2026-01-01T00:01:01.000Z", cwd: repo, gitBranch: "main", message: { role: "user", content: "First" } }),
    JSON.stringify({ type: "assistant", uuid: "00000000-0000-4000-8000-ffffffff0004", sessionId: "fork-b", timestamp: "2026-01-01T00:01:02.000Z", cwd: repo, gitBranch: "main", message: { role: "assistant", content: [{ type: "tool_use", id: "fb1", name: "Edit", input: { file_path: join(repo, "src/b.ts") } }] } }),
    JSON.stringify({ type: "user", uuid: "00000000-0000-4000-8000-ffffffff0005", sessionId: "fork-b", timestamp: "2026-01-01T00:01:03.000Z", cwd: repo, gitBranch: "main", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "fb1", content: "ok" }] }, toolUseResult: { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-b=2", "+b=3"] }] } }),
  ];
  writeFileSync(join(pDir, "fork-b.jsonl"), forkBLines.join("\n") + "\n");

  srv = await startServer({ dir: repo, projectsDir: join(root, "projects"), webRoot: join(tmp, "no-web") });
});

afterAll(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/sessions/:id/prompts/:n/play", () => {
  test("requires token: 403 on missing or wrong token", async () => {
    expect((await get(srv, "/api/sessions/play-session/prompts/0/play", null)).status).toBe(403);
    expect((await get(srv, "/api/sessions/play-session/prompts/0/play", "wrong-token")).status).toBe(403);
  });

  test("validates index: 400 on malformed index", async () => {
    expect((await get(srv, "/api/sessions/play-session/prompts/-1/play")).status).toBe(400);
    expect((await get(srv, "/api/sessions/play-session/prompts/x/play")).status).toBe(400);
    expect((await get(srv, "/api/sessions/play-session/prompts/NaN/play")).status).toBe(400);
  });

  test("404 on unknown session or unknown prompt index", async () => {
    expect((await get(srv, "/api/sessions/nope/prompts/0/play")).status).toBe(404);
    expect((await get(srv, "/api/sessions/play-session/prompts/999/play")).status).toBe(404);
  });

  test("404 on inherited prompt (B4)", async () => {
    const r = await get(srv, "/api/sessions/fork-b/prompts/0/play");
    expect(r.status).toBe(404);
  });

  test("200 with PlayResponse: beat sequence order, text templates and focus", async () => {
    const r = await get(srv, "/api/sessions/play-session/prompts/0/play");
    expect(r.status).toBe(200);
    const play = PlayResponse.parse(r.json);
    expect(play.sessionId).toBe("play-session");
    expect(play.prompt).toBe(0);
    expect(play.truncated).toBe(false);

    // Expected beats:
    // 1. file beat src/a.ts (edited)
    // 2. import beat src/a.ts now imports src/c.ts
    // 3. file beat src/b.ts (edited)
    // 4. check beat pnpm test -> passed
    expect(play.beats).toHaveLength(4);

    const b1 = play.beats[0];
    expect(b1.kind).toBe("file-changed");
    expect(b1.text).toBe("Edited a.ts (+2 -1)");
    expect(b1.path).toBe("src/a.ts");
    expect(b1.focus.nodes).toContain("src/a.ts");
    expect(b1.focus.edges).toContainEqual({ from: "src/a.ts", to: "src/c.ts" });

    const b2 = play.beats[1];
    expect(b2.kind).toBe("import-added");
    expect(b2.text).toBe("a.ts now imports c.ts");
    expect(b2.focus.nodes).toEqual(["src/a.ts", "src/c.ts"]);
    expect(b2.focus.edges).toEqual([{ from: "src/a.ts", to: "src/c.ts" }]);

    const b3 = play.beats[2];
    expect(b3.kind).toBe("file-changed");
    expect(b3.text).toBe("Edited b.ts (+1 -1)");
    expect(b3.path).toBe("src/b.ts");
    expect(b3.focus.nodes).toContain("src/b.ts");

    const b4 = play.beats[3];
    expect(b4.kind).toBe("check-passed");
    expect(b4.text).toBe("pnpm test -> passed");
    expect(b4.focus.nodes).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
    expect(b4.focus.edges).toEqual([]);
  });

  test("conditional request: ETag and 304 Not Modified", async () => {
    const a = await get(srv, "/api/sessions/play-session/prompts/0/play");
    expect(a.status).toBe(200);
    const tag = a.headers.etag as string;
    expect(tag).toMatch(/^"[0-9a-f]{16}"$/);

    const b = await get(srv, "/api/sessions/play-session/prompts/0/play", srv.token, { "If-None-Match": tag });
    expect(b.status).toBe(304);

    // Map route shares same cache without collision
    const mapRes = await get(srv, "/api/sessions/play-session/map?prompt=0");
    expect(mapRes.status).toBe(200);
    expect(mapRes.json.playable).toBe(true);
  });
});
