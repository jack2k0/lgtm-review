import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  FileDiff,
  GitCrosscheckResponse,
  ImportMapResponse,
  LlmTitlesResponse,
  PlayResponse,
  PromptDetail,
  SessionAnalysis,
  condenseForTitle,
  markInherited,
  titleRequestBody,
} from "@lgtm/core";
import { analyzeFile, loadRepoScripts, projectDirFor } from "@lgtm/core/node";
import { osUsernames, runExport } from "./export.js";
import { createTitler, parseLlmUrl } from "./llm.js";
import { startServer, type RunningServer } from "./server.js";
import { formatSummary } from "./summary.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../core/fixtures/sessions");
const cli = join(here, "../dist/cli.js");
const PROJECT = "/home/user/project";

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  json: any;
}

interface Hit {
  method: string;
  url: string;
  host: string;
  body: string;
}

function get(s: RunningServer, path: string, token: string | null = s.token, extra: Record<string, string> = {}, method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${s.port}`, ...extra };
    if (token !== null) headers["X-Lgtm-Token"] = token;
    request({ host: "127.0.0.1", port: s.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const b = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json: b ? JSON.parse(b) : null });
      });
    })
      .on("error", reject)
      .end();
  });
}

function chat(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
}

async function startModel(onHit: (hit: Hit, res: ServerResponse) => void): Promise<{ hits: Hit[]; port: number; close(): Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit = { method: req.method ?? "", url: req.url ?? "", host: String(req.headers.host ?? ""), body: Buffer.concat(chunks).toString("utf8") };
      hits.push(hit);
      try {
        onHit(hit, res);
      } catch {
        res.destroy();
      }
    });
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    hits,
    port: addr.port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function reply(res: ServerResponse, status: number, body: string): void {
  const buf = Buffer.from(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length, connection: "close" });
  res.end(buf);
}

let tmp: string;
let pdir: string;
let cacheDir: string;
let plain: RunningServer;
let titled: RunningServer;
let model: { hits: Hit[]; port: number; close(): Promise<void> };

async function waitReady(s: RunningServer, id: string): Promise<Res> {
  let last!: Res;
  for (let i = 0; i < 100; i++) {
    last = await get(s, `/api/sessions/${id}/titles`);
    if (last.status === 200 && last.json.pending === 0) return last;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`titles stayed pending: ${JSON.stringify(last.json)}`);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-titles-"));
  pdir = join(tmp, "projects", "-home-user-project");
  cacheDir = join(tmp, "titles");
  mkdirSync(pdir, { recursive: true });
  // Only these logs. The full fixture set reuses prompt uuids, so checked-basic would be inherited and have nothing to title.
  for (const name of ["checked-basic.jsonl", "diffs-mixed.jsonl", "fork-resume-a.jsonl", "fork-resume-b.jsonl"]) {
    copyFileSync(join(fixtures, name), join(pdir, name));
  }
  writeFileSync(
    join(pdir, "secret-prompt.jsonl"),
    `${JSON.stringify({
      type: "user",
      uuid: "11111111-1111-4111-8111-000000000001",
      parentUuid: null,
      sessionId: "secret-prompt",
      timestamp: "2026-01-02T00:00:01.000Z",
      cwd: PROJECT,
      gitBranch: "main",
      version: "2.1.0",
      message: { role: "user", content: "Rotate sk-ant-api03-abcdefghij123 now." },
    })}\n`,
  );
  model = await startModel((_hit, res) => reply(res, 200, chat("Shipped the parser")));
  const endpoint = parseLlmUrl(`http://127.0.0.1:${model.port}/v1`);
  if (endpoint instanceof Error) throw endpoint;
  const opts = { dir: PROJECT, projectsDir: join(tmp, "projects"), webRoot: join(tmp, "no-web") };
  plain = await startServer(opts);
  titled = await startServer({
    ...opts,
    llm: createTitler({ endpoint, model: "qwen3:4b", cacheDir, timeoutMs: 2000 }),
  });
});

