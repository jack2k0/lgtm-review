import { request } from "node:http";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Count analyses: an idle conditional request (304) must never reach them.
const calls = vi.hoisted(() => ({ analyze: 0, detail: 0 }));
vi.mock("@lgtm/core/node", async (importOriginal) => {
  const real = await importOriginal<typeof import("@lgtm/core/node")>();
  return {
    ...real,
    analyzeFile: (...a: Parameters<typeof real.analyzeFile>) => (calls.analyze++, real.analyzeFile(...a)),
    analyzeFileDetail: (...a: Parameters<typeof real.analyzeFileDetail>) => (calls.detail++, real.analyzeFileDetail(...a)),
  };
});

import { CSP } from "./security.js";
import { startServer, type RunningServer } from "./server.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../core/fixtures/sessions");
const PROJECT = "/home/user/project";
const enc = encodeURIComponent;

let tmp: string;
let pdir: string;
let srv: RunningServer;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(path: string, extra: Record<string, string> = {}, auth = true, method = "GET", s: RunningServer = srv): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${s.port}`, ...extra };
    if (auth) headers["X-Lgtm-Token"] = s.token;
    request({ host: "127.0.0.1", port: s.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    })
      .on("error", reject)
      .end();
  });
}

const inm = (v: string) => ({ "If-None-Match": v });
const etagOf = (r: Res) => r.headers.etag as string;

function addSession(id: string, from = "checked-basic"): string {
  const f = join(pdir, `${id}.jsonl`);
  copyFileSync(join(fixtures, `${from}.jsonl`), f);
  utimesSync(f, 1_700_000_000, 1_700_000_000);
  return f;
}
/** Appends a line and moves the mtime forward, as a running session would. */
function grow(f: string, secs: number): void {
  appendFileSync(f, `${JSON.stringify({ type: "system", note: "x".repeat(secs) })}\n`);
  utimesSync(f, 1_700_000_000 + secs, 1_700_000_000 + secs);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-cond-test-"));
  pdir = join(tmp, "projects", "-home-user-project");
  mkdirSync(pdir, { recursive: true });
  addSession("live");
  addSession("diffy", "diffs-mixed");
  srv = await startServer({ dir: PROJECT, projectsDir: join(tmp, "projects"), webRoot: join(tmp, "no-web") });
});
afterAll(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  calls.analyze = 0;
  calls.detail = 0;
});

const DIFF_PATH = "/home/user/project/src/greet.js";
const routes: [string, () => string][] = [
  ["list", () => "/api/sessions"],
  ["session", () => "/api/sessions/diffy"],
  ["prompt detail", () => "/api/sessions/diffy/prompts/0"],
  ["diff", () => `/api/sessions/diffy/prompts/0/diff?path=${enc(DIFF_PATH)}`],
];

describe.each(routes)("%s: ETag / 304", (_name, path) => {
  test("200 carries a strong ETag and Cache-Control: no-cache, private", async () => {
    const r = await get(path());
    expect(r.status).toBe(200);
    expect(etagOf(r)).toMatch(/^"[0-9a-f]{16}"$/);
    expect(r.headers["cache-control"]).toBe("no-cache, private");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(JSON.parse(r.body)).toBeTruthy();
  });

  test("If-None-Match forms: strong, weak, list, non-matching, star", async () => {
    const tag = etagOf(await get(path()));
    const other = '"0000000000000000"';
    for (const v of [tag, `W/${tag}`, `${other}, ${tag}`, `${tag},${other}`, `W/${other} , W/${tag}`, "*"]) {
      const r = await get(path(), inm(v));
      expect(r.status, v).toBe(304);
      expect(r.body, v).toBe("");
      expect(etagOf(r), v).toBe(tag);
      expect(r.headers["cache-control"], v).toBe("no-cache, private");
    }
    for (const v of [other, `${other}, W/${other}`, tag.slice(1, -1), "", `${tag}x`, "garbage"]) {
      const r = await get(path(), inm(v));
      expect(r.status, v).toBe(200);
      expect(etagOf(r), v).toBe(tag);
      expect(JSON.parse(r.body)).toBeTruthy();
    }
  });

  test("HEAD with a matching tag is 304 too", async () => {
    const tag = etagOf(await get(path()));
    expect((await get(path(), inm(tag), true, "HEAD")).status).toBe(304);
  });

  test("304 keeps the security headers and sets no CORS headers", async () => {
    const tag = etagOf(await get(path()));
    const r = await get(path(), inm(tag));
    expect(r.status).toBe(304);
    expect(r.headers["content-security-policy"]).toBe(CSP);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
  });

  test("security checks come first: no token / bad token / Host / Origin -> 403 without ETag", async () => {
    const tag = etagOf(await get(path()));
    const cases: Res[] = [
      await get(path(), inm(tag), false),
      await get(path(), { ...inm(tag), "X-Lgtm-Token": "wrong" }, false),
      await get(path(), { ...inm(tag), Host: "evil.example" }),
      await get(path(), { ...inm(tag), Origin: "http://evil.example" }),
      await get(path(), { ...inm(tag), Origin: "null" }),
      await get(path(), { ...inm("*") }, false),
    ];
    for (const r of cases) {
      expect(r.status).toBe(403);
      expect(r.headers.etag).toBeUndefined();
      expect(JSON.parse(r.body)).toEqual({ error: "forbidden" });
    }
  });

  test("idle 304 does not analyse", async () => {
    const tag = etagOf(await get(path()));
    calls.analyze = 0;
    calls.detail = 0;
    for (let i = 0; i < 5; i++) expect((await get(path(), inm(tag))).status).toBe(304);
    expect(calls).toEqual({ analyze: 0, detail: 0 });
  });
});

describe("map and play answer a 304 without detail analysis", () => {
  // A fresh server has empty caches, so the tag can only be answered from the cheap plan. The old routes loaded the
  // full detail analysis (~1 s for a large log) before checking `If-None-Match`.
  test.each(["/api/sessions/diffy/map", "/api/sessions/diffy/prompts/0/play"])("%s", async (path) => {
    const tag = etagOf(await get(path));
    expect(tag).toMatch(/^"[0-9a-f]{16}"$/);
    const cold = await startServer({ dir: PROJECT, projectsDir: join(tmp, "projects"), webRoot: join(tmp, "no-web") });
    try {
      calls.detail = 0;
      const r = await get(path, inm(tag), true, "GET", cold);
      expect(r.status).toBe(304);
      expect(etagOf(r)).toBe(tag);
      expect(calls.detail).toBe(0);
    } finally {
      await cold.close();
    }
  });
});

describe("changes invalidate the ETag", () => {
  test("session, detail and diff tags change when the file grows", async () => {
    const f = addSession("grower", "diffs-mixed");
    const paths = ["/api/sessions/grower", "/api/sessions/grower/prompts/0", `/api/sessions/grower/prompts/0/diff?path=${enc(DIFF_PATH)}`];
    const before = await Promise.all(paths.map(async (p) => etagOf(await get(p))));
    expect(new Set(before).size).toBe(3);
    grow(f, 10);
    for (const [i, p] of paths.entries()) {
      const r = await get(p, inm(before[i]!));
      expect(r.status, p).toBe(200);
      expect(etagOf(r), p).not.toBe(before[i]);
      expect((await get(p, inm(etagOf(r)))).status, p).toBe(304);
    }
    rmSync(f);
  });

  test("an mtime-only change also invalidates", async () => {
    const f = addSession("touched");
    const a = etagOf(await get("/api/sessions/touched"));
    utimesSync(f, 1_700_000_500, 1_700_000_500);
    const r = await get("/api/sessions/touched", inm(a));
    expect(r.status).toBe(200);
    expect(etagOf(r)).not.toBe(a);
    rmSync(f);
  });

  test("list tag changes when a session file appears, grows or disappears", async () => {
    const t0 = etagOf(await get("/api/sessions"));
    const f = addSession("newcomer");
    const r1 = await get("/api/sessions", inm(t0));
    expect(r1.status).toBe(200);
    expect(JSON.parse(r1.body).sessions.map((s: { id: string }) => s.id)).toContain("newcomer");
    const t1 = etagOf(r1);
    expect(t1).not.toBe(t0);
    expect((await get("/api/sessions", inm(t1))).status).toBe(304);

    grow(f, 20);
    const r2 = await get("/api/sessions", inm(t1));
    expect(r2.status).toBe(200);
    const t2 = etagOf(r2);
    expect(t2).not.toBe(t1);

    rmSync(f);
    const r3 = await get("/api/sessions", inm(t2));
    expect(r3.status).toBe(200);
    expect(etagOf(r3)).toBe(t0);
  });

  test("session and prompt tags depend on the whole project: a sibling change flips them, unchanged state still gives 304", async () => {
    const paths = ["/api/sessions/diffy", "/api/sessions/diffy/prompts/0", `/api/sessions/diffy/prompts/0/diff?path=${enc(DIFF_PATH)}`];
    const before = await Promise.all(paths.map(async (p) => etagOf(await get(p))));
    for (const [i, p] of paths.entries()) expect((await get(p, inm(before[i]!))).status, p).toBe(304);
    const sib = addSession("sibling");
    for (const [i, p] of paths.entries()) {
      const r = await get(p, inm(before[i]!));
      expect(r.status, p).toBe(200);
      expect(etagOf(r), p).not.toBe(before[i]);
      expect((await get(p, inm(etagOf(r)))).status, p).toBe(304);
    }
    rmSync(sib);
  });

  test("tags of different routes and prompts differ", async () => {
    const a = etagOf(await get("/api/sessions/diffy/prompts/0"));
    const b = etagOf(await get("/api/sessions/diffy/prompts/1"));
    expect(a).not.toBe(b);
    expect((await get("/api/sessions/diffy/prompts/1", inm(a))).status).toBe(200);
  });
});

describe("never 304 for something that does not exist", () => {
  const missing = [
    "/api/sessions/nope",
    "/api/sessions/diffy/prompts/999",
    `/api/sessions/diffy/prompts/0/diff?path=${enc("/etc/passwd")}`,
    "/api/sessions/nope/prompts/0",
  ];
  test.each(missing)("%s -> 404 for star and any tag", async (p) => {
    for (const v of ["*", '"0123456789abcdef"', 'W/"0123456789abcdef"']) {
      const r = await get(p, inm(v));
      expect(r.status, `${p} ${v}`).toBe(404);
      expect(r.headers.etag).toBeUndefined();
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  test("a session deleted after its tag was issued -> 404", async () => {
    const f = addSession("ephemeral");
    const tag = etagOf(await get("/api/sessions/ephemeral"));
    rmSync(f);
    expect((await get("/api/sessions/ephemeral", inm(tag))).status).toBe(404);
    expect((await get("/api/sessions/ephemeral", inm("*"))).status).toBe(404);
  });

  test("bad index / bad path stay 400", async () => {
    expect((await get("/api/sessions/diffy/prompts/NaN", inm("*"))).status).toBe(400);
    expect((await get("/api/sessions/diffy/prompts/0/diff", inm("*"))).status).toBe(400);
  });

  test("an unreadable session is 404 for star, not 304", async () => {
    writeFileSync(join(pdir, "garbage.jsonl"), "\u0000\u0001 not json\n{{{\n");
    expect((await get("/api/sessions/garbage", inm("*"))).status).toBeLessThan(500);
    rmSync(join(pdir, "garbage.jsonl"));
  });
});

describe("other responses are unchanged", () => {
  test("errors and non-conditional routes keep no-store and no ETag", async () => {
    const r = await get("/api/zzz");
    expect(r.status).toBe(404);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers.etag).toBeUndefined();
    const e = await get("/api/sessions/diffy/prompts/x");
    expect(e.status).toBe(400);
    expect(e.headers["cache-control"]).toBe("no-store");
  });
});

describe("subagent files are part of the ETag and the cache key", () => {
  const agentFile = () => join(pdir, "withsub", "subagents", "agent-a2222222.jsonl");
  const routesOf = ["/api/sessions", "/api/sessions/withsub", "/api/sessions/withsub/prompts/0"];

  test("the merged result is served; the ETag is stable until a subagent file changes", async () => {
    addSession("withsub", "subagent-check");
    cpSync(join(fixtures, "subagent-check"), join(pdir, "withsub"), { recursive: true });
    try {
      const body = JSON.parse((await get("/api/sessions/withsub")).body) as { prompts: { status: string; partial: boolean; reason: string }[] };
      expect(body.prompts[0]).toMatchObject({ status: "checked", partial: false });
      expect(body.prompts[0]!.reason).toContain("by subagent Run the test suite");
      const detail = JSON.parse((await get("/api/sessions/withsub/prompts/0")).body) as { steps: { title: string; actions: { via?: string }[] }[] };
      expect(detail.steps.some((st) => st.title.startsWith("Subagent: "))).toBe(true);

      const tags = new Map<string, string>();
      for (const r of routesOf) tags.set(r, etagOf(await get(r)));

      // Nothing changed: same tags, 304, and no analysis behind it.
      calls.analyze = 0;
      calls.detail = 0;
      for (const r of routesOf) {
        const again = await get(r, inm(tags.get(r)!));
        expect(again.status, r).toBe(304);
        expect(etagOf(again), r).toBe(tags.get(r));
      }
      expect(calls.analyze + calls.detail).toBe(0);

      // The subagent transcript grows (real new data): every tag changes, and the analysis is recomputed.
      appendFileSync(agentFile(), `${JSON.stringify({ type: "system", note: "more" })}\n`);
      utimesSync(agentFile(), 1_700_001_000, 1_700_001_000);
      for (const r of routesOf) {
        const after = await get(r, inm(tags.get(r)!));
        expect(after.status, r).toBe(200);
        expect(etagOf(after), r).not.toBe(tags.get(r));
      }
      expect(calls.analyze).toBeGreaterThan(0);
      expect(calls.detail).toBeGreaterThan(0);

      // A new subagent file shows up in the tag too.
      const tagNow = etagOf(await get("/api/sessions/withsub"));
      writeFileSync(join(pdir, "withsub", "subagents", "agent-a8888888.jsonl"), "");
      expect(etagOf(await get("/api/sessions/withsub"))).not.toBe(tagNow);
    } finally {
      rmSync(join(pdir, "withsub.jsonl"), { force: true });
      rmSync(join(pdir, "withsub"), { recursive: true, force: true });
    }
  });
});
