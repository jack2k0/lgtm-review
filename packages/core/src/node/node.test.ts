import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeFile, discoverSessions, loadRepoScripts, projectDirFor } from "./index.js";
import { bash, edit, prompt, resetIds } from "../testing/records.js";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lgtm-core-node-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("projectDirFor", () => {
  test("replaces / and . with -", () => {
    expect(projectDirFor("/home/user/my.repo", "/p")).toBe("/p/-home-user-my-repo");
  });

  test("replaces underscore in path", () => {
    expect(projectDirFor("/home/user/my_repo", "/p")).toBe("/p/-home-user-my-repo");
  });

  test("replaces space in path", () => {
    expect(projectDirFor("/home/user/my repo", "/p")).toBe("/p/-home-user-my-repo");
  });

  test("replaces unicode characters in path", () => {
    expect(projectDirFor("/home/user/café", "/p")).toBe("/p/-home-user-caf-");
  });

  test("replaces + in path", () => {
    expect(projectDirFor("/home/user/repo+extra", "/p")).toBe("/p/-home-user-repo-extra");
  });

  test("strips trailing slash but keeps root slash", () => {
    expect(projectDirFor("/home/user/repo/", "/p")).toBe("/p/-home-user-repo");
    expect(projectDirFor("/", "/p")).toBe("/p/-");
  });

  test("path longer than 200 chars matches unique prefix in projectsDir", () =>
    withTmp((pdir) => {
      const longPath = "/home/user/" + "a".repeat(250);
      const sanitized = longPath.replace(/[^a-zA-Z0-9]/g, "-");
      const prefix = sanitized.slice(0, 200);
      mkdirSync(join(pdir, `${prefix}-hash123`));
      expect(projectDirFor(longPath, pdir)).toBe(join(pdir, `${prefix}-hash123`));
    }));

  test("path longer than 200 chars falls back when no matching dir exists", () =>
    withTmp((pdir) => {
      const longPath = "/home/user/" + "a".repeat(250);
      const sanitized = longPath.replace(/[^a-zA-Z0-9]/g, "-");
      const prefix = sanitized.slice(0, 200);
      expect(projectDirFor(longPath, pdir)).toBe(join(pdir, prefix));
    }));

  test("path longer than 200 chars falls back when two matching dirs exist", () =>
    withTmp((pdir) => {
      const longPath = "/home/user/" + "a".repeat(250);
      const sanitized = longPath.replace(/[^a-zA-Z0-9]/g, "-");
      const prefix = sanitized.slice(0, 200);
      mkdirSync(join(pdir, `${prefix}-hash1`));
      mkdirSync(join(pdir, `${prefix}-hash2`));
      expect(projectDirFor(longPath, pdir)).toBe(join(pdir, prefix));
    }));
});

describe("discoverSessions", () => {
  test("newest first, only top-level jsonl", () =>
    withTmp(async (dir) => {
      writeFileSync(join(dir, "old.jsonl"), "old");
      writeFileSync(join(dir, "new.jsonl"), "new");
      writeFileSync(join(dir, "notes.txt"), "");
      mkdirSync(join(dir, "old", "subagents"), { recursive: true });
      writeFileSync(join(dir, "old", "subagents", "agent-1.jsonl"), "");
      utimesSync(join(dir, "old.jsonl"), 1000, 1000);
      utimesSync(join(dir, "new.jsonl"), 2000, 2000);
      const found = await discoverSessions(dir);
      expect(found.map((f) => f.id)).toEqual(["new", "old"]);
    }));

  test("skips dotfiles and 0-byte files", () =>
    withTmp(async (dir) => {
      writeFileSync(join(dir, "empty.jsonl"), "");
      writeFileSync(join(dir, ".temp.jsonl"), "data");
      writeFileSync(join(dir, ".jsonl"), "data");
      writeFileSync(join(dir, "valid.jsonl"), "valid");
      const found = await discoverSessions(dir);
      expect(found.map((f) => f.id)).toEqual(["valid"]);
    }));

  test("missing dir rejects", async () => {
    await expect(discoverSessions(join(tmpdir(), "lgtm-does-not-exist-xyz"))).rejects.toThrow();
  });
});

describe("analyzeFile", () => {
  test("truncated last line is tolerated", () =>
    withTmp(async (dir) => {
      resetIds();
      const f = join(dir, "s.jsonl");
      writeFileSync(f, [prompt("do it"), ...edit("e1"), ...bash("b1", "pnpm test")].join("\n") + "\n");
      appendFileSync(f, '{"type":"assistant","message":{"role":"assis');
      const a = await analyzeFile(f, { sessionId: "s", file: "s.jsonl" });
      expect(a.prompts).toHaveLength(1);
      expect(a.prompts[0]?.status).toBe("checked");
    }));

  test("dedupe by uuid is per file, no cross-file seen-set", () =>
    withTmp(async (dir) => {
      resetIds();
      const lines = [prompt("do it"), ...edit("e1")].join("\n") + "\n";
      writeFileSync(join(dir, "a.jsonl"), lines);
      writeFileSync(join(dir, "b.jsonl"), lines);
      const a = await analyzeFile(join(dir, "a.jsonl"));
      const b = await analyzeFile(join(dir, "b.jsonl"));
      expect(a.prompts).toHaveLength(1);
      expect(b.prompts).toHaveLength(1);
      // repeated uuids inside one file are collapsed
      writeFileSync(join(dir, "c.jsonl"), lines + lines);
      expect((await analyzeFile(join(dir, "c.jsonl"))).prompts).toHaveLength(1);
    }));
});

describe("loadRepoScripts", () => {
  test("missing files => empty", () =>
    withTmp(async (dir) => {
      expect(await loadRepoScripts(dir)).toEqual({ packageScripts: [], makeTargets: [], scriptFiles: [] });
    }));

  test("reads package.json, Makefile, scripts/", () =>
    withTmp(async (dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "x", dev: "y", lint: "z" } }));
      writeFileSync(join(dir, "Makefile"), "build:\n\tx\ndeploy:\n\ty\ntest: build\n\tz\n");
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "check-all.sh"), "");
      writeFileSync(join(dir, "scripts", "dev.sh"), "");
      expect(await loadRepoScripts(dir)).toEqual({
        packageScripts: ["lint", "test"],
        makeTargets: ["build", "test"],
        scriptFiles: ["scripts/check-all.sh"],
      });
    }));
});
