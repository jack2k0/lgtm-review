import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// Patterns are assembled from parts so this file does not contain the banned literals itself.
const banned = [
  ["dangerously", "SetInner", "HTML"],
  ["inner", "HTML"],
  ["outer", "HTML"],
  ["insertAdjacent", "HTML"],
  ["document", "\\.write"],
  ["createContextual", "Fragment"],
  ["DOM", "Parser"],
  ["mark", "down"],
  ["mark", "ed"],
].map((p) => new RegExp(p.join(""), "i"));

describe("log content is rendered as text only", () => {
  test("web sources contain no HTML injection or rich-text rendering", () => {
    const files = readdirSync(here).filter((f) => /\.(tsx?|css|html)$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    for (const f of ["StepsView.tsx", "StepCard.tsx", "steps.test.tsx", "DiffView.tsx", "diff.test.tsx", "Hints.tsx", "hints.test.tsx", "PromptTable.tsx"]) expect(files, f).toContain(f);
    for (const f of files) {
      const src = readFileSync(join(here, f), "utf8");
      for (const re of banned) expect(src, `${f} ${re}`).not.toMatch(re);
    }
  });
});
