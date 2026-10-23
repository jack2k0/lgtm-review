import { request } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SessionAnalysis, SessionsResponse } from "@lgtm/core";
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
    expect(r.headers["cache-control"]).toBe("no-store");
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
