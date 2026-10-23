import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { archiveDirFor, projectDirFor } from "@lgtm/core/node";
import { startServer, type RunningServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");
const fixtures = join(here, "../../core/fixtures/sessions");
const PROJECT = "/home/user/myproject";

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

function get(s: RunningServer, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; json: any }> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = {
      Host: `127.0.0.1:${s.port}`,
      "X-Lgtm-Token": s.token,
      ...headers,
    };
    request({ host: "127.0.0.1", port: s.port, path, headers: reqHeaders }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: b ? JSON.parse(b) : null }));
    })
      .on("error", reject)
      .end();
  });
}

describe("CLI flag validation for archive", () => {
  test("empty --archive-dir errors with exit 1", () => {
    const r = run(["--archive-dir", ""]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("lgtm-review: --archive-dir needs a directory path");
  });

  test.each([
    ["--list"],
    ["--json"],
    ["--summary"],
    ["--export", "abc"],
    ["--session", "abc"],
    ["--out", "file.html"],
    ["--force"],
    ["--no-diffs"],
    ["--no-titles"],
    ["--port", "8080"],
    ["--no-open"],
  ])("--archive cannot be combined with %s (exit 1)", (...flag) => {
    const r = run(["--archive", ...flag]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("lgtm-review: --archive cannot be combined with");
  });
});

describe("E2E archive mirroring and reader integration", () => {
  test("mirrors sessions and subagents, readers see archived copies after live is deleted, ETags change", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lgtm-archive-e2e-"));
    try {
      const projectsDir = join(tmp, "projects");
      const archiveRoot = join(tmp, "archive");
      const projectDir = projectDirFor(PROJECT, projectsDir);
      const archiveDir = archiveDirFor(projectDir, archiveRoot);
      mkdirSync(projectDir, { recursive: true });

      // 1. Setup a normal session and a session with subagents
      const s1Path = join(projectDir, "s1111111-normal.jsonl");
      writeFileSync(
        s1Path,
        JSON.stringify({ type: "user", message: { role: "user", content: "hello world" } }) + "\n",
      );

      const sSubDir = join(projectDir, "s2222222-sub", "subagents");
      mkdirSync(sSubDir, { recursive: true });
      const sSubPath = join(projectDir, "s2222222-sub.jsonl");
      writeFileSync(
        sSubPath,
        JSON.stringify({ type: "user", message: { role: "user", content: "call agent" } }) +
          "\n" +
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "toolu_e2e_1", name: "Agent", input: { prompt: "sub task" } }],
            },
          }) +
          "\n",
      );
      writeFileSync(
        join(sSubDir, "agent-sub1.jsonl"),
        JSON.stringify({ type: "user", message: { role: "user", content: "subagent inner work" } }) + "\n",
      );
      writeFileSync(
        join(sSubDir, "agent-sub1.meta.json"),
        JSON.stringify({ toolUseId: "toolu_e2e_1", description: "subagent description" }),
      );

      // Start a server while live files exist
      const srv = await startServer({
        dir: PROJECT,
        projectsDir,
        archiveDir,
        webRoot: join(tmp, "no-web"),
      });

      try {
        // Initial list fetch over API
        const initialRes = await get(srv, "/api/sessions");
        expect(initialRes.status).toBe(200);
        expect(initialRes.json.sessions).toHaveLength(2);
        expect(initialRes.json.sessions.every((s: any) => !s.archived)).toBe(true);
        const liveEtag = initialRes.headers.etag as string;
        expect(liveEtag).toBeTruthy();

        // Check conditional 304 while live files are unchanged
        const cond304 = await get(srv, "/api/sessions", { "if-none-match": liveEtag });
        expect(cond304.status).toBe(304);

        // 2. Run --archive
        const archRun = run([
          "--archive",
          "--dir",
          PROJECT,
          "--projects-dir",
          projectsDir,
          "--archive-dir",
          archiveRoot,
        ]);
        expect(archRun.status).toBe(0);
        expect(archRun.stdout).toContain("archived 4 new or updated, 0 unchanged");
        expect(archRun.stdout).toContain(`-> ${archiveDir}`);

        // Verify files exist in archiveDir
        expect(existsSync(join(archiveDir, "s1111111-normal.jsonl"))).toBe(true);
        expect(existsSync(join(archiveDir, "s2222222-sub.jsonl"))).toBe(true);
        expect(existsSync(join(archiveDir, "s2222222-sub", "subagents", "agent-sub1.jsonl"))).toBe(true);
        expect(existsSync(join(archiveDir, "s2222222-sub", "subagents", "agent-sub1.meta.json"))).toBe(true);

        // 3. Delete live files (simulate Claude Code cleanup)
        unlinkSync(s1Path);
        unlinkSync(sSubPath);
        rmSync(join(projectDir, "s2222222-sub"), { recursive: true, force: true });

        // 4. Verify API reflects archived sessions and list ETag changes (D5)
        const afterDeleteRes = await get(srv, "/api/sessions");
        expect(afterDeleteRes.status).toBe(200);
        expect(afterDeleteRes.json.sessions).toHaveLength(2);
        for (const s of afterDeleteRes.json.sessions) {
          expect(s.archived).toBe(true);
        }
        const archivedEtag = afterDeleteRes.headers.etag as string;
        expect(archivedEtag).toBeTruthy();
        expect(archivedEtag).not.toBe(liveEtag);

        // Sending old live ETag gets 200 with new content
        const oldEtagReq = await get(srv, "/api/sessions", { "if-none-match": liveEtag });
        expect(oldEtagReq.status).toBe(200);

        // Single session detail route carries archived: true
        const s1Detail = await get(srv, "/api/sessions/s1111111-normal");
        expect(s1Detail.status).toBe(200);
        expect(s1Detail.json.archived).toBe(true);

        // Subagent session detail route carries archived: true and still merges subagent
        const subDetail = await get(srv, "/api/sessions/s2222222-sub");
        expect(subDetail.status).toBe(200);
        expect(subDetail.json.archived).toBe(true);
        expect(subDetail.json.warnings).toEqual([]);

        // 5. Test CLI --list shows "(archived)"
        const listRun = run([
          "--list",
          "--dir",
          PROJECT,
          "--projects-dir",
          projectsDir,
          "--archive-dir",
          archiveRoot,
        ], { NO_COLOR: "1" });
        expect(listRun.status).toBe(0);
        expect(listRun.stdout).toContain("s1111111");
        expect(listRun.stdout).toContain("(archived)");
        expect(listRun.stdout).toContain("s2222222");

        // 6. Test CLI --json has archived: true
        const jsonRun = run([
          "--list",
          "--json",
          "--dir",
          PROJECT,
          "--projects-dir",
          projectsDir,
          "--archive-dir",
          archiveRoot,
        ]);
        expect(jsonRun.status).toBe(0);
        const parsed = JSON.parse(jsonRun.stdout);
        expect(parsed.sessions).toHaveLength(2);
        expect(parsed.sessions.every((s: any) => s.archived === true)).toBe(true);

        // 7. Test CLI --export works on an archived session
        const exportPath = join(tmp, "exported-archive.html");
        const exportRun = run([
          "--export",
          "s1111111",
          "--out",
          exportPath,
          "--dir",
          PROJECT,
          "--projects-dir",
          projectsDir,
          "--archive-dir",
          archiveRoot,
        ]);
        expect(exportRun.status).toBe(0);
        expect(existsSync(exportPath)).toBe(true);
        expect(readFileSync(exportPath, "utf8")).toContain("<!doctype html>");

        // 8. Test CLI --summary works on an archived session
        const summaryRun = run([
          "--summary",
          "--session",
          "s1111111",
          "--dir",
          PROJECT,
          "--projects-dir",
          projectsDir,
          "--archive-dir",
          archiveRoot,
        ]);
        expect(summaryRun.status).toBe(0);
        expect(summaryRun.stdout).toContain("Review summary");
      } finally {
        await srv.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
