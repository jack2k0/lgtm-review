import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeFile } from "./index.js";
import { bash, edit, prompt, resetIds } from "../testing/records.js";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lgtm-core-node-perf-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("analyzeFile performance", () => {
  test("20 MB session analysed fast", () =>
    withTmp(async (dir) => {
      resetIds();
      const f = join(dir, "big.jsonl");
      const filler = "x".repeat(2000);
      const chunks: string[] = [];
      let size = 0;
      let n = 0;
      while (size < 20 * 1024 * 1024) {
        const batch = [prompt(`task ${n}`), ...edit(`e${n}`), ...bash(`b${n}`, "pnpm test", { output: filler })];
        const s = batch.join("\n") + "\n";
        chunks.push(s);
        size += s.length;
        n++;
      }
      writeFileSync(f, chunks.join(""));
      const t0 = performance.now();
      const a = await analyzeFile(f);
      const ms = performance.now() - t0;
      console.log(`analyzed ${(size / 1048576).toFixed(1)} MB, ${a.prompts.length} prompts in ${Math.round(ms)} ms`);
      expect(a.prompts.length).toBeGreaterThan(0);
      expect(ms).toBeLessThan(process.env.CI ? 6000 : 3000);
    }), 60_000);
});
