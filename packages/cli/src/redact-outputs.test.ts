import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const PROJECT = "/home/user/project";
const NAME = "zqxuser";

let tmp: string;
let projects: string;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-cli-redact-")));
  projects = join(tmp, "projects");
  const pd = join(projects, "-home-user-project");
  mkdirSync(pd, { recursive: true });
  const base = { sessionId: "usr-1", cwd: PROJECT, version: "2.0.0" };
  const lines = [
    { ...base, type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `ask ${NAME} to review the notes` } },
    { ...base, type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ];
  writeFileSync(join(pd, "usr-1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("redacted CLI outputs (S-33)", () => {
  test("--summary replaces the OS user name with <user>", () => {
    const r = run(["--summary", "--projects-dir", projects, "--dir", PROJECT], { USER: NAME, LOGNAME: NAME, USERNAME: NAME });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("ask \\<user\\> to review");
    expect(r.stdout).not.toContain(NAME);
  });

  test("--json shows the repository directory as <repo>; --raw keeps it", () => {
    const red = JSON.parse(run(["--projects-dir", projects, "--dir", PROJECT, "--json"]).stdout) as { dir: string };
    expect(red.dir).toBe("<repo>");
    const raw = JSON.parse(run(["--projects-dir", projects, "--dir", PROJECT, "--json", "--raw"]).stdout) as { dir: string };
    expect(raw.dir).toBe(PROJECT);
    const none = JSON.parse(run(["--projects-dir", projects, "--dir", "/home/user/other", "--json"]).stdout) as { dir: string };
    expect(none.dir).toBe("<repo>");
  });

  test.each(["team@example.com", "password=hunter2secret"])("--json dir is <repo> even when the path contains %s", (part) => {
    const dir = join(tmp, part, "proj");
    mkdirSync(dir, { recursive: true });
    const r = run(["--projects-dir", projects, "--dir", dir, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { dir: string }).dir).toBe("<repo>");
  });
});
