import { ESLint } from "eslint";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function lint(filePath: string, code: string): Promise<(string | null)[]> {
  const fullPath = join(repoRoot, filePath);
  const results = await eslint.lintText(code, { filePath: fullPath });
  return results[0]?.messages.map((m) => m.ruleId) ?? [];
}

describe("AGENTS.md boundaries in ESLint", () => {
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
