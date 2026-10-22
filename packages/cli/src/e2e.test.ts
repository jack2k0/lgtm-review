import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Analysis } from "@lgtm/core";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");
const fixtures = join(here, "../../core/fixtures/sessions");
const PROJECT = "/home/user/project";

let tmp: string;
let projects: string;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-cli-e2e-"));
  projects = join(tmp, "projects");
  const pdir = join(projects, "-home-user-project");
  mkdirSync(pdir, { recursive: true });
  for (const f of readdirSync(fixtures).filter((f) => f.endsWith(".jsonl"))) copyFileSync(join(fixtures, f), join(pdir, f));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("built CLI", () => {
  test("--version", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^lgtm-review \d+\.\d+\.\d+/);
  });

  test("--list prints statuses for fixture sessions", () => {
    const r = run(["--list", "--projects-dir", projects, "--dir", PROJECT], { NO_COLOR: "1" });
    expect(r.status).toBe(0);
    for (const w of ["checked", "unchecked", "failing", "no-changes"]) expect(r.stdout).toContain(w);
    expect(r.stdout).not.toContain("\u001b[");
  });

  test("--json implies --list and matches --list --json byte for byte", () => {
    const a = run(["--projects-dir", projects, "--dir", PROJECT, "--json"]);
    const b = run(["--list", "--projects-dir", projects, "--dir", PROJECT, "--json"]);
    expect(a.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  test("--json matches the core schema", () => {
    const r = run(["--list", "--projects-dir", projects, "--dir", PROJECT, "--json"]);
    expect(r.status).toBe(0);
    const parsed = Analysis.parse(JSON.parse(r.stdout));
    expect(parsed.sessions.length).toBe(readdirSync(fixtures).filter((f) => f.endsWith(".jsonl")).length);
  });

  test("no sessions => message, exit 0", () => {
    const r = run(["--list", "--projects-dir", projects, "--dir", "/home/user/other"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No Claude Code sessions found for /home/user/other");
  });

  test("bad flag => exit 1", () => {
    expect(run(["--nope"]).status).toBe(1);
  });

  test.each(["abc", "-1", "70000", "1.5", ""])("invalid --port %j => exit 1", (p) => {
    const r = run(["--port", p, "--no-open", "--projects-dir", projects]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid --port|--port/);
  });
});

/** Starts the CLI in server mode; resolves with the printed URL. Always kill() the child. */
function startCli(args: string[]): Promise<{ url: string; stdout: () => string; kill: () => Promise<number | null> }> {
  const child = spawn("node", [cli, ...args], { env: { ...process.env, CI: "1" } });
  let out = "";
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no URL printed: ${out}`));
    }, 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /^(http:\/\/127\.0\.0\.1:\d+\/#k=[0-9a-f]{64})$/m.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({
          url: m[1]!,
          stdout: () => out,
          kill: () => {
            child.kill("SIGINT");
            return exited;
          },
        });
      }
    });
    child.on("exit", () => clearTimeout(timer));
  });
}

describe("built CLI, server mode", () => {
  test("prints the URL, enforces the token, serves sessions, exits 0 on SIGINT", async () => {
    const h = await startCli(["--no-open", "--port", "0", "--projects-dir", projects, "--dir", PROJECT]);
    try {
      const u = new URL(h.url);
      const token = u.hash.slice(3);
      expect(h.stdout().trim().split("\n")).toEqual([h.url]); // stdout carries only the URL
      expect((await fetch(`${u.origin}/api/sessions`)).status).toBe(403);
      const ok = await fetch(`${u.origin}/api/sessions`, { headers: { "X-Lgtm-Token": token } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { dir: string; sessions: unknown[] };
      expect(body.dir).toBe(PROJECT);
      expect(body.sessions.length).toBe(readdirSync(fixtures).filter((f) => f.endsWith(".jsonl")).length);
      expect([200, 404]).toContain((await fetch(`${u.origin}/`)).status); // 404 until the web app is bundled (phase 4)
    } finally {
      expect(await h.kill()).toBe(0);
    }
  });

  test("busy --port => exit 1 with a message", async () => {
    const h = await startCli(["--no-open", "--port", "0", "--projects-dir", projects]);
    try {
      const port = new URL(h.url).port;
      const r = run(["--no-open", "--port", port, "--projects-dir", projects]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`port ${port} is already in use`);
    } finally {
      await h.kill();
    }
  });
});