afterAll(async () => {
  await plain.close();
  await titled.close();
  await model.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/sessions/:id/titles", () => {
  test("without flags, list, session, prompt and titles never call the model", async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;
    const before = model.hits.length;
    try {
      expect((await get(plain, "/api/sessions")).status).toBe(200);
      expect((await get(plain, "/api/sessions/checked-basic")).status).toBe(200);
      expect((await get(plain, "/api/sessions/checked-basic/prompts/0")).status).toBe(200);
      const titles = await get(plain, "/api/sessions/checked-basic/titles");
      expect(titles.status).toBe(200);
      expect(titles.json).toEqual({ enabled: false, titles: {}, pending: 0, error: null });
      expect(titles.headers["cache-control"]).toBe("no-store");
      expect(titles.headers.etag).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(model.hits.length).toBe(before);
      expect(existsSync(cacheDir)).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("unknown id is 404 with or without a titler, and a bad token or host is 403", async () => {
    const before = model.hits.length;
    for (const s of [plain, titled]) {
      const missing = await get(s, "/api/sessions/no-such-session/titles");
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ error: "not found" });
      expect((await get(s, "/api/sessions/checked-basic/titles", null)).status).toBe(403);
      expect((await get(s, "/api/sessions/checked-basic/titles", "nope")).status).toBe(403);
      expect((await get(s, "/api/sessions/checked-basic/titles", s.token, { Host: "evil.example" })).status).toBe(403);
      expect((await get(s, "/api/sessions/checked-basic/titles", s.token, { Origin: "http://evil.example" })).status).toBe(403);
      expect((await get(s, "/api/sessions/checked-basic/titles/extra")).status).toBe(404);
    }
    expect(model.hits.length).toBe(before);
    expect(existsSync(cacheDir)).toBe(false);
  });

  test("titles is always 200 no-store, including HEAD, a query and If-None-Match", async () => {
    const star = await get(plain, "/api/sessions/checked-basic/titles", plain.token, { "If-None-Match": "*" });
    expect(star.status).toBe(200);
    expect(star.headers["cache-control"]).toBe("no-store");
    expect(star.headers.etag).toBeUndefined();
    const tagged = await get(plain, "/api/sessions/checked-basic/titles", plain.token, { "If-None-Match": '"abc"' });
    expect(tagged.status).toBe(200);
    expect(tagged.headers.etag).toBeUndefined();
    const query = await get(plain, "/api/sessions/checked-basic/titles?x=1");
    expect(query.status).toBe(200);
    expect(query.json.enabled).toBe(false);
    const slash = await get(plain, "/api/sessions/checked-basic/titles/");
    expect(slash.status).toBe(200);
    const head = await get(plain, "/api/sessions/checked-basic/titles", plain.token, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.json).toBeNull();
    expect(head.headers["cache-control"]).toBe("no-store");
    expect(head.headers.etag).toBeUndefined();
  });

  test("the first response does not wait, then a title is cached and not requested again", async () => {
    const session = SessionAnalysis.parse((await get(titled, "/api/sessions/checked-basic")).json);
    const detail = PromptDetail.parse((await get(titled, "/api/sessions/checked-basic/prompts/0")).json);
    const input = condenseForTitle(session.prompts[0]!, detail, { repoDir: PROJECT, usernames: osUsernames() });
    expect(input).toContain("src/add.js");
    expect(input).not.toContain("/home/user/project");
    expect(input).not.toContain("Tests: 3 passed");

    const before = model.hits.length;
    const first = await get(titled, "/api/sessions/checked-basic/titles");
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers.etag).toBeUndefined();
    expect(LlmTitlesResponse.parse(first.json)).toMatchObject({ enabled: true, pending: 1, error: null });
    expect(first.json.titles).toEqual({});

    const done = await waitReady(titled, "checked-basic");
    expect(done.json.titles["0"]).toBe("Shipped the parser");
    expect(done.json.pending).toBe(0);
    expect(done.json.error).toBeNull();
    expect(model.hits.length - before).toBe(1);
    const hit = model.hits[before]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/v1/chat/completions");
    expect(JSON.parse(hit.body)).toEqual(titleRequestBody("qwen3:4b", input));

    const again = await get(titled, "/api/sessions/checked-basic/titles", titled.token, { "If-None-Match": "*" });
    expect(again.status).toBe(200);
    expect(again.headers.etag).toBeUndefined();
    expect(again.headers["cache-control"]).toBe("no-store");
    expect(again.json.titles["0"]).toBe("Shipped the parser");
    expect(model.hits.length - before).toBe(1);
    expect(existsSync(cacheDir)).toBe(true);
  });

  test("inherited prompts are not titled", async () => {
    const before = model.hits.length;
    const first = await get(titled, "/api/sessions/fork-resume-b/titles");
    expect(first.json.enabled).toBe(true);
    expect(first.json.pending).toBe(2);
    expect(first.json.titles).toEqual({});
    const done = await waitReady(titled, "fork-resume-b");
    expect(Object.keys(done.json.titles).sort()).toEqual(["3", "4"]);
    expect(done.json.pending).toBe(0);
    const fresh = model.hits.slice(before);
    expect(fresh).toHaveLength(2);
    const blob = fresh.map((h) => h.body).join("\n");
    expect(blob).toContain("New prompt four in fork.");
    expect(blob).toContain("New prompt five in fork.");
    expect(blob).not.toContain("Fix prompt one.");
    expect(blob).not.toContain("All tests passed.");
  });

  test("prompt text is redacted before it is sent", async () => {
    const before = model.hits.length;
    const first = await get(titled, "/api/sessions/secret-prompt/titles");
    expect(first.json.pending).toBe(1);
    await waitReady(titled, "secret-prompt");
    const hit = model.hits[before]!;
    expect(hit.body).toContain("[redacted:anthropic-key]");
    expect(hit.body).not.toContain("sk-ant-api03-abcdefghij123");
    expect(model.hits.length - before).toBe(1);
  });

  test("a held model does not delay the GET", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = await startModel((_hit, res) => {
      void gate.then(() => reply(res, 200, chat("Shipped the parser")));
    });
    const endpoint = parseLlmUrl(`http://127.0.0.1:${held.port}/v1`);
    if (endpoint instanceof Error) throw endpoint;
    const cache = join(tmp, "hold-cache");
    const srv = await startServer({
      dir: PROJECT,
      projectsDir: join(tmp, "projects"),
      webRoot: join(tmp, "no-web"),
      llm: createTitler({ endpoint, model: "qwen3:4b", cacheDir: cache, timeoutMs: 2000 }),
    });
    try {
      const first = await get(srv, "/api/sessions/checked-basic/titles");
      expect(first.status).toBe(200);
      expect(first.json.pending).toBeGreaterThan(0);
      expect(first.json.titles).toEqual({});
      expect(first.json.enabled).toBe(true);
      release();
      const done = await waitReady(srv, "checked-basic");
      expect(done.json.titles["0"]).toBe("Shipped the parser");
      expect(held.hits).toHaveLength(1);
    } finally {
      release();
      await srv.close();
      await held.close();
    }
  });

  test("a returned title is redacted again", async () => {
    const dirty = "caroltest edited /home/user/project/src/a.ts with sk-ant-api03-abcdefghij123";
    const echo = await startModel((_hit, res) => reply(res, 200, chat(dirty)));
    const endpoint = parseLlmUrl(`http://127.0.0.1:${echo.port}/v1`);
    if (endpoint instanceof Error) throw endpoint;
    const cache = join(tmp, "echo-cache");
    const srv = await startServer({
      dir: PROJECT,
      projectsDir: join(tmp, "projects"),
      webRoot: join(tmp, "no-web"),
      llm: createTitler({ endpoint, model: "qwen3:4b", cacheDir: cache, timeoutMs: 2000 }),
    });
    const prev = process.env.USER;
    process.env.USER = "caroltest";
    try {
      const first = await get(srv, "/api/sessions/checked-basic/titles");
      expect(first.json.pending).toBeGreaterThan(0);
      const done = await waitReady(srv, "checked-basic");
      const title = done.json.titles["0"] as string;
      expect(title).toContain("[redacted:anthropic-key]");
      expect(title).toContain("<repo>");
      expect(title).toContain("<user>");
      expect(title).not.toContain("sk-ant-api03-abcdefghij123");
      expect(title).not.toContain("/home/user/project");
      expect(title).not.toContain("caroltest");
      const file = readdirSync(cache).find((n) => n.endsWith(".json"));
      expect(file).toBeTruthy();
      const raw = readFileSync(join(cache, file!), "utf8");
      expect(raw).not.toContain("sk-ant-api03-abcdefghij123");
      expect(raw).not.toContain("/home/user/project");
      expect(raw).not.toContain("caroltest");
    } finally {
      if (prev === undefined) delete process.env.USER;
      else process.env.USER = prev;
      await srv.close();
      await echo.close();
    }
  });

  test("a changed session stamp serves the disk cache without a second request", async () => {
    const before = model.hits.length;
    await waitReady(titled, "checked-basic");
    const hits = model.hits.length;
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(pdir, "checked-basic.jsonl"), later, later);
    const first = await get(titled, "/api/sessions/checked-basic/titles");
    expect(first.json.pending).toBeGreaterThan(0);
    expect(first.json.titles).toEqual({});
    const done = await waitReady(titled, "checked-basic");
    expect(done.json.titles["0"]).toBe("Shipped the parser");
    expect(model.hits.length).toBe(hits);
    expect(model.hits.length).toBeGreaterThanOrEqual(before);
  });

  test("existing routes still match after /titles is added", async () => {
    const list = await get(titled, "/api/sessions");
    expect(list.status).toBe(200);
    expect(list.json.dir).toBe(PROJECT);
    expect(list.json.sessions.some((s: { id: string }) => s.id === "diffs-mixed")).toBe(true);

    const session = await get(titled, "/api/sessions/diffs-mixed");
    expect(session.status).toBe(200);
    expect(SessionAnalysis.parse(session.json).sessionId).toBe("diffs-mixed");

    const prompt = await get(titled, "/api/sessions/diffs-mixed/prompts/0");
    expect(prompt.status).toBe(200);
    expect(PromptDetail.parse(prompt.json).index).toBe(0);

    const path = "/home/user/project/src/greet.js";
    const diff = await get(titled, `/api/sessions/diffs-mixed/prompts/0/diff?path=${encodeURIComponent(path)}`);
    expect(diff.status).toBe(200);
    expect(FileDiff.parse(diff.json).path).toBe(path);

    const map = await get(titled, "/api/sessions/diffs-mixed/map");
    expect(map.status).toBe(200);
    expect(ImportMapResponse.parse(map.json).sessionId).toBe("diffs-mixed");

    const git = await get(titled, "/api/sessions/diffs-mixed/git");
    expect(git.status).toBe(200);
    const cross = GitCrosscheckResponse.parse(git.json);
    expect(cross.sessionId).toBe("diffs-mixed");
    expect(cross.available).toBe(false);

    const play = await get(titled, "/api/sessions/checked-basic/prompts/0/play");
    expect(play.status).toBe(200);
    expect(PlayResponse.parse(play.json).prompt).toBe(0);

    const titles = await get(titled, "/api/sessions/diffs-mixed/titles");
    expect(titles.status).toBe(200);
    expect(LlmTitlesResponse.parse(titles.json).enabled).toBe(true);
  });
});

