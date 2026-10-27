import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionRoot } from "@lgtm/core/node";
import { runExport, type ExportCommand } from "./export.js";

/** Synthetic session (no secrets), one user prompt that edits a file: same record shapes as in e2e.test.ts. */
const PROJECT = "/home/user/project";
const ID_LIVE = "55555555-5555-4555-8555-555555555555";
const ID_ARCHIVED = "88888888-8888-4888-8888-888888888888";
const ID_WT = "66666666-6666-4666-8666-666666666666";

const rec = (sid: string, type: string, n: number, message: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, type, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, sessionId: sid, timestamp: `2026-01-01T00:00:0${n}.000Z`, cwd: PROJECT, gitBranch: "main", version: "2.1.0", message });

const lines = (sid: string) => [
  rec(sid, "user", 1, { role: "user", content: "edit alpha.txt" }),
  rec(sid, "assistant", 2, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: `${PROJECT}/alpha.txt`, old_string: "A=1", new_string: "A=2\n" } }] }),
  rec(sid, "user", 3, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, {
    toolUseResult: { type: "update", filePath: `${PROJECT}/alpha.txt`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-A=1", "+A=2", "+"] }] },
  }),
];
const logGolden = () => Buffer.from(lines(ID_LIVE).join("\n") + "\n", "utf8");

let tmp = "";
let projects = "";
let pdir = "";
let archive = "";
let linkDir = "";
let pdir2 = "";
let adir2 = "";
let errors: string[];

const log = () => join(pdir, `${ID_LIVE}.jsonl`);
const roots = (): SessionRoot[] => [
  { dir: PROJECT, worktree: ".", projectDir: pdir, archiveDir: archive },
  { dir: join(tmp, "wt"), worktree: "wt", projectDir: pdir2, archiveDir: adir2 },
];

function cmd(out: string, opts: { force?: boolean; archiveDir?: boolean; roots?: boolean } = {}): ExportCommand {
  return {
    dir: PROJECT,
    projectsDir: projects,
    ...(opts.archiveDir || opts.roots ? { archiveDir: archive } : {}),
    ...(opts.roots ? { roots: roots() } : {}),
    prefix: "5",
    out,
    force: opts.force === true,
    diffs: true,
    titles: true,
  };
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-export-guard-")));
  projects = join(tmp, "projects");
  pdir = join(projects, "-home-user-project");
  archive = join(tmp, "archive", "-home-user-project");
  pdir2 = join(projects, "-tmp-lgtm-export-guard-wt");
  adir2 = join(tmp, "archive2", "-tmp-lgtm-export-guard-wt");
  mkdirSync(pdir, { recursive: true });
  mkdirSync(archive, { recursive: true });
  mkdirSync(pdir2, { recursive: true });
  mkdirSync(adir2, { recursive: true });
  symlinkSync(pdir, (linkDir = join(tmp, "link-to-project")));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  writeFileSync(log(), logGolden());
  writeFileSync(join(archive, `${ID_ARCHIVED}.jsonl`), lines(ID_ARCHIVED).join("\n") + "\n");
  writeFileSync(join(pdir2, `${ID_WT}.jsonl`), lines(ID_WT).join("\n") + "\n");
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
});

describe("runExport --out guard", () => {
  test("refuses --out equal to the session log with --force and leaves the log bytes unchanged", async () => {
    for (const r of [await runExport(cmd(log(), { force: true })), await runExport(cmd(log(), { force: false }))]) {
      expect(r).toBe(1);
      expect(errors.join("\n")).toContain("session log");
    }
    expect(errors.join("\n")).toContain(log());
    expect(readFileSync(log()).equals(logGolden())).toBe(true);
    expect(readdirSync(pdir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses --out inside the Claude projects directory, with and without --force", async () => {
    const out = join(pdir, "exported.html");
    for (const r of [await runExport(cmd(out, { force: true })), await runExport(cmd(out, { force: false }))]) {
      expect(r).toBe(1);
      expect(errors.join("\n")).toContain("Claude projects directory");
      expect(errors.join("\n")).toContain(realpathSync(projects));
    }
    expect(existsSync(out)).toBe(false);
  });

  test("follows a symlinked parent directory: --out through it onto the session log is refused", async () => {
    const r = await runExport(cmd(join(linkDir, `${ID_LIVE}.jsonl`), { force: true }));
    expect(r).toBe(1);
    expect(errors.join("\n")).toContain("session log");
    expect(readFileSync(log()).equals(logGolden())).toBe(true);
  });

  test("refuses --out through a symlinked parent into the projects dir", async () => {
    const out = join(linkDir, "exported.html");
    const r = await runExport(cmd(out));
    expect(r).toBe(1);
    expect(errors.join("\n")).toContain("Claude projects directory");
    expect(existsSync(out)).toBe(false);
  });

  test("refuses --out inside the archive directory", async () => {
    const out = join(archive, "exported.html");
    const r = await runExport(cmd(out, { archiveDir: true }));
    expect(r).toBe(1);
    expect(errors.join("\n")).toContain("archive directory");
    expect(existsSync(out)).toBe(false);
  });

  test("refuses --out inside another root's archive dir when several roots are read", async () => {
    const out = join(adir2, "exported.html");
    const r = await runExport(cmd(out, { roots: true }));
    expect(r).toBe(1);
    expect(errors.join("\n")).toContain("archive directory");
    expect(errors.join("\n")).toContain(realpathSync(adir2));
    expect(existsSync(out)).toBe(false);
  });

  test("refuses --out inside the projects dir even when the file name starts with '..'", async () => {
    const out = join(projects, "..exported.html");
    const r = await runExport(cmd(out));
    expect(r).toBe(1);
    expect(errors.join("\n")).toContain("Claude projects directory");
    expect(existsSync(out)).toBe(false);
  });

  test("still writes outside session storage", async () => {
    const out = join(tmp, "ok.html");
    const r = await runExport(cmd(out, { archiveDir: true }));
    expect(r).toBe(0);
    expect(errors).toEqual([]);
    expect(readFileSync(out, "utf8")).toMatch(/^<!doctype html>/);
    expect(readFileSync(out, "utf8")).toContain('class="diff"');
    expect(readdirSync(tmp).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
