import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { defaultTitleCacheDir, parseLlmUrl, resolveTitleCacheDir } from "./llm.js";

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
