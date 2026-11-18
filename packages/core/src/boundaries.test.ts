import { ESLint } from "eslint";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function lint(filePath: string, code: string): Promise<(string | null)[]> {
  const fullPath = join(repoRoot, filePath);
  const results = await eslint.lintText(code, { filePath: fullPath });
  return results[0]?.messages.map((m) => m.ruleId) ?? [];
}

describe("AGENTS.md boundaries in ESLint", { timeout: 30000 }, () => {
  describe("error cases", () => {
    it("bans node:fs in packages/core/src", async () => {
      const rules = await lint("packages/core/src/x.ts", 'import "node:fs";');
      expect(rules).toContain("no-restricted-imports");
    });

    it("bans bare fs in packages/core/src", async () => {
      const rules = await lint("packages/core/src/x.ts", 'import "fs";');
      expect(rules).toContain("no-restricted-imports");
    });

    it("bans dynamic import('node:fs') in packages/core/src", async () => {
      const rules = await lint("packages/core/src/x.ts", 'await import("node:fs");');
      expect(rules).toContain("no-restricted-syntax");
    });

    it("bans dynamic import('fs') and import('fs/promises') in packages/core/src", async () => {
      expect(await lint("packages/core/src/x.ts", 'await import("fs");')).toContain("no-restricted-syntax");
      expect(await lint("packages/core/src/x.ts", 'await import("fs/promises");')).toContain("no-restricted-syntax");
    });

    it("bans a relative import of src/node from packages/core/src", async () => {
      const rules = await lint("packages/core/src/x.ts", 'import "./node/git.js";');
      expect(rules).toContain("no-restricted-imports");
    });

    it("bans node:path in packages/web/src", async () => {
      const rules = await lint("packages/web/src/x.tsx", 'import "node:path";');
      expect(rules).toContain("no-restricted-imports");
    });

    it("bans @lgtm/core/node in packages/web/src", async () => {
      const rules = await lint("packages/web/src/x.tsx", 'import "@lgtm/core/node";');
      expect(rules).toContain("no-restricted-imports");
    });

    it("bans exec from node:child_process in packages/cli/src", async () => {
      const rules = await lint("packages/cli/src/x.ts", 'import { exec } from "node:child_process";');
      expect(rules).toContain("no-restricted-imports");
    });

    it("bans execSync from child_process in packages/cli/src", async () => {
      const rules = await lint("packages/cli/src/x.ts", 'import { execSync } from "child_process";');
      expect(rules).toContain("no-restricted-imports");
    });

    it("bans exec from node:child_process in scripts", async () => {
      const rules = await lint("scripts/x.mjs", 'import { exec } from "node:child_process";');
      expect(rules).toContain("no-restricted-imports");
    });

    it("bans execSync from child_process in scripts", async () => {
      const rules = await lint("scripts/x.mjs", 'import { execSync } from "child_process";');
      expect(rules).toContain("no-restricted-imports");
    });
  });

  describe("allowed cases", () => {
    it("allows node:fs in packages/core/src/node", async () => {
      const rules = await lint("packages/core/src/node/x.ts", 'import "node:fs";');
      expect(rules).not.toContain("no-restricted-imports");
      expect(rules).not.toContain("no-restricted-syntax");
    });

    it("allows node:fs in packages/core/src/testing", async () => {
      const rules = await lint("packages/core/src/testing/x.ts", 'import "node:fs";');
      expect(rules).not.toContain("no-restricted-imports");
      expect(rules).not.toContain("no-restricted-syntax");
    });

    it("allows node:fs in test files (packages/core/src/x.test.ts)", async () => {
      const rules = await lint("packages/core/src/x.test.ts", 'import "node:fs";');
      expect(rules).not.toContain("no-restricted-imports");
      expect(rules).not.toContain("no-restricted-syntax");
    });

    it("allows execFile from node:child_process in packages/cli/src", async () => {
      const rules = await lint("packages/cli/src/x.ts", 'import { execFile } from "node:child_process";');
      expect(rules).not.toContain("no-restricted-imports");
      expect(rules).not.toContain("no-restricted-syntax");
    });
  });
});

/**
 * A display cut of log-derived text goes through `cutForDisplay` (redact.ts), which trims a partial secret
 * before the text is redacted. A raw `.slice(0, <NAME>_MAX` / `.slice(1, 1 + <NAME>_MAX` would bring the bug back.
 */
describe("display cuts go through cutForDisplay", () => {
  const CUT = /\.slice\(\s*[01]\s*,\s*(?:1\s*\+\s*)?([A-Z][A-Z0-9_]*_MAX)\b/g;
  /** Remaining non-display hits, as `file:NAME`, each with the reason it is not a display cut. */
  const NOT_DISPLAY: Record<string, string> = {
    "packages/core/src/scope.ts:SCOPE_LABEL_MAX": "label of directory names, not log text",
    "packages/core/src/parse.ts:NOTIFICATION_SCAN_MAX": "cap on the text scanned for notifications, never shown",
    "packages/core/src/subagents.ts:DESCRIPTION_MAX": "intermediate cap (200); the shown description is cut again by oneLine to 60",
    "packages/core/src/node/subagents.ts:DESCRIPTION_MAX": "intermediate cap (200); the shown description is cut again by oneLine to 60",
    "packages/core/src/node/subagents.ts:SUBAGENT_FILES_MAX": "list of file stems",
    "packages/core/src/node/git.ts:GIT_FILES_MAX": "list of file paths",
    "packages/cli/src/export-html.ts:ACTIONS_PER_STEP_MAX": "array of actions",
  };

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sources(p));
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("has no raw `.slice(0, <NAME>_MAX` outside redact.ts except the listed non-display ones", () => {
    const hits = new Set<string>();
    for (const root of ["packages/core/src", "packages/cli/src"]) {
      for (const file of sources(join(repoRoot, root))) {
        const rel = relative(repoRoot, file);
        if (rel === "packages/core/src/redact.ts") continue;
        for (const m of readFileSync(file, "utf8").matchAll(CUT)) hits.add(`${rel}:${m[1]}`);
      }
    }
    expect([...hits].filter((h) => !(h in NOT_DISPLAY)).sort()).toEqual([]);
    expect(Object.keys(NOT_DISPLAY).filter((k) => !hits.has(k)).sort()).toEqual([]);
  });

  it("the pattern catches both cut shapes", () => {
    expect("s.slice(0, FOO_MAX - 1)".match(CUT)).not.toBeNull();
    expect("l.slice(1, 1 + DIFF_LINE_CHARS_MAX)".match(CUT)).not.toBeNull();
    expect("a.slice(0, max)".match(CUT)).toBeNull();
  });

  it("does not define function truncate or function truncateText outside tests", () => {
    const decl = /\bfunction\s+truncate(?:Text)?\s*\(/;
    const hits: string[] = [];
    for (const root of ["packages/core/src", "packages/cli/src"]) {
      for (const file of sources(join(repoRoot, root))) {
        if (decl.test(readFileSync(file, "utf8"))) hits.push(relative(repoRoot, file));
      }
    }
    expect(hits.sort()).toEqual([]);
  });
});
