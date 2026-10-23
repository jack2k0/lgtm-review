import { request } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FileDiff, PromptDetail, SessionAnalysis, SessionsResponse } from "@lgtm/core";
import { summarize } from "./api.js";
import { startServer, type RunningServer } from "./server.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../core/fixtures/sessions");
const PROJECT = "/home/user/project";
const ids = readdirSync(fixtures).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));

let tmp: string;
let pdir: string;
let srv: RunningServer;
let empty: RunningServer;

function get(s: RunningServer, path: string, token: string | null = s.token): Promise<{ status: number; headers: Record<string, unknown>; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${s.port}` };
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
      expect(Object.keys(s).sort()).toEqual(["branch", "id", "promptCount", "startedAt", "statusCounts", "title", "warningCount"]);
      expect(Object.keys(s.statusCounts).sort()).toEqual(["checked", "failing", "no-changes", "unchecked"]);
      const total = Object.values(s.statusCounts as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(total).toBe(s.promptCount);
    }
  });

  test("summary matches the full analysis; newest first", async () => {
    const list = (await get(srv, "/api/sessions")).json.sessions as { id: string; startedAt: string | null }[];
    for (const s of list) {
      const full = SessionAnalysis.parse((await get(srv, `/api/sessions/${s.id}`)).json);
      expect(summarize(full)).toEqual(s);
    }
    const dated = list.map((s) => s.startedAt).filter((x): x is string => x !== null);
    expect(dated).toEqual([...dated].sort().reverse());
  });

  test("no sessions or missing project dir -> empty list", async () => {
    const r = await get(empty, "/api/sessions");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ dir: "/home/user/other", sessions: [] });
  });

  test("trailing slash is accepted", async () => {
    expect((await get(srv, "/api/sessions/")).status).toBe(200);
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

describe("GET /api/sessions/:id/prompts/:index", () => {
  test("every fixture prompt validates against PromptDetail and matches the analysis", async () => {
    for (const id of ids) {
      const full = SessionAnalysis.parse((await get(srv, `/api/sessions/${id}`)).json);
      for (const p of full.prompts) {
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
      }
    }
  });

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

  test("fixture files untouched", () => {
    expect(readFileSync(join(fixtures, "checked-basic.jsonl")).length).toBe(3500);
  });
});
