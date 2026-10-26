import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  // The fixtures reuse the same prompt uuids; make them unique per session (except the fork pair) so only the fork fixtures inherit.
  for (const f of readdirSync(fixtures).filter((f) => f.endsWith(".jsonl"))) {
    if (f.startsWith("fork-resume-")) copyFileSync(join(fixtures, f), join(pdir, f));
    else writeFileSync(join(pdir, f), readFileSync(join(fixtures, f), "utf8").replaceAll('"uuid":"', `"uuid":"${f}-`));
  }
  // Subagent transcripts live next to their session: `<id>/subagents/agent-*.jsonl` + `.meta.json`.
  for (const d of readdirSync(fixtures, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "__golden__")) {
    cpSync(join(fixtures, d.name), join(pdir, d.name), { recursive: true });
  }
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

  test("sessions with subagents: --list, --json and --summary show the merged result", () => {
    const list = run(["--list", "--projects-dir", projects, "--dir", PROJECT], { NO_COLOR: "1" });
    expect(list.status).toBe(0);
    const row = list.stdout.split("\n").find((l) => l.includes("Fix add and verify it."));
    expect(row, list.stdout).toBeDefined();
    const json = Analysis.parse(JSON.parse(run(["--list", "--projects-dir", projects, "--dir", PROJECT, "--json"]).stdout));
    const sub = json.sessions.find((x) => x.sessionId === "subagent-check");
    expect(sub?.prompts[0]?.status).toBe("checked");
    expect(sub?.prompts[0]?.partial).toBe(false);
    expect(sub?.prompts[0]?.reason).toContain("by subagent Run the test suite");
    const edits = json.sessions.find((x) => x.sessionId === "subagent-edits");
    expect(edits?.prompts[0]?.status).toBe("unchecked");
    expect(edits?.prompts[0]?.files.length).toBe(2);
    const missing = json.sessions.find((x) => x.sessionId === "subagent-missing");
    expect(missing?.prompts[0]?.partial).toBe(true);
    const sum = run(["--summary", "--session", "subagent-check", "--projects-dir", projects, "--dir", PROJECT]);
    expect(sum.status).toBe(0);
    expect(sum.stdout).toContain("1 prompt: 1 checked.");
    expect(sum.stdout).toContain("| 1 | checked | Skim | Fix add and verify it. | 1 | +1 -1 |");
    const sumEdits = run(["--summary", "--session", "subagent-edits", "--projects-dir", projects, "--dir", PROJECT]);
    expect(sumEdits.stdout).toContain("1 edit after last check (by subagent Implement multiply helper)");
  });

  test("no sessions => message, exit 0", () => {
    const r = run(["--list", "--projects-dir", projects, "--dir", "/home/user/other"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No Claude Code sessions found for /home/user/other");
  });

  test("--summary prints markdown for the newest session; --session picks one by prefix", () => {
    const r = run(["--summary", "--projects-dir", projects, "--dir", PROJECT]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^# Review summary/);
    expect(r.stdout).toContain("| # | Status | Review | Prompt | Files | +/- |");
    expect(r.stdout).toContain("heuristic");
    const one = run(["--summary", "--session", "hints-test", "--projects-dir", projects, "--dir", PROJECT]);
    expect(one.status).toBe(0);
    expect(one.stdout).toContain("# Review summary: Fix the add function so the tests pass.");
    expect(one.stdout).toContain("**high** `assertions-removed`: `tests/add.test.ts`");
    expect(one.stdout).not.toContain("Tests: 1 failed");
    const nt = run(["--summary", "--no-titles", "--session", "hints-test", "--projects-dir", projects, "--dir", PROJECT]);
    expect(nt.stdout).toContain("# Review summary\n");
    expect(nt.stdout).not.toContain("Fix the add function");
  });

  test("--summary with --list or --json => exit 1 with a message", () => {
    for (const other of ["--list", "--json"]) {
      const r = run(["--summary", other, "--projects-dir", projects, "--dir", PROJECT]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--summary cannot be combined with --list or --json");
      expect(r.stdout).toBe("");
    }
  });

  test("--summary: unknown or ambiguous session prefix, no sessions, and flags without --summary => exit 1", () => {
    expect(run(["--summary", "--session", "nope", "--projects-dir", projects, "--dir", PROJECT]).stderr).toContain('no session id starts with "nope"');
    const amb = run(["--summary", "--session", "h", "--projects-dir", projects, "--dir", PROJECT]);
    expect(amb.status).toBe(1);
    expect(amb.stderr).toContain("matches");
    expect(run(["--summary", "--projects-dir", projects, "--dir", "/home/user/other"]).status).toBe(1);
    expect(run(["--list", "--no-titles", "--projects-dir", projects, "--dir", PROJECT]).status).toBe(1);
    expect(run(["--list", "--session", "x", "--projects-dir", projects, "--dir", PROJECT]).status).toBe(1);
    expect(run(["--summary", "--session", "../x", "--projects-dir", projects, "--dir", PROJECT]).status).toBe(1);
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

describe("built CLI, forked sessions", () => {
  let fprojects: string;
  beforeAll(() => {
    fprojects = join(tmp, "fork-projects");
    const d = join(fprojects, "-home-user-project");
    mkdirSync(d, { recursive: true });
    for (const n of ["fork-resume-a", "fork-resume-b"]) copyFileSync(join(fixtures, `${n}.jsonl`), join(d, `${n}.jsonl`));
  });
  const fbase = () => ["--projects-dir", fprojects, "--dir", PROJECT];

  test("--json marks inherited prompts, counts are not doubled", () => {
    const json = Analysis.parse(JSON.parse(run(["--list", "--json", ...fbase()]).stdout));
    const b = json.sessions.find((x) => x.sessionId === "fork-resume-b")!;
    expect(b.prompts).toHaveLength(5);
    expect(b.prompts.filter((p) => p.inheritedFrom === "fork-resume-a")).toHaveLength(3);
    expect(json.sessions.find((x) => x.sessionId === "fork-resume-a")!.prompts.some((p) => p.inheritedFrom !== undefined)).toBe(false);
  });

  test("--list marks inherited prompts and counts only the new ones", () => {
    const r = run(["--list", ...fbase()], { NO_COLOR: "1" });
    expect(r.stdout).toContain("2 prompt(s): 2 checked (+3 inherited from fork-res)");
    expect(r.stdout.match(/\(inherited from fork-res\)/g)).toHaveLength(3);
  });

  test("--summary omits inherited rows", () => {
    const r = run(["--summary", "--session", "fork-resume-b", ...fbase()]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2 prompts: 2 checked.");
    expect(r.stdout).toContain("3 prompts inherited from fork-res omitted");
    expect(r.stdout).not.toContain("Fix prompt two.");
  });

  test("--export leaves inherited prompts out and adds a note", () => {
    const out = join(tmp, "fork-b.html");
    expect(run(["--export", "fork-resume-b", "--out", out, ...fbase()]).status).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("3 prompts inherited from fork-res omitted.");
    expect(html).not.toContain('id="p2"');
    expect(html).toContain('id="p4"');
  });
});

describe("built CLI, --export", () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "lgtm-cli-export-"));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const base = () => ["--projects-dir", projects, "--dir", PROJECT];
  const runIn = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync("node", [cli, ...args], { encoding: "utf8", cwd, env: { ...process.env, ...env } });

  test("writes the file, prints one line with the path and the redaction count", () => {
    const out = join(work, "a.html");
    const r = run(["--export", "hints-test", "--out", out, ...base()]);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}  \\(\\d+ redactions?\\)$`));
    const html = readFileSync(out, "utf8");
    expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">');
    expect(html).not.toMatch(/<script/i);
    for (const w of ["Checked", "Read flagged", "assertions-removed", "class=\"diff\"", "&lt;repo&gt;/"]) expect(html).toContain(w);
    expect(html).not.toContain("/home/user/project");
    expect(statSync(out).mode & 0o777).toBe(0o644);
    expect(readdirSync(work).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("--export of a session with a subagent shows the merged result and subagent steps", () => {
    const out = join(work, "sub.html");
    const r = run(["--export", "subagent-check", "--out", out, ...base()]);
    expect(r.status).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("Checked");
    expect(html).toContain("by subagent Run the test suite");
    expect(html).toContain("Subagent: ");
    expect(html).toContain('<span class="marker">subagent</span>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("partial: subagent activity not analysed");
  });

  test("does not overwrite without --force, overwrites with it", () => {
    const out = join(work, "b.html");
    writeFileSync(out, "precious");
    const r = run(["--export", "hints-test", "--out", out, ...base()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(r.stdout).toBe("");
    expect(readFileSync(out, "utf8")).toBe("precious");
    expect(readdirSync(work).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const f = run(["--export", "hints-test", "--out", out, "--force", ...base()]);
    expect(f.status).toBe(0);
    expect(readFileSync(out, "utf8")).toMatch(/^<!doctype html>/);
  });

  test("default file name is lgtm-review-<first 8 characters>.html in the current directory", () => {
    const cwd = realpathSync(mkdtempSync(join(work, "cwd-")));
    const r = runIn(cwd, ["--export", "hints-test", ...base()]);
    expect(r.status).toBe(0);
    expect(existsSync(join(cwd, "lgtm-review-hints-te.html"))).toBe(true);
    expect(r.stdout.startsWith(join(cwd, "lgtm-review-hints-te.html"))).toBe(true);
  });

  test("--no-diffs and --no-titles", () => {
    const out = join(work, "c.html");
    expect(run(["--export", "hints-test", "--out", out, "--no-diffs", "--no-titles", ...base()]).status).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).not.toContain('class="diff"');
    expect(html).not.toContain("Fix the add function");
    expect(html).toContain("Diffs are not included");
    expect(html).toContain("Steps (");
  });

  test.each([["--list"], ["--json"], ["--summary"], ["--session", "x"]])("--export with %s => exit 1 and nothing written", (...extra) => {
    const out = join(work, "never.html");
    const r = run(["--export", "hints-test", "--out", out, ...extra, ...base()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--export cannot be combined");
    expect(r.stdout).toBe("");
    expect(existsSync(out)).toBe(false);
  });

  test.each([["--out", "x.html"], ["--force"], ["--no-diffs"]])("%s without --export => exit 1", (...flags) => {
    const r = run([...flags, "--list", ...base()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("only work with --export");
  });

  test("unknown, ambiguous and malformed prefixes, other directory => exit 1", () => {
    const out = join(work, "d.html");
    expect(run(["--export", "nope", "--out", out, ...base()]).stderr).toContain('no session id starts with "nope"');
    const amb = run(["--export", "h", "--out", out, ...base()]);
    expect(amb.status).toBe(1);
    expect(amb.stderr).toContain("matches");
    expect(run(["--export", "../x", "--out", out, ...base()]).status).toBe(1);
    expect(run(["--export", "hints-test", "--out", out, "--projects-dir", projects, "--dir", "/home/user/other"]).status).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  test("secrets, user names and home paths of a session never reach the file", () => {
    const pdir = join(work, "projects2", "-home-user-project");
    mkdirSync(pdir, { recursive: true });
    const secret = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const pass = "hunter" + "2pass&word99";
    const sid = "11111111-1111-4111-8111-111111111111";
    const rec = (type: string, n: number, message: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ ...extra, type, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, sessionId: sid, timestamp: `2026-01-01T00:00:0${n}.000Z`, cwd: PROJECT, gitBranch: "main", version: "2.1.0", message });
    const lines = [
      rec("user", 1, { role: "user", content: `deploy with token ${secret} as zed-e2e-user from /home/zed-e2e-user/work` }),
      rec("assistant", 2, { role: "assistant", content: [{ type: "text", text: `Using ${secret}` }, { type: "tool_use", id: "t1", name: "Edit", input: { file_path: `${PROJECT}/.env`, old_string: "A=1", new_string: `API_URL=https://example.test\nDB_PASSWORD=${pass}\n` } }] }),
      rec("user", 3, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, {
        toolUseResult: { type: "update", filePath: `${PROJECT}/.env`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-A=1", "+API_URL=https://example.test", `+DB_PASSWORD=${pass}`] }] },
      }),
    ];
    writeFileSync(join(pdir, `${sid}.jsonl`), lines.join("\n") + "\n");
    const out = join(work, "secret.html");
    const r = run(["--export", "11111111", "--out", out, "--projects-dir", join(work, "projects2"), "--dir", PROJECT], { USER: "zed-e2e-user" });
    expect(r.status).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("class=\"diff\"");
    for (const leak of [secret, pass, "zed-e2e-user", "hunter", "example.test"]) expect(html, leak).not.toContain(leak);
    expect(html).toContain("~/work");
    expect(r.stdout).toMatch(/\((?:[3-9]|\d\d+) redactions\)$/m);
  });
});
