import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TITLE_PROMPT_VERSION, titleRequestBody } from "@lgtm/core";
import {
  TITLE_BODY_CAP,
  TITLE_ERR_RESPONSE,
  TITLE_ERR_UNREACHABLE,
  TITLE_FAILURE_LIMIT,
  TITLE_REQUEST_CAP,
  TITLE_TIMEOUT_MS,
  createTitler,
  defaultTitleCacheDir,
  parseLlmUrl,
  resolveTitleCacheDir,
  titleCacheKey,
  type TitleSource,
  type Titler,
} from "./llm.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [cli, ...args], {
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, CI: "1", ...env },
  });
}

describe("parseLlmUrl", () => {
  test("builds the canonical loopback endpoint", () => {
    const cases: [string, string][] = [
      ["http://127.0.0.1:11434", "http://127.0.0.1:11434/v1/chat/completions"],
      ["http://127.0.0.1:11434/", "http://127.0.0.1:11434/v1/chat/completions"],
      ["http://127.5.6.7:1", "http://127.5.6.7:1/v1/chat/completions"],
      ["http://[::1]:8080", "http://[::1]:8080/v1/chat/completions"],
      ["http://localhost:1234/v1", "http://127.0.0.1:1234/v1/chat/completions"],
      ["http://LOCALHOST:1234/v1/", "http://127.0.0.1:1234/v1/chat/completions"],
      ["http://2130706433", "http://127.0.0.1/v1/chat/completions"],
      ["http://0x7f000001", "http://127.0.0.1/v1/chat/completions"],
      ["http://0177.0.0.1", "http://127.0.0.1/v1/chat/completions"],
      ["http://127.1", "http://127.0.0.1/v1/chat/completions"],
      ["http://[0::1]", "http://[::1]/v1/chat/completions"],
      ["http://[0:0:0:0:0:0:0:1]", "http://[::1]/v1/chat/completions"],
      ["http://127.0.0.1:11434/v1/chat/completions", "http://127.0.0.1:11434/v1/chat/completions"],
      ["http://127.0.0.1:9/foo/v1/chat/completions", "http://127.0.0.1:9/foo/v1/chat/completions"],
    ];
    for (const [input, href] of cases) {
      const got = parseLlmUrl(input);
      expect(got, input).toBeInstanceOf(URL);
      expect((got as URL).href, input).toBe(href);
      expect((got as URL).username, input).toBe("");
      expect((got as URL).search, input).toBe("");
      expect((got as URL).hash, input).toBe("");
    }
  });

  test("rejects non-loopback hosts, userinfo, query, fragment and other paths", () => {
    const loopback = [
      "https://example.com",
      "https://127.0.0.1:11434",
      "http://192.168.1.2:11434",
      "http://10.0.0.1",
      "http://0.0.0.0:1",
      "http://0",
      "http://localhost.",
      "http://foo.localhost",
      "http://127.0.0.1.nip.io",
      "http://[::ffff:169.254.169.254]",
      "http://[::ffff:127.0.0.1]",
      "file:///x",
    ];
    for (const input of loopback) {
      const got = parseLlmUrl(input);
      expect(got, input).toBeInstanceOf(Error);
      expect((got as Error).message, input).toMatch(/loopback model server is allowed/);
    }

    expect((parseLlmUrl("http://user:pw@127.0.0.1") as Error).message).toMatch(/username or password/);
    expect((parseLlmUrl("http://127.0.0.1/?a=1") as Error).message).toMatch(/query and fragment/);
    expect((parseLlmUrl("http://127.0.0.1/#x") as Error).message).toMatch(/query and fragment/);
    expect((parseLlmUrl("http://127.5.6.7:1/x") as Error).message).toMatch(/unsupported path/);
    expect((parseLlmUrl("http://127.0.0.1/v1/chat/completions/") as Error).message).toMatch(/unsupported path/);
    expect((parseLlmUrl("http://[::1%251]:8080") as Error).message).toMatch(/invalid --llm-url/);
    expect(parseLlmUrl("not a url")).toBeInstanceOf(Error);
  });
});

