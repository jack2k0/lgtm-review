import { request } from "node:http";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { FileDiff, PromptDetail, SessionAnalysis, SessionsResponse, type PromptAnalysis } from "@lgtm/core";
import { projectDirFor } from "@lgtm/core/node";
import { summarize } from "./api.js";
import { startServer, type RunningServer } from "./server.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../core/fixtures/sessions");
const PROJECT = "/home/user/project";
const ids = readdirSync(fixtures).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));

let tmp: string;
let pdir: string;
let srv: RunningServer;
let empty: RunningServer;

function get(
  s: RunningServer,
  path: string,
  token: string | null = s.token,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: Record<string, unknown>; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${s.port}`, ...(extraHeaders ?? {}) };
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
  tmp = mkdtempSync(join(tmpdir(), "lgtm-api-test-"));
  pdir = join(tmp, "projects", "-home-user-project");
  mkdirSync(pdir, { recursive: true });
  for (const id of ids) copyFileSync(join(fixtures, `${id}.jsonl`), join(pdir, `${id}.jsonl`));
  writeFileSync(join(pdir, "notes.txt"), "not a session");
  srv = await startServer({ dir: PROJECT, projectsDir: join(tmp, "projects"), webRoot: join(tmp, "no-web") });
  empty = await startServer({ dir: "/home/user/other", projectsDir: join(tmp, "projects"), webRoot: join(tmp, "no-web") });
});
afterAll(async () => {
  await srv.close();
  await empty.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/sessions", () => {
  test("requires the token", async () => {
    expect((await get(srv, "/api/sessions", null)).status).toBe(403);
    expect((await get(srv, "/api/sessions", "nope")).status).toBe(403);
  });

  test("summaries for every fixture session, no prompts", async () => {
    const r = await get(srv, "/api/sessions");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-cache, private");
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(SessionsResponse.parse(r.json).dir).toBe(PROJECT);
    expect(r.json.dir).toBe(PROJECT);
    expect(r.json.sessions.map((s: { id: string }) => s.id).sort()).toEqual([...ids].sort());
    for (const s of r.json.sessions) {
      const keys = ["attentionCount", "branch", "id", "inheritedCount", "promptCount", "startedAt", "statusCounts", "title", "warningCount"];
      expect(Object.keys(s).sort()).toEqual((s.inheritedCount > 0 ? [...keys, "forkOf"] : keys).sort());
      expect(Object.keys(s.statusCounts).sort()).toEqual(["checked", "failing", "no-changes", "unchecked"]);
      const total = Object.values(s.statusCounts as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(total).toBe(s.promptCount);
    }
  });

  test("summary matches the full analysis; newest first", async () => {
    const list = (await get(srv, "/api/sessions")).json.sessions as { id: string; startedAt: string | null }[];
    const fulls = [];
    for (const s of list) fulls.push(SessionAnalysis.parse((await get(srv, `/api/sessions/${s.id}`)).json));
    for (const s of list) expect(summarize(fulls.find((f) => f.sessionId === s.id)!, fulls)).toEqual(s);
    const dated = list.map((s) => s.startedAt).filter((x): x is string => x !== null);
    expect(dated).toEqual([...dated].sort().reverse());
  });

  test("attentionCount counts own prompts that need attention", async () => {
    const list = (await get(srv, "/api/sessions")).json.sessions as { id: string; attentionCount: number }[];
    for (const s of list) {
      const full = SessionAnalysis.parse((await get(srv, `/api/sessions/${s.id}`)).json);
      const expected = full.prompts.filter(
        (p) => p.inheritedFrom === undefined && (p.hints.length > 0 || p.status === "unchecked" || p.status === "failing"),
      ).length;
      expect(s.attentionCount, s.id).toBe(expected);
    }
  });

  test("no sessions or missing project dir -> empty list", async () => {
    const r = await get(empty, "/api/sessions");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ dir: "/home/user/other", sessions: [] });
  });

  test("trailing slash is accepted", async () => {
    expect((await get(srv, "/api/sessions/")).status).toBe(200);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("discovery warnings are printed to stderr once per server run as 'warning: <text>'", async () => {
    const unreadableLive = join(tmp, "unreadable-live");
    const archiveDir = join(tmp, "test-archive");
    mkdirSync(unreadableLive, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "sess-1.jsonl"), "data\n");
    chmodSync(unreadableLive, 0o000);

    const warnSrv = await startServer({
      dir: PROJECT,
      projectsDir: join(tmp, "projects"),
      roots: [{ dir: PROJECT, worktree: ".", projectDir: unreadableLive, archiveDir }],
      webRoot: join(tmp, "no-web"),
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // First request -> logs warning
      const r1 = await get(warnSrv, "/api/sessions");
      expect(r1.status).toBe(200);
      const warningsFirst = errSpy.mock.calls
        .map((c) => c[0])
        .filter((msg) => typeof msg === "string" && msg.startsWith("warning:"));
      expect(warningsFirst.length).toBe(1);
      expect(warningsFirst[0]).toContain(`${unreadableLive}: unreadable`);
      expect(warningsFirst[0]).toContain("showing archived sessions only");

      // Second request -> does NOT log the warning again
      const r2 = await get(warnSrv, "/api/sessions");
      expect(r2.status).toBe(200);
      const warningsSecond = errSpy.mock.calls
        .map((c) => c[0])
        .filter((msg) => typeof msg === "string" && msg.startsWith("warning:"));
      expect(warningsSecond.length).toBe(1);
    } finally {
      errSpy.mockRestore();
      chmodSync(unreadableLive, 0o755);
      await warnSrv.close();
      rmSync(unreadableLive, { recursive: true, force: true });
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });
});

describe("fork/resume dedupe", () => {
  test("list: counts are not doubled, the later session is marked as a fork of the earlier one", async () => {
    const list = (await get(srv, "/api/sessions")).json.sessions as { id: string; promptCount: number; inheritedCount: number; forkOf?: string }[];
    const a = list.find((s) => s.id === "fork-resume-a")!;
    const b = list.find((s) => s.id === "fork-resume-b")!;
    expect([a.promptCount, a.inheritedCount, a.forkOf]).toEqual([3, 0, undefined]);
    expect([b.promptCount, b.inheritedCount, b.forkOf]).toEqual([2, 3, "fork-resume-a"]);
    expect(Object.values((list.find((s) => s.id === "fork-resume-b") as any).statusCounts).reduce((x: any, y: any) => x + y, 0)).toBe(2);
  });

  test("detail keeps the inherited prompts, marked with inheritedFrom", async () => {
    const b = SessionAnalysis.parse((await get(srv, "/api/sessions/fork-resume-b")).json);
    expect(b.prompts.map((p) => p.inheritedFrom)).toEqual(["fork-resume-a", "fork-resume-a", "fork-resume-a", undefined, undefined]);
    const a = SessionAnalysis.parse((await get(srv, "/api/sessions/fork-resume-a")).json);
    expect(a.prompts.every((p) => p.inheritedFrom === undefined)).toBe(true);
  });

  test("summarize breaks forkOf ties by ownership order, not by prompt order", () => {
    const mk = (sessionId: string, startedAt: string | null, uuids: string[], from: string[]) =>
      ({ sessionId, startedAt, title: "", branch: "", warnings: [], prompts: uuids.map((uuid, i) => ({ uuid, index: i, status: "checked", hints: [], ...(from[i] ? { inheritedFrom: from[i] } : {}) })) }) as any;
    const early = mk("zzz", "2026-01-01T00:00:00Z", [], []);
    const late = mk("aaa", "2026-01-02T00:00:00Z", [], []);
    const child = mk("child", "2026-01-03T00:00:00Z", ["1", "2"], ["aaa", "zzz"]);
    expect(summarize(child, [early, late, child]).forkOf).toBe("zzz");
    expect(summarize(child).forkOf).toBe("aaa");
  });
});

describe("GET /api/sessions/:id", () => {
  test("returns the full SessionAnalysis (with timing)", async () => {
    const r = await get(srv, "/api/sessions/timing-split");
    expect(r.status).toBe(200);
    const s = SessionAnalysis.parse(r.json);
    expect(s.sessionId).toBe("timing-split");
    expect(s.prompts.length).toBeGreaterThan(0);
    expect(s.prompts.some((p) => p.activeMs > 0)).toBe(true);
  });

  test("requires the token", async () => {
    expect((await get(srv, "/api/sessions/timing-split", null)).status).toBe(403);
  });

  test.each([
    "nope",
    "notes",
    "notes.txt",
    "checked-basic.jsonl",
    "..%2Fprojects%2F-home-user-project%2Fchecked-basic",
    "..%2F..%2Fetc%2Fpasswd",
    "%2e%2e",
    "..",
    "%00",
    "checked-basic%00",
    "%zz",
    "checked-basic/extra",
    "CHECKED-BASIC",
  ])("unknown or hostile id %j -> 404", async (id) => {
    const r = await get(srv, `/api/sessions/${id}`);
    expect([404]).toContain(r.status);
    expect(r.json).toEqual({ error: "not found" });
  });
});

const enc = encodeURIComponent;

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur]!);
    }
  });
  await Promise.all(workers);
  return results;
}

describe("GET /api/sessions/:id/prompts/:index", () => {
  test("every fixture prompt validates against PromptDetail and matches the analysis", async () => {
    const pairs: Array<{ id: string; p: PromptAnalysis }> = [];
    await mapConcurrent(ids, 16, async (id) => {
      const full = SessionAnalysis.parse((await get(srv, `/api/sessions/${id}`)).json);
      for (const p of full.prompts) pairs.push({ id, p });
    });
    await mapConcurrent(pairs, 16, async ({ id, p }) => {
      const r = await get(srv, `/api/sessions/${id}/prompts/${p.index}`);
      expect(r.status, `${id}#${p.index}`).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-cache, private");
      const d = PromptDetail.parse(r.json);
      expect(d.index).toBe(p.index);
      expect(d.status).toBe(p.status);
      expect(d.activeMs).toBe(p.activeMs);
      // every file of every step is a diff-able file of the prompt
      const files = new Set(p.files.map((f) => f.path));
      for (const st of d.steps) for (const f of st.files) expect(files.has(f), f).toBe(true);
    });
  }, 20_000);

  test("requires the token", async () => {
    expect((await get(srv, "/api/sessions/diffs-mixed/prompts/0", null)).status).toBe(403);
    expect((await get(srv, "/api/sessions/diffs-mixed/prompts/0/diff?path=x", "bad")).status).toBe(403);
  });

  test.each(["-1", "1e3", "NaN", "abc", "", "01", "0x1", "1.5", "%30", "%2D1", "+1", "99999999999", "Infinity"])("bad index %j -> 400", async (i) => {
    const r = await get(srv, `/api/sessions/diffs-mixed/prompts/${i}`);
    if (i === "") expect(r.status).toBe(404); // no segment at all: unknown route
    else expect(r.status).toBe(400);
    expect(r.json).not.toHaveProperty("steps");
  });

  test("index out of range, unknown or hostile session -> 404", async () => {
    expect((await get(srv, "/api/sessions/diffs-mixed/prompts/2")).status).toBe(404);
    expect((await get(srv, "/api/sessions/diffs-mixed/prompts/999999")).status).toBe(404);
    for (const id of ["nope", "..", "%2e%2e", "%zz", "checked-basic.jsonl", "..%2F..%2Fetc%2Fpasswd"]) {
      const r = await get(srv, `/api/sessions/${id}/prompts/0`);
      expect(r.status, id).toBe(404);
      expect(r.json).toEqual({ error: "not found" });
    }
  });

  test("extra segments are unknown routes", async () => {
    for (const p of ["/api/sessions/diffs-mixed/prompts", "/api/sessions/diffs-mixed/prompts/0/steps", "/api/sessions/diffs-mixed/prompts/0/diff/x", "/api/sessions/diffs-mixed/prompts/0/1"]) {
      expect((await get(srv, p)).status, p).toBe(404);
    }
  });
});

