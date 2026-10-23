import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Analysis } from "@lgtm/core";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");
const script = join(here, "../../../scripts/audit-status.mjs");
const fixtures = join(here, "../../core/fixtures/sessions");
const PROJECT = "/home/user/project";

let tmp: string;
let projects: string;

const audit = (args: string[]) => spawnSync("node", [script, "--projects-dir", projects, "--dir", PROJECT, ...args], { encoding: "utf8" });

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-audit-"));
  projects = join(tmp, "projects");
  const pdir = join(projects, "-home-user-project");
  mkdirSync(pdir, { recursive: true });
  for (const f of readdirSync(fixtures).filter((f) => f.endsWith(".jsonl"))) copyFileSync(join(fixtures, f), join(pdir, f));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("scripts/audit-status.mjs", () => {
  test("prints aggregates that match the CLI JSON, and nothing else", () => {
    const r = audit(["--json"]);
    expect(r.status).toBe(0);
    const agg = JSON.parse(r.stdout);
    const raw = spawnSync("node", [cli, "--list", "--json", "--projects-dir", projects, "--dir", PROJECT], { encoding: "utf8" });
    const a = Analysis.parse(JSON.parse(raw.stdout));
    const prompts = a.sessions.flatMap((s) => s.prompts);
    expect(agg.sessions).toBe(a.sessions.length);
    expect(agg.prompts).toBe(prompts.length);
    for (const s of ["checked", "unchecked", "failing", "no-changes"] as const) expect(agg.status[s]).toBe(prompts.filter((p) => p.status === s).length);
    expect(agg.shellEditPrompts).toBeGreaterThan(0);
    expect(agg.partial).toBe(prompts.filter((p) => p.partial).length);
    // Only numbers (and null percentages): no strings anywhere in the output.
    const strings: string[] = [];
    JSON.stringify(agg, (_k, v) => (typeof v === "string" && strings.push(v), v));
    expect(strings).toEqual([]);
  });

  test("text output carries counts, never prompt text, paths or reasons", () => {
    const r = audit([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^sessions: \d+ \(\d+ with prompts\)$/m);
    expect(r.stdout).toMatch(/^prompts: \d+$/m);
    expect(r.stdout).toMatch(/partial .*: \d+ \(\d/);
    expect(r.stdout).toMatch(/heuristic shell edits: \d+ \(/);
    expect(r.stdout).not.toContain("/home/user");
    expect(r.stdout).not.toContain("Port the tests");
    expect(r.stdout.trim().split("\n").length).toBeLessThanOrEqual(10);
  });

  test("an unreadable CLI is a short error, exit 1", () => {
    const r = spawnSync("node", [script, "--cli", join(tmp, "missing.js")], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
});