describe("summary, export and list ignore a titler", () => {
  test("two CLI runs match, and an in-process titler is never asked", async () => {
    const home = mkdtempSync(join(tmpdir(), "lgtm-byte-"));
    const repo = join(home, "repo");
    const projects = join(home, "projects");
    const archive = join(home, "archive");
    mkdirSync(repo);
    mkdirSync(projects);
    mkdirSync(archive);
    const project = projectDirFor(repo, projects);
    mkdirSync(project, { recursive: true });
    copyFileSync(join(fixtures, "checked-basic.jsonl"), join(project, "checked-basic.jsonl"));

    let proxyHits = 0;
    const proxy = createServer((req, res) => {
      proxyHits += 1;
      req.resume();
      res.end("P");
    });
    const quiet = await startModel((_hit, res) => reply(res, 200, chat("nope")));
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", () => {
        proxy.off("error", reject);
        resolve();
      });
    });
    const proxyAddr = proxy.address();
    if (proxyAddr === null || typeof proxyAddr === "string") throw new Error("no proxy port");
    const proxyUrl = `http://127.0.0.1:${proxyAddr.port}`;
    const base = ["--no-worktrees", "--dir", repo, "--projects-dir", projects, "--archive-dir", archive];
    const run = (args: string[]) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: "1",
        HOME: home,
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        NODE_USE_ENV_PROXY: "1",
      };
      delete env.NO_PROXY;
      delete env.no_proxy;
      return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20000, env });
    };
    try {
      const s1 = run(["--summary", "--session", "checked-basic", ...base]);
      const s2 = run(["--summary", "--session", "checked-basic", ...base]);
      expect(s1.status, s1.stderr).toBe(0);
      expect(s2.status, s2.stderr).toBe(0);
      expect(s1.stdout).toBe(s2.stdout);
      expect(s1.stderr).not.toContain("LLM titles:");
      expect(s2.stderr).not.toContain("LLM titles:");

      const l1 = run(["--list", "--json", ...base]);
      const l2 = run(["--list", "--json", ...base]);
      expect(l1.status, l1.stderr).toBe(0);
      expect(l2.status).toBe(0);
      expect(l1.stdout).toBe(l2.stdout);

      const out1 = join(home, "a.html");
      const out2 = join(home, "b.html");
      const e1 = run(["--export", "checked-basic", "--out", out1, "--force", ...base]);
      const e2 = run(["--export", "checked-basic", "--out", out2, "--force", ...base]);
      expect(e1.status, e1.stderr).toBe(0);
      expect(e2.status, e2.stderr).toBe(0);
      expect(readFileSync(out1)).toEqual(readFileSync(out2));

      expect(proxyHits).toBe(0);
      expect(quiet.hits).toHaveLength(0);
      expect(existsSync(join(home, ".lgtm-review"))).toBe(false);

      const endpoint = parseLlmUrl(`http://127.0.0.1:${quiet.port}/v1`);
      if (endpoint instanceof Error) throw endpoint;
      const idle = createTitler({ endpoint, model: "qwen3:4b", cacheDir: join(home, "titles"), timeoutMs: 500 });
      const repoScripts = await loadRepoScripts(repo);
      const analysis = markInherited([
        await analyzeFile(join(project, "checked-basic.jsonl"), { repo: repoScripts, sessionId: "checked-basic", file: "checked-basic.jsonl" }),
      ])[0]!;
      const text = formatSummary(analysis, { titles: true, root: repo });
      expect(formatSummary(analysis, { titles: true, root: repo })).toBe(text);
      expect(text).toBe(s1.stdout);
      const localOut = join(home, "local.html");
      expect(await runExport({ dir: repo, projectsDir: projects, archiveDir: archive, prefix: "checked-basic", out: localOut, force: true, diffs: true, titles: true })).toBe(0);
      expect(readFileSync(localOut)).toEqual(readFileSync(out1));
      await idle.settled();
      expect(idle.view("checked-basic")).toEqual({ titles: {}, pending: 0, error: null });
      expect(quiet.hits).toHaveLength(0);
      expect(existsSync(join(home, "titles"))).toBe(false);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await quiet.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