describe("GET /api/sessions/:id/prompts/:index/diff?path=", () => {
  const base = "/api/sessions/diffs-mixed/prompts/0/diff";
  const edited = "/home/user/project/src/greet.js";

  test("every file of every prompt validates against FileDiff", async () => {
    for (const id of ["diffs-mixed", "checked-basic", "steps-mixed", "steps-edge"]) {
      const full = SessionAnalysis.parse((await get(srv, `/api/sessions/${id}`)).json);
      for (const p of full.prompts) {
        for (const f of p.files) {
          const r = await get(srv, `/api/sessions/${id}/prompts/${p.index}/diff?path=${enc(f.path)}`);
          expect(r.status, `${id}#${p.index} ${f.path}`).toBe(200);
          expect(r.headers["cache-control"]).toBe("no-cache, private");
          const d = FileDiff.parse(r.json);
          expect(d.path).toBe(f.path);
          expect(d.kind).toBe(f.kind);
        }
      }
    }
  });

  test("returns hunks for an edited file", async () => {
    const r = await get(srv, `${base}?path=${enc(edited)}`);
    expect(r.status).toBe(200);
    const d = FileDiff.parse(r.json);
    expect(d.hunks.length).toBeGreaterThan(0);
    expect(d.hunks[0]!.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });

  test("backslash form of a listed path is normalised to the listed one", async () => {
    const r = await get(srv, `${base}?path=${enc(edited.replaceAll("/", "\\"))}`);
    expect(r.status).toBe(200);
    expect(FileDiff.parse(r.json).path).toBe(edited);
  });

  test.each([
    ["missing parameter", ""],
    ["empty", "?path="],
    ["no value", "?path"],
    ["other name", `?file=${enc("/home/user/project/src/greet.js")}`],
    ["bad percent encoding", "?path=%zz"],
    ["truncated percent encoding", "?path=%E0%A4%A"],
    ["lone surrogate bytes", "?path=%ED%A0%80"],
    ["NUL", "?path=a%00b"],
    ["duplicated", `?path=${enc("/home/user/project/src/greet.js")}&path=${enc("/home/user/project/src/a.js")}`],
  ])("bad path parameter (%s) -> 400", async (_n, q) => {
    expect((await get(srv, base + q)).status).toBe(400);
  });

  test.each([
    "/etc/passwd",
    "../../../../etc/passwd",
    "..\\..\\etc\\passwd",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/home/user/project/src/../src/greet.js",
    "/home/user/project/src/greet.js/",
    "/home/user/project/src/greet.js ",
    "/home/user/project/src/GREET.js",
    "src/greet.js",
    "/home/user/project/src/missing.js",
    "/home/user/project/data/big.txt", // belongs to prompt 1, not 0
    "file:///etc/passwd",
    "~",
    "*",
    ".",
    "/",
  ])("path outside the prompt's file list %j -> 404", async (p) => {
    const r = await get(srv, `${base}?path=${enc(p)}`);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not found" });
  });

  test("a double-encoded path is decoded once only", async () => {
    expect((await get(srv, `${base}?path=${enc(enc(edited))}`)).status).toBe(404);
  });

  test("plus is a plus, not a space", async () => {
    expect((await get(srv, `${base}?path=${edited.replaceAll("/", "%2F")}+`)).status).toBe(404);
  });

  test("bad index / unknown session are rejected before path matters", async () => {
    expect((await get(srv, `/api/sessions/diffs-mixed/prompts/NaN/diff?path=${enc(edited)}`)).status).toBe(400);
    expect((await get(srv, `/api/sessions/diffs-mixed/prompts/-1/diff?path=${enc(edited)}`)).status).toBe(400);
    expect((await get(srv, `/api/sessions/diffs-mixed/prompts/9/diff?path=${enc(edited)}`)).status).toBe(404);
    expect((await get(srv, `/api/sessions/nope/prompts/0/diff?path=${enc(edited)}`)).status).toBe(404);
  });
});

describe("detail cache", () => {
  test("keyed by path + mtime + size", async () => {
    const f = join(pdir, "detail-probe.jsonl");
    copyFileSync(join(fixtures, "checked-basic.jsonl"), f);
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    const a = await get(srv, "/api/sessions/detail-probe/prompts/0");
    expect(a.status).toBe(200);
    const st = statSync(f);

    writeFileSync(f, "x".repeat(st.size)); // same size + mtime => cached
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    expect((await get(srv, "/api/sessions/detail-probe/prompts/0")).json).toEqual(a.json);

    copyFileSync(join(fixtures, "diffs-mixed.jsonl"), f); // new size => re-analysed
    const b = await get(srv, "/api/sessions/detail-probe/prompts/0");
    expect(b.status).toBe(200);
    expect(b.json).not.toEqual(a.json);

    rmSync(f);
    expect((await get(srv, "/api/sessions/detail-probe/prompts/0")).status).toBe(404);
  });
});

describe("cache", () => {
  test("keyed by path + mtime + size", async () => {
    const f = join(pdir, "cache-probe.jsonl");
    copyFileSync(join(fixtures, "checked-basic.jsonl"), f);
    utimesSync(f, 1_700_000_000, 1_700_000_000); // whole seconds, so it can be restored exactly
    const a = await get(srv, "/api/sessions/cache-probe");
    expect(a.status).toBe(200);
    const st = statSync(f);

    // same size + same mtime => served from cache even though the bytes changed
    writeFileSync(f, "x".repeat(st.size));
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    expect((await get(srv, "/api/sessions/cache-probe")).json.prompts).toEqual(a.json.prompts);

    // new size => re-analysed
    copyFileSync(join(fixtures, "compact-resume.jsonl"), f);
    const b = await get(srv, "/api/sessions/cache-probe");
    expect(b.json.prompts).not.toEqual(a.json.prompts);
    expect(b.json.prompts.length).toBe((await get(srv, "/api/sessions/compact-resume")).json.prompts.length);

    // deleted => gone
    rmSync(f);
    expect((await get(srv, "/api/sessions/cache-probe")).status).toBe(404);
  });

  test("unreadable garbage session is skipped from the list, not fatal", async () => {
    writeFileSync(join(pdir, "garbage.jsonl"), "\u0000\u0001 not json\n{{{\n");
    const r = await get(srv, "/api/sessions");
    expect(r.status).toBe(200);
    expect(r.json.sessions.length).toBeGreaterThanOrEqual(ids.length);
    expect((await get(srv, "/api/sessions/garbage")).status).toBeLessThan(500);
    rmSync(join(pdir, "garbage.jsonl"));
  });

  test("editing a fixture repo's package.json script between two requests changes the ETag (no 304); an unchanged repo still gives 304; same-size rewrite with restored mtime invalidates via ctime", async () => {
    const repoDir = join(tmp, "repo-scripts-test");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "test-repo", scripts: {} }));
    const projDir = projectDirFor(repoDir, join(tmp, "projects"));
    mkdirSync(projDir, { recursive: true });

    const sess = [
      { type: "user", cwd: repoDir, message: { content: "check task" } },
      { type: "assistant", cwd: repoDir, message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(repoDir, "src/a.ts"), old_string: "1", new_string: "2" } }] } },
      {
        type: "user",
        cwd: repoDir,
        message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
        toolUseResult: { type: "update", filePath: join(repoDir, "src/a.ts"), oldString: "1", newString: "2", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-1", "+2"] }] },
      },
      { type: "assistant", cwd: repoDir, message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "pnpm check" } }] } },
      { type: "user", cwd: repoDir, message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] } },
    ].map((l) => JSON.stringify(l)).join("\n");
    writeFileSync(join(projDir, "session-pkg.jsonl"), sess);

    const repoSrv = await startServer({ dir: repoDir, projectsDir: join(tmp, "projects"), webRoot: join(tmp, "no-web") });
    try {
      const r1 = await get(repoSrv, "/api/sessions/session-pkg");
      expect(r1.status).toBe(200);
      const etag1 = r1.headers.etag as string;
      expect(etag1).toBeDefined();
      expect(r1.json.prompts[0].status).toBe("checked");

      // Unchanged repo gives 304
      const r2 = await get(repoSrv, "/api/sessions/session-pkg", repoSrv.token, { "If-None-Match": etag1 });
      expect(r2.status).toBe(304);

      // Edit package.json to add the check script
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "test-repo", scripts: { check: "exit 0" } }));

      // Changed package.json: ETag changes, no 304
      const r3 = await get(repoSrv, "/api/sessions/session-pkg", repoSrv.token, { "If-None-Match": etag1 });
      expect(r3.status).toBe(200);
      expect(r3.headers.etag).not.toBe(etag1);
      expect(r3.json.prompts[0].status).toBe("checked");

      // Unchanged after edit gives 304
      const r4 = await get(repoSrv, "/api/sessions/session-pkg", repoSrv.token, { "If-None-Match": r3.headers.etag as string });
      expect(r4.status).toBe(304);

      // G2: same-size rewrite with restored mtime (touch -r / utimes) must still change stamp via ctimeMs
      const pkgPath = join(repoDir, "package.json");
      const stBefore = statSync(pkgPath);
      const sameSizeContent = JSON.stringify({ name: "test-repo", scripts: { check: "exit 1" } });
      expect(Buffer.byteLength(sameSizeContent)).toBe(stBefore.size);
      const spinUntil = Date.now() + 10;
      while (Date.now() < spinUntil) {}
      writeFileSync(pkgPath, sameSizeContent);
      utimesSync(pkgPath, stBefore.atime, stBefore.mtime);
      const stAfter = statSync(pkgPath);
      expect(stAfter.size).toBe(stBefore.size);
      expect(stAfter.ctimeMs).not.toBe(stBefore.ctimeMs);

      const r5 = await get(repoSrv, "/api/sessions/session-pkg", repoSrv.token, { "If-None-Match": r3.headers.etag as string });
      expect(r5.status).toBe(200);
      expect(r5.headers.etag).not.toBe(r3.headers.etag);
      expect(r5.json.prompts[0].status).toBe("checked");

      // Unchanged after same-size rewrite gives 304
      const r6 = await get(repoSrv, "/api/sessions/session-pkg", repoSrv.token, { "If-None-Match": r5.headers.etag as string });
      expect(r6.status).toBe(304);

      // Unreadable file fails closed: changing stamp, no 304
      if (process.getuid?.() !== 0) {
        try {
          chmodSync(join(repoDir, "package.json"), 0);
          const rUnreadable1 = await get(repoSrv, "/api/sessions/session-pkg");
          expect(rUnreadable1.status).toBe(200);
          const rUnreadable2 = await get(repoSrv, "/api/sessions/session-pkg", repoSrv.token, {
            "If-None-Match": rUnreadable1.headers.etag as string,
          });
          expect(rUnreadable2.status).toBe(200);
          expect(rUnreadable2.headers.etag).not.toBe(rUnreadable1.headers.etag);
        } finally {
          chmodSync(join(repoDir, "package.json"), 0o644);
        }
      }
    } finally {
      await repoSrv.close();
    }
  });

  test("fixture files untouched", () => {
    expect(readFileSync(join(fixtures, "checked-basic.jsonl")).length).toBe(3500);
  });
});