describe("resolveTitleCacheDir", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  test("default dir is under the home cache and is not created by naming it", () => {
    expect(defaultTitleCacheDir()).toMatch(/\.lgtm-review\/cache\/titles$/);
  });

  test("a missing directory outside the repo, projects and archive is accepted and not created", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lgtm-llm-cache-"));
    temps.push(tmp);
    const repo = join(tmp, "repo");
    const projects = join(tmp, "projects");
    const archive = join(tmp, "archive");
    const cache = join(tmp, "titles");
    mkdirSync(repo);
    const got = resolveTitleCacheDir(cache, projects, archive, [repo]);
    expect(got).toEqual({ dir: join(realpathSync(tmp), "titles") });
    expect(existsSync(cache)).toBe(false);
  });

  test("rejects a cache inside the repo, the projects dir or the archive dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lgtm-llm-cache-in-"));
    temps.push(tmp);
    const repo = join(tmp, "repo");
    const projects = join(tmp, "projects");
    const archive = join(tmp, "archive");
    mkdirSync(repo, { recursive: true });
    mkdirSync(projects, { recursive: true });
    mkdirSync(archive, { recursive: true });
    expect(cacheError(join(repo, "c"), projects, archive, [repo])).toMatch(/inside the repository/);
    expect(cacheError(projects, projects, archive, [repo])).toMatch(/projects dir/);
    expect(cacheError(join(archive, "c"), projects, archive, [repo])).toMatch(/archive dir/);
    expect(existsSync(join(repo, "c"))).toBe(false);
  });

  test("refuses a symlink at the cache path and follows a parent symlink into the repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lgtm-llm-cache-link-"));
    temps.push(tmp);
    const repo = join(tmp, "repo");
    const projects = join(tmp, "projects");
    const archive = join(tmp, "archive");
    const outside = join(tmp, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    const link = join(tmp, "link");
    symlinkSync(outside, link);
    expect(cacheError(link, projects, archive, [repo])).toMatch(/symlink/);

    const into = join(tmp, "into-repo");
    symlinkSync(repo, into);
    expect(cacheError(join(into, "c"), projects, archive, [repo])).toMatch(/inside the repository/);
  });

  test("refuses a file at the cache path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lgtm-llm-cache-file-"));
    temps.push(tmp);
    const file = join(tmp, "not-a-dir");
    writeFileSync(file, "x");
    expect(cacheError(file, join(tmp, "p"), join(tmp, "a"), [join(tmp, "repo")])).toMatch(/not a directory/);
  });
});

function cacheError(cacheDir: string, projectsDir: string, archiveDir: string, repoDirs: readonly string[]): string {
  const got = resolveTitleCacheDir(cacheDir, projectsDir, archiveDir, repoDirs);
  if (!("error" in got)) throw new Error(`expected an error, got ${got.dir}`);
  return got.error;
}

describe("CLI llm flags", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  function layout(): { repo: string; projects: string; archive: string; cache: string; home: string } {
    const tmp = mkdtempSync(join(tmpdir(), "lgtm-llm-cli-"));
    temps.push(tmp);
    const repo = join(tmp, "repo");
    const projects = join(tmp, "projects");
    const archive = join(tmp, "archive");
    const home = join(tmp, "home");
    mkdirSync(repo);
    mkdirSync(projects);
    mkdirSync(archive);
    mkdirSync(home);
    return { repo, projects, archive, cache: join(tmp, "titles"), home };
  }

  test("--help and --version win, and help documents the flags", () => {
    const help = run(["--help", "--llm-url", "http://10.0.0.1", "--llm-model", ""]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--llm-url");
    expect(help.stdout).toContain("--llm-model");
    expect(help.stdout).toContain("--llm-cache-dir");
    expect(help.stdout).toMatch(/loopback/i);

    const version = run(["--version", "--llm-url", "http://10.0.0.1", "--llm-model", "x"]);
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/^lgtm-review \d+\.\d+\.\d+/);
    expect(version.stderr).not.toContain("loopback");
  });

  test("one flag without the other, an empty model, or --llm-cache-dir alone => exit 1", () => {
    const onlyUrl = run(["--llm-url", "http://127.0.0.1:9", "--no-open"]);
    expect(onlyUrl.status).toBe(1);
    expect(onlyUrl.stderr).toContain("--llm-url and --llm-model must be given together");

    const onlyModel = run(["--llm-model", "qwen3:4b", "--no-open"]);
    expect(onlyModel.status).toBe(1);
    expect(onlyModel.stderr).toContain("--llm-url and --llm-model must be given together");

    const empty = run(["--llm-url", "http://127.0.0.1:9", "--llm-model", "  ", "--no-open"]);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("--llm-model needs a model name");

    const cacheOnly = run(["--llm-cache-dir", "/tmp/titles", "--no-open"]);
    expect(cacheOnly.status).toBe(1);
    expect(cacheOnly.stderr).toContain("--llm-cache-dir only works with --llm-url");

    const emptyCache = run(["--llm-url", "http://127.0.0.1:9", "--llm-model", "qwen", "--llm-cache-dir", "", "--no-open"]);
    expect(emptyCache.status).toBe(1);
    expect(emptyCache.stderr).toContain("--llm-cache-dir needs a directory path");
  });

  test.each(["--list", "--json", "--summary", "--export", "--archive"])("cannot combine with %s", (flag) => {
    const { repo, projects, archive } = layout();
    const extra = flag === "--export" ? ["--export", "abc"] : [flag];
    const r = run([
      ...extra,
      "--llm-url",
      "http://127.0.0.1:9",
      "--llm-model",
      "qwen3:4b",
      "--no-worktrees",
      "--dir",
      repo,
      "--projects-dir",
      projects,
      "--archive-dir",
      archive,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--llm-url cannot be combined with --list, --json, --summary, --export or --archive");
    expect(r.stdout).toBe("");
  });

  test("a non-loopback URL exits 1 and does not start", () => {
    const { repo, projects, archive } = layout();
    const r = run([
      "--llm-url",
      "http://192.168.1.2:11434",
      "--llm-model",
      "qwen3:4b",
      "--no-open",
      "--no-worktrees",
      "--dir",
      repo,
      "--projects-dir",
      projects,
      "--archive-dir",
      archive,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("only a loopback model server is allowed");
    expect(r.stdout).toBe("");
  });

  test("cache dir inside the repo, projects dir, archive dir, or a symlink exits 1 and is not created", () => {
    const { repo, projects, archive, home } = layout();
    const base = ["--llm-url", "http://127.0.0.1:9", "--llm-model", "qwen3:4b", "--no-open", "--no-worktrees", "--dir", repo, "--projects-dir", projects, "--archive-dir", archive];

    const insideRepo = join(repo, "nested", "titles");
    let r = run([...base, "--llm-cache-dir", insideRepo], { HOME: home });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("inside the repository");
    expect(existsSync(join(repo, "nested"))).toBe(false);

    r = run([...base, "--llm-cache-dir", join(projects, "titles")], { HOME: home });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("projects dir");

    r = run([...base, "--llm-cache-dir", join(archive, "titles")], { HOME: home });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("archive dir");

    const outside = join(home, "outside");
    mkdirSync(outside);
    const link = join(home, "link");
    symlinkSync(outside, link);
    r = run([...base, "--llm-cache-dir", link], { HOME: home });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("symlink");
    expect(existsSync(join(home, ".lgtm-review", "cache", "titles"))).toBe(false);
  });

  test("server mode prints one startup line with the canonical endpoint and does not create the cache", async () => {
    const { repo, projects, archive, cache, home } = layout();
    const child = spawn(
      "node",
      [
        cli,
        "--llm-url",
        "http://localhost:11434/v1",
        "--llm-model",
        "qwen3:4b",
        "--llm-cache-dir",
        cache,
        "--no-open",
        "--port",
        "0",
        "--no-worktrees",
        "--dir",
        repo,
        "--projects-dir",
        projects,
        "--archive-dir",
        archive,
      ],
      { env: { ...process.env, CI: "1", HOME: home } },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(`no startup line\nstdout=${stdout}\nstderr=${stderr}`));
        }, 8000);
        const ready = () => {
          if (settled) return;
          if (!/LLM titles:/.test(stderr)) return;
          if (!/^http:\/\/127\.0\.0\.1:\d+\/#k=[0-9a-f]{64}$/m.test(stdout)) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        child.stdout.on("data", (d) => {
          stdout += d;
          ready();
        });
        child.stderr.on("data", (d) => {
          stderr += d;
          ready();
        });
        child.on("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`exited ${code}\nstdout=${stdout}\nstderr=${stderr}`));
        });
      });
      const line = stderr.split("\n").find((l) => l.startsWith("LLM titles:"));
      expect(line).toBe(
        `LLM titles: condensed, redacted prompt actions go to http://127.0.0.1:11434/v1/chat/completions (model qwen3:4b); cache ${join(realpathSync(dirname(cache)), "titles")}`,
      );
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(existsSync(cache)).toBe(false);
      expect(existsSync(join(home, ".lgtm-review", "cache", "titles"))).toBe(false);
    } finally {
      child.kill("SIGINT");
      await exited;
    }
  });

  test("without the flags, list mode does not create the cache dir or print the startup line", () => {
    const { repo, projects, archive, home } = layout();
    const r = run(["--list", "--no-worktrees", "--dir", repo, "--projects-dir", projects, "--archive-dir", archive], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("LLM titles:");
    expect(existsSync(join(home, ".lgtm-review"))).toBe(false);
  });
});

