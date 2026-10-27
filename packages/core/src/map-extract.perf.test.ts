import { describe, expect, test } from "vitest";
import { extractImports, type ExtractedImport } from "./map-extract.js";

/**
 * Timing assertions live here (sequential perf suite), not in the ordinary test file.
 * The corpus is built at test time; nothing in the repository contains a generated barrel.
 */

const FULL_IMPORTS = 5000; // 5 imports per line-group, 1000 groups (~205 kB)
const SMALL_IMPORTS = 1250;

function barrel(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count / 5; i++) {
    lines.push(`import { a${i} } from "./alpha${i}.js";`);
    lines.push(`import type { T${i} } from "./types${i}";`);
    lines.push(`export { b${i} } from "./bravo${i}";`);
    lines.push(`const c${i} = await import("./charlie${i}");`);
    lines.push(`const d${i} = require("./delta${i}");`);
  }
  return lines.join("\n");
}

function expected(): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (let i = 0; i < FULL_IMPORTS / 5; i++) {
    const base = 5 * i;
    out.push({ specifier: `./alpha${i}.js`, syntax: "import", line: base + 1 });
    out.push({ specifier: `./types${i}`, syntax: "type-import", line: base + 2 });
    out.push({ specifier: `./bravo${i}`, syntax: "export", line: base + 3 });
    out.push({ specifier: `./charlie${i}`, syntax: "dynamic-import", line: base + 4 });
    out.push({ specifier: `./delta${i}`, syntax: "require", line: base + 5 });
  }
  return out;
}

describe("extractImports: performance (5000-import file)", () => {
  const RUNS = 3;
  /** Absolute ceiling: a linear pass stays in the tens of milliseconds; O(imports × filesize) takes ~1000 ms. */
  const HARD_CEILING_MS = 250;
  /** 4x the corpus must not cost more than 8x the time; quadratic growth in the match count is at least 16x. */
  const SCALING_RATIO = 8;
  /** Timings below this are too small to compare reliably. */
  const NOISE_FLOOR_MS = 25;

  test("a 5000-import file is extracted fast", { timeout: 60_000 }, () => {
    const source = barrel(FULL_IMPORTS);
    const small = barrel(SMALL_IMPORTS);
    let out!: ExtractedImport[];
    let ms = Number.POSITIVE_INFINITY;
    let smallMs = Number.POSITIVE_INFINITY;
    for (let r = 0; r < RUNS; r++) {
      const t0 = performance.now();
      out = extractImports(source);
      ms = Math.min(ms, performance.now() - t0);
      const t1 = performance.now();
      extractImports(small);
      smallMs = Math.min(smallMs, performance.now() - t1);
    }
    expect(out).toEqual(expected()); // identical output while the cost drops
    const detail = `${ms.toFixed(1)} ms at 5000 imports (${source.length} bytes), ${smallMs.toFixed(1)} ms at 1250 imports`;
    expect(ms, `hard ceiling - ${detail}`).toBeLessThan(HARD_CEILING_MS);
    expect(ms, `scaling (super-linear growth) - ${detail}`).toBeLessThan(Math.max(SCALING_RATIO * smallMs, NOISE_FLOOR_MS));
  });
});
