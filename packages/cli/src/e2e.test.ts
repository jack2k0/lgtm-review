import { spawnSync } from "node:child_process";
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

  test("prints statuses for fixture sessions", () => {
    const r = run(["--projects-dir", projects, "--dir", PROJECT], { NO_COLOR: "1" });
    expect(r.status).toBe(0);
    for (const w of ["checked", "unchecked", "failing", "no-changes"]) expect(r.stdout).toContain(w);
    expect(r.stdout).not.toContain("\u001b[");
  });

  test("--json matches the core schema", () => {
    const r = run(["--projects-dir", projects, "--dir", PROJECT, "--json"]);
    expect(r.status).toBe(0);
    const parsed = Analysis.parse(JSON.parse(r.stdout));
    expect(parsed.sessions.length).toBe(readdirSync(fixtures).filter((f) => f.endsWith(".jsonl")).length);
  });

  test("no sessions => message, exit 0", () => {
    const r = run(["--projects-dir", projects, "--dir", "/home/user/other"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No Claude Code sessions found for /home/user/other");
  });

  test("bad flag => exit 1", () => {
    expect(run(["--nope"]).status).toBe(1);
  });
});