interface Hit {
  method: string;
  url: string;
  host: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Fake {
  hits: Hit[];
  port: number;
  close(): Promise<void>;
}

function chatJson(content: string): string {
  return JSON.stringify({ id: "t", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
}

function mustUrl(s: string): URL {
  const u = parseLlmUrl(s);
  if (u instanceof Error) throw u;
  return u;
}

/** Loopback model stand-in. `onHit` sees the full body; it must respond, hang, or close. */
async function startFake(host: string, onHit: (hit: Hit, res: ServerResponse) => void): Promise<Fake> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit: Hit = {
        method: req.method ?? "",
        url: req.url ?? "",
        host: String(req.headers.host ?? ""),
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
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
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("fake server has no port");
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

function reply(res: ServerResponse, status: number, body: string | Buffer, extra: Record<string, string> = {}): void {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": buf.length,
    connection: "close",
    ...extra,
  });
  res.end(buf);
}

function ok(res: ServerResponse, content = "Shipped the parser"): void {
  reply(res, 200, chatJson(content));
}

describe("createTitler", () => {
  const temps: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  function scratch(): string {
    const d = mkdtempSync(join(tmpdir(), "lgtm-titler-"));
    temps.push(d);
    return d;
  }

  async function fake(onHit: (hit: Hit, res: ServerResponse) => void = (_hit, res) => ok(res), host = "127.0.0.1"): Promise<Fake> {
    const f = await startFake(host, onHit);
    closers.push(() => f.close());
    return f;
  }

  function titler(endpoint: URL, cacheDir: string, extra: { timeoutMs?: number; maxRequests?: number } = {}): Titler {
    return createTitler({ endpoint, model: "qwen3:4b", cacheDir, timeoutMs: extra.timeoutMs ?? 2000, ...extra });
  }

  function load(input: string, redact: TitleSource["redact"] = {}): (index: number) => Promise<TitleSource> {
    return async () => ({ input, redact });
  }

  function loadN(n: number, prefix = "p", redact: TitleSource["redact"] = {}): (index: number) => Promise<TitleSource> {
    return async (index) => ({ input: `${prefix}-${index}`, redact });
  }

  test("titleCacheKey is the version, model and input", () => {
    expect(titleCacheKey("m", "in")).toBe(createHash("sha256").update(`${TITLE_PROMPT_VERSION}\0m\0in`).digest("hex"));
    expect(TITLE_REQUEST_CAP).toBe(500);
    expect(TITLE_TIMEOUT_MS).toBe(60_000);
    expect(TITLE_BODY_CAP).toBe(64 * 1024);
    expect(TITLE_FAILURE_LIMIT).toBe(3);
  });

  test("posts titleRequestBody, sanitises the title, and reuses a 0600 cache file", async () => {
    const dir = join(scratch(), "cache");
    const seen = await fake((_hit, res) => ok(res, "<think>hidden chain</think>\nTitle: **Shipped the parser**\n"));
    const endpoint = mustUrl(`http://127.0.0.1:${seen.port}/v1`);
    const input = "Fix the add function";
    const first = titler(endpoint, dir);
    expect(existsSync(dir)).toBe(false);
    first.enqueue("s", "1", [0], load(input));
    await first.settled();

    expect(seen.hits).toHaveLength(1);
    const hit = seen.hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/v1/chat/completions");
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.host.startsWith("127.0.0.1:")).toBe(true);
    expect(JSON.parse(hit.body)).toEqual(titleRequestBody("qwen3:4b", input));
    expect(first.view("s")).toEqual({ titles: { "0": "Shipped the parser" }, pending: 0, error: null });

    const entries = readdirSync(dir, { withFileTypes: true });
    expect(entries.every((e) => e.isFile() && e.name.endsWith(".json"))).toBe(true);
    expect(entries).toHaveLength(1);
    const file = join(dir, entries[0]!.name);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { v: number; title: string };
    expect(stored).toEqual({ v: 1, title: "Shipped the parser" });
    expect(readFileSync(file, "utf8")).not.toContain("hidden");

    const second = titler(endpoint, dir);
    second.enqueue("s", "1", [0], load(input));
    await second.settled();
    expect(seen.hits).toHaveLength(1);
    expect(second.view("s").titles["0"]).toBe("Shipped the parser");
  });

  test("canonical loopback forms are requested on the normalised host", async () => {
    const seen = await fake();
    const forms = ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "localhost"];
    for (const form of forms) {
      const before = seen.hits.length;
      const endpoint = mustUrl(`http://${form}:${seen.port}/v1`);
      expect(endpoint.hostname).toBe("127.0.0.1");
      const t = titler(endpoint, join(scratch(), form));
      t.enqueue("s", form, [0], load(`in-${form}`));
      await t.settled();
      expect(seen.hits.length - before).toBe(1);
      const host = seen.hits.at(-1)!.host;
      expect(host.startsWith("127.0.0.1:")).toBe(true);
      expect(host.toLowerCase()).not.toContain("localhost");
      expect(host).not.toContain(form === "localhost" ? "localhost" : form);
    }

    const direct = titler(new URL(`http://localhost:${seen.port}/v1/chat/completions`), join(scratch(), "direct-localhost"));
    direct.enqueue("s", "1", [0], load("direct"));
    await direct.settled();
    const host = seen.hits.at(-1)!.host;
    expect(host.startsWith("127.0.0.1:")).toBe(true);
    expect(host.toLowerCase()).not.toContain("localhost");
  });

  test("compressed IPv6 loopback is requested as [::1]", async () => {
    let v6: Fake;
    try {
      v6 = await fake((_hit, res) => ok(res), "::1");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      expect(["EAFNOSUPPORT", "EADDRNOTAVAIL"]).toContain(code);
      return;
    }
    for (const form of ["[0::1]", "[0:0:0:0:0:0:0:1]"]) {
      const before = v6.hits.length;
      const endpoint = mustUrl(`http://${form}:${v6.port}/v1`);
      expect(endpoint.hostname === "[::1]" || endpoint.hostname === "::1").toBe(true);
      const t = titler(endpoint, join(scratch(), form.replaceAll(":", "").replaceAll("[", "").replaceAll("]", "")));
      t.enqueue("s", form, [0], load(`v6-${form}`));
      await t.settled();
      expect(v6.hits.length - before).toBe(1);
      expect(v6.hits.at(-1)!.host).toBe(`[::1]:${v6.port}`);
    }
  });

  test("HTTP_PROXY is ignored and the model server still receives the request", async () => {
    const model = await fake();
    const proxy = await fake((_hit, res) => reply(res, 200, "PROXY"));
    const keys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"];
    const saved = new Map(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      const proxyUrl = `http://127.0.0.1:${proxy.port}`;
      process.env.HTTP_PROXY = proxyUrl;
      process.env.http_proxy = proxyUrl;
      process.env.HTTPS_PROXY = proxyUrl;
      process.env.https_proxy = proxyUrl;
      process.env.NODE_USE_ENV_PROXY = "1";
      const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"));
      t.enqueue("s", "1", [0], load("proxied"));
      await t.settled();
      expect(model.hits).toHaveLength(1);
      expect(model.hits[0]!.url).toBe("/v1/chat/completions");
      expect(proxy.hits).toHaveLength(0);
      expect(t.view("s").titles["0"]).toBe("Shipped the parser");
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("a redirect is an error and the Location is not requested", async () => {
    const other = await fake();
    const model = await fake((_hit, res) => reply(res, 302, "SECRET_REDIRECT", { Location: `http://127.0.0.1:${other.port}/stolen` }));
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"));
    t.enqueue("s", "1", [0, 1, 2, 3], loadN(4));
    await t.settled();
    expect(model.hits).toHaveLength(3);
    expect(other.hits).toHaveLength(0);
    const view = t.view("s");
    expect(view.error).toBe(TITLE_ERR_RESPONSE);
    expect(view.pending).toBe(0);
    expect(JSON.stringify(view)).not.toContain("SECRET_REDIRECT");
    expect(view.titles).toEqual({});
  });

  test("a hung server times out, drains the queue, and does not send the next prompt", async () => {
    const model = await fake(() => {});
    const behind = await fake();
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"), { timeoutMs: 200 });
    t.enqueue("a", "1", [0, 1, 2, 3], loadN(4, "a"));
    t.enqueue("b", "1", [0], load("session-b-only", {}));
    await t.settled();
    expect(model.hits).toHaveLength(3);
    expect(model.hits.every((h) => !h.body.includes("session-b-only"))).toBe(true);
    expect(behind.hits).toHaveLength(0);
    expect(t.view("a").error).toBe(TITLE_ERR_UNREACHABLE);
    expect(t.view("a").pending).toBe(0);
    expect(t.view("b")).toEqual({ titles: {}, pending: 0, error: TITLE_ERR_UNREACHABLE });
    expect(JSON.stringify(t.view("a"))).not.toContain("SECRET");
  });

  test("a body over 64 KiB is an error and its text is not kept", async () => {
    const secret = "SECRET_OVERSIZE";
    const blob = Buffer.alloc(TITLE_BODY_CAP + 1, 0x61);
    blob.write(secret);
    const dir = join(scratch(), "cache");
    const model = await fake((_hit, res) => reply(res, 200, blob));
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    t.enqueue("s", "1", [0, 1, 2], loadN(3));
    await t.settled();
    expect(model.hits).toHaveLength(3);
    const view = t.view("s");
    expect(view.error).toBe(TITLE_ERR_RESPONSE);
    expect(view.pending).toBe(0);
    expect(view.titles).toEqual({});
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(existsSync(dir)).toBe(false);
  });

  test("a 200 that is not OpenAI-shaped is a failure and is not copied into the error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = JSON.stringify({ ok: true, secret: "SECRET_SHAPE_BODY", choices: "nope" });
      const model = await fake((_hit, res) => reply(res, 200, body));
      const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"));
      t.enqueue("s", "1", [0, 1, 2, 3], loadN(4));
      await t.settled();
      expect(model.hits).toHaveLength(3);
      const view = t.view("s");
      expect(view.error).toBe(TITLE_ERR_RESPONSE);
      expect(view.pending).toBe(0);
      expect(JSON.stringify(view)).not.toContain("SECRET_SHAPE_BODY");
      const dumped = [...log.mock.calls, ...err.mock.calls].map((c) => c.map((x) => String(x)).join(" ")).join("\n");
      expect(dumped).not.toContain("SECRET_SHAPE_BODY");

      const nested = JSON.stringify({ choices: [{ message: { content: { secret: "SECRET_SHAPE_NESTED" } } }] });
      const model2 = await fake((_hit, res) => reply(res, 200, nested));
      const t2 = titler(mustUrl(`http://127.0.0.1:${model2.port}/v1`), join(scratch(), "cache2"));
      t2.enqueue("s", "1", [0, 1, 2], loadN(3, "n"));
      await t2.settled();
      expect(t2.view("s").error).toBe(TITLE_ERR_RESPONSE);
      expect(JSON.stringify(t2.view("s"))).not.toContain("SECRET_SHAPE_NESTED");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test("three HTTP failures stop the queue and omit the body", async () => {
    const model = await fake((_hit, res) => reply(res, 500, "SECRET_FAIL_BODY"));
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"));
    t.enqueue("s", "1", [0, 1, 2, 3], async (index) => ({ input: `same-${index}`, redact: {} }));
    await t.settled();
    expect(model.hits).toHaveLength(3);
    expect(t.view("s").error).toBe(TITLE_ERR_RESPONSE);
    expect(t.view("s").pending).toBe(0);
    expect(JSON.stringify(t.view("s"))).not.toContain("SECRET_FAIL_BODY");
    expect(existsSync(join(scratch(), "cache"))).toBe(false);
  });

  test("the same failing input is requested again until the breaker trips", async () => {
    const model = await fake((_hit, res) => reply(res, 500, "nope"));
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"));
    t.enqueue("s", "1", [0, 1, 2], load("same-input"));
    await t.settled();
    expect(model.hits).toHaveLength(3);
    expect(t.view("s").error).toBe(TITLE_ERR_RESPONSE);
  });

  test("an empty sanitised title is a miss, resets the failure counter, and is not cached", async () => {
    let n = 0;
    const plan = [
      () => ({ status: 500, body: "SECRET_FAIL_BODY" }),
      () => ({ status: 500, body: "SECRET_FAIL_BODY" }),
      () => ({ status: 200, body: chatJson("<think>x</think>") }),
      () => ({ status: 500, body: "SECRET_FAIL_BODY" }),
      () => ({ status: 500, body: "SECRET_FAIL_BODY" }),
      () => ({ status: 500, body: "SECRET_FAIL_BODY" }),
    ];
    const model = await fake((_hit, res) => {
      const step = plan[n++];
      if (!step) {
        reply(res, 200, chatJson("should-not-run"));
        return;
      }
      const r = step();
      reply(res, r.status, r.body);
    });
    const dir = join(scratch(), "cache");
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    t.enqueue("s", "1", [0, 1, 2, 3, 4, 5, 6], loadN(7));
    await t.settled();
    expect(model.hits).toHaveLength(6);
    expect(t.view("s").error).toBe(TITLE_ERR_RESPONSE);
    expect(t.view("s").pending).toBe(0);
    expect(t.view("s").titles).toEqual({});
    expect(JSON.stringify(t.view("s"))).not.toContain("SECRET_FAIL_BODY");
    expect(existsSync(dir)).toBe(false);
  });

  test("a real title resets the failure counter and is cached", async () => {
    let n = 0;
    const model = await fake((_hit, res) => {
      n += 1;
      if (n === 3) ok(res, "Shipped the parser");
      else reply(res, 500, "SECRET_FAIL_BODY");
    });
    const dir = join(scratch(), "cache");
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    t.enqueue("s", "1", [0, 1, 2, 3, 4, 5, 6], loadN(7, "reset"));
    await t.settled();
    expect(model.hits).toHaveLength(6);
    expect(t.view("s").titles["2"]).toBe("Shipped the parser");
    expect(t.view("s").error).toBe(TITLE_ERR_RESPONSE);
    expect(existsSync(dir)).toBe(true);
    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(raw).toContain("Shipped the parser");
    expect(raw).not.toContain("SECRET_FAIL_BODY");
  });

  test("the request cap drains the queue without sending another request", async () => {
    const model = await fake();
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"), { maxRequests: 2 });
    t.enqueue("s", "1", [0, 1, 2], loadN(3, "cap"));
    await t.settled();
    expect(model.hits).toHaveLength(2);
    const view = t.view("s");
    expect(view.titles["0"]).toBe("Shipped the parser");
    expect(view.titles["1"]).toBe("Shipped the parser");
    expect(view.titles["2"]).toBeUndefined();
    expect(view.pending).toBe(0);
    expect(view.error).toBe(TITLE_ERR_RESPONSE);
  });

  test("one request serves two prompts with the same input, and different inputs stay sequential", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let open!: () => void;
    const opened = new Promise<void>((r) => {
      open = r;
    });
    let live = 0;
    let max = 0;
    const model = await fake((_hit, res) => {
      live += 1;
      max = Math.max(max, live);
      if (model.hits.length === 1) open();
      void held.then(() => {
        live -= 1;
        ok(res);
      });
    });
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"));
    t.enqueue("s", "1", [0, 1], load("same"));
    await opened;
    expect(model.hits).toHaveLength(1);
    expect(t.view("s").pending).toBe(2);
    release();
    await t.settled();
    expect(model.hits).toHaveLength(1);
    expect(t.view("s").titles).toEqual({ "0": "Shipped the parser", "1": "Shipped the parser" });

    let release2!: () => void;
    const held2 = new Promise<void>((r) => {
      release2 = r;
    });
    let open2!: () => void;
    const opened2 = new Promise<void>((r) => {
      open2 = r;
    });
    live = 0;
    max = 0;
    const model2 = await fake((_hit, res) => {
      live += 1;
      max = Math.max(max, live);
      if (model2.hits.length === 1) open2();
      void held2.then(() => {
        live -= 1;
        ok(res);
      });
    });
    const t2 = titler(mustUrl(`http://127.0.0.1:${model2.port}/v1`), join(scratch(), "cache2"));
    t2.enqueue("s", "1", [0, 1], loadN(2, "diff"));
    await opened2;
    expect(model2.hits).toHaveLength(1);
    expect(max).toBe(1);
    expect(t2.view("s").pending).toBe(2);
    release2();
    await t2.settled();
    expect(model2.hits).toHaveLength(2);
    expect(max).toBe(1);
    expect(t2.view("s").pending).toBe(0);
  });

  test("enqueueing the same stamp twice does not send a second request", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let open!: () => void;
    const opened = new Promise<void>((r) => {
      open = r;
    });
    const model = await fake((_hit, res) => {
      open();
      void held.then(() => ok(res));
    });
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"));
    t.enqueue("s", "1", [0], load("once"));
    await opened;
    t.enqueue("s", "1", [0], load("once"));
    release();
    await t.settled();
    expect(model.hits).toHaveLength(1);
    expect(t.view("s").titles["0"]).toBe("Shipped the parser");
  });

  test("a null or throwing loader makes no request and does not create the cache", async () => {
    const model = await fake();
    const dir = join(scratch(), "cache");
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    t.enqueue("s", "1", [0, 1], async () => null);
    await t.settled();
    expect(model.hits).toHaveLength(0);
    expect(existsSync(dir)).toBe(false);
    expect(t.view("s")).toEqual({ titles: {}, pending: 0, error: null });

    const dir2 = join(scratch(), "cache2");
    const t2 = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir2);
    t2.enqueue("s", "1", [0], async () => {
      throw new Error("boom");
    });
    await t2.settled();
    expect(model.hits).toHaveLength(0);
    expect(existsSync(dir2)).toBe(false);
    expect(t2.view("s").error).toBeNull();
  });

  test("the sanitised title is redacted again before it is cached or returned", async () => {
    const dirty = "alice used sk-ant-api03-abcdefghij123 in /home/user/project/src/a.ts";
    const model = await fake((_hit, res) => ok(res, dirty));
    const dir = join(scratch(), "cache");
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    t.enqueue("s", "1", [0], load("in", { repoDir: "/home/user/project", usernames: ["alice"] }));
    await t.settled();
    const title = t.view("s").titles["0"] ?? "";
    expect(title).toContain("[redacted:anthropic-key]");
    expect(title).toContain("<repo>");
    expect(title).toContain("<user>");
    expect(title).not.toContain("sk-ant-api03-abcdefghij123");
    expect(title).not.toContain("/home/user/project");
    expect(title).not.toContain("alice");
    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(raw).not.toContain("sk-ant-api03-abcdefghij123");
    expect(raw).not.toContain("/home/user/project");
    expect(raw).not.toContain("alice");
    expect(raw).toContain("[redacted:anthropic-key]");
  });

  test("a non-loopback endpoint is not contacted", async () => {
    const model = await fake();
    const t = titler(new URL(`http://10.0.0.1:${model.port}/v1/chat/completions`), join(scratch(), "cache"), { timeoutMs: 200 });
    const started = Date.now();
    t.enqueue("s", "1", [0, 1, 2], loadN(3, "remote"));
    await t.settled();
    expect(Date.now() - started).toBeLessThan(400);
    expect(model.hits).toHaveLength(0);
    expect(t.view("s").error).toBe(TITLE_ERR_UNREACHABLE);
    expect(t.view("s").pending).toBe(0);
  });

  test("a cache hit between failures does not reset the counter", async () => {
    const dir = join(scratch(), "cache");
    mkdirSync(dir);
    const modelName = "qwen3:4b";
    const kept = "Kept from disk";
    writeFileSync(join(dir, `${titleCacheKey(modelName, "c")}.json`), JSON.stringify({ v: 1, title: kept }));
    const model = await fake((_hit, res) => reply(res, 500, "SECRET_FAIL_BODY"));
    const t = createTitler({ endpoint: mustUrl(`http://127.0.0.1:${model.port}/v1`), model: modelName, cacheDir: dir, timeoutMs: 2000 });
    const inputs = ["a", "b", "c", "d", "e"];
    t.enqueue("s", "1", [0, 1, 2, 3, 4], async (index) => ({ input: inputs[index]!, redact: {} }));
    await t.settled();
    expect(model.hits.map((h) => JSON.parse(h.body).messages[1].content)).toEqual(["a", "b", "d"]);
    expect(t.view("s").titles["2"]).toBe(kept);
    expect(t.view("s").error).toBe(TITLE_ERR_RESPONSE);
    expect(t.view("s").pending).toBe(0);
    expect(JSON.stringify(t.view("s"))).not.toContain("SECRET_FAIL_BODY");
  });

  test("a changed stamp reads the disk cache and does not request again", async () => {
    const dir = join(scratch(), "cache");
    const model = await fake();
    const endpoint = mustUrl(`http://127.0.0.1:${model.port}/v1`);
    const first = titler(endpoint, dir);
    first.enqueue("s", "stamp-a", [0], load("stable-input"));
    await first.settled();
    expect(model.hits).toHaveLength(1);

    const second = titler(endpoint, dir);
    second.enqueue("s", "stamp-b", [0], load("stable-input"));
    const mid = second.view("s");
    expect(mid.pending).toBe(1);
    expect(mid.titles).toEqual({});
    await second.settled();
    expect(model.hits).toHaveLength(1);
    expect(second.view("s").titles["0"]).toBe("Shipped the parser");
  });

  test.each([
    ["truncated json", "{"],
    ["wrong version", JSON.stringify({ v: 2, title: "Hello" })],
    ["extra key", JSON.stringify({ v: 1, title: "Hello", extra: 1 })],
    ["unstable title", JSON.stringify({ v: 1, title: "Title: Hello" })],
    ["oversize file", "x".repeat(1025)],
  ])("corrupt cache (%s) is ignored and fetched again", async (_name, content) => {
    const dir = join(scratch(), "cache");
    mkdirSync(dir, { mode: 0o700 });
    const input = "prompt text";
    writeFileSync(join(dir, `${titleCacheKey("qwen3:4b", input)}.json`), content);
    const model = await fake();
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    t.enqueue("s", "1", [0], load(input));
    await t.settled();
    expect(model.hits).toHaveLength(1);
    expect(t.view("s").titles["0"]).toBe("Shipped the parser");
    const raw = readFileSync(join(dir, `${titleCacheKey("qwen3:4b", input)}.json`), "utf8");
    expect(JSON.parse(raw)).toEqual({ v: 1, title: "Shipped the parser" });
    expect(statSync(join(dir, `${titleCacheKey("qwen3:4b", input)}.json`)).mode & 0o777).toBe(0o600);
  });

  test("a symlink cache file is not followed or replaced", async () => {
    const root = scratch();
    const dir = join(root, "cache");
    mkdirSync(dir, { mode: 0o700 });
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "KEEP");
    const input = "prompt text";
    const dest = join(dir, `${titleCacheKey("qwen3:4b", input)}.json`);
    symlinkSync(outside, dest);
    const model = await fake();
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    t.enqueue("s", "1", [0], load(input));
    await t.settled();
    expect(model.hits).toHaveLength(1);
    expect(t.view("s").titles["0"]).toBe("Shipped the parser");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("KEEP");
  });

  test("stamp change keeps ready titles for an unchanged key", async () => {
    const model = await fake((_hit, res) => {
      const input = JSON.parse(_hit.body).messages[1].content as string;
      ok(res, input === "changed-later" ? "Rewrote the parser" : "Shipped the parser");
    });
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"));
    const source = (inputs: Record<number, string>) => async (index: number) => ({ input: inputs[index]!, redact: {} });
    t.enqueue("s", "a", [0, 1], source({ 0: "stable", 1: "also-stable" }));
    await t.settled();
    expect(model.hits).toHaveLength(2);
    const before = { ...t.view("s").titles };
    expect(before).toEqual({ "0": "Shipped the parser", "1": "Shipped the parser" });

    t.enqueue("s", "b", [0, 1], source({ 0: "stable", 1: "also-stable" }));
    const mid = t.view("s");
    expect(mid.titles["0"]).toBe(before["0"]);
    expect(mid.titles["1"]).toBe(before["1"]);
    expect(Object.keys(mid.titles).length).toBeGreaterThanOrEqual(Object.keys(before).length);
    await t.settled();
    expect(model.hits).toHaveLength(2);
    expect(t.view("s").titles).toEqual(before);
    expect(t.view("s").pending).toBe(0);

    t.enqueue("s", "c", [0, 1], source({ 0: "changed-later", 1: "also-stable" }));
    expect(t.view("s").titles["1"]).toBe(before["1"]);
    await t.settled();
    expect(model.hits).toHaveLength(3);
    expect(JSON.parse(model.hits[2]!.body).messages[1].content).toBe("changed-later");
    expect(t.view("s").titles["1"]).toBe("Shipped the parser");
    expect(t.view("s").titles["0"]).toBe("Rewrote the parser");
  });

  test("a null outcome is remembered for the run and is not written to disk", async () => {
    const dir = join(scratch(), "cache");
    const model = await fake((_hit, res) => ok(res, "<think>x</think>"));
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    const input = "nothing useful";
    const key = titleCacheKey("qwen3:4b", input);
    t.enqueue("s", "stamp-a", [0], load(input));
    await t.settled();
    expect(model.hits).toHaveLength(1);
    expect(t.view("s").titles).toEqual({});
    expect(existsSync(join(dir, `${key}.json`))).toBe(false);

    t.enqueue("s", "stamp-b", [0], load(input));
    await t.settled();
    expect(model.hits).toHaveLength(1);
    expect(t.view("s").titles).toEqual({});

    t.enqueue("other", "stamp-a", [3], load(input));
    await t.settled();
    expect(model.hits).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
    expect(t.view("s").error).toBeNull();
  });

  test("stop() aborts the in-flight request and drains the queue", async () => {
    let open!: () => void;
    const opened = new Promise<void>((r) => {
      open = r;
    });
    const model = await fake((_hit, res) => {
      res.on("error", () => {});
      open();
    });
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), join(scratch(), "cache"), { timeoutMs: 60_000 });
    t.enqueue("s", "1", [0, 1], loadN(2, "hung"));
    await opened;
    expect(model.hits).toHaveLength(1);
    await t.stop();
    expect(t.view("s").pending).toBe(0);
    expect(t.view("s").error).toBeNull();
    expect(model.hits).toHaveLength(1);
    t.enqueue("s", "2", [0], load("again"));
    await t.settled();
    expect(model.hits).toHaveLength(1);
  });

  test("a pre-existing cache directory keeps its mode", async () => {
    const dir = join(scratch(), "shared");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "mine.txt"), "keep");
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    const model = await fake();
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), dir);
    t.enqueue("s", "1", [0], load("mode"));
    await t.settled();
    expect(t.view("s").titles["0"]).toBe("Shipped the parser");
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dir, "mine.txt"), "utf8")).toBe("keep");
    const cacheFile = readdirSync(dir).find((name) => name.endsWith(".json"));
    expect(cacheFile).toBeDefined();
    expect(statSync(join(dir, cacheFile!)).mode & 0o777).toBe(0o600);
  });

  test("a symlink cache root is not followed", async () => {
    const root = scratch();
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    const model = await fake();
    const t = titler(mustUrl(`http://127.0.0.1:${model.port}/v1`), link);
    t.enqueue("s", "1", [0], load("via-link"));
    await t.settled();
    expect(model.hits).toHaveLength(1);
    expect(t.view("s").titles["0"]).toBe("Shipped the parser");
    expect(readdirSync(real)).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
