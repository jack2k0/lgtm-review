import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listFixtures, listLabelFiles, readFixtureLines, readLabels, sessionsDir } from "./testing/fixtures.js";

// Placeholder analyzer for F-01: record inventory. S-01 replaces it with the real one.
export interface Analyzer {
  name: string;
  run(lines: string[]): unknown;
}

export const inventory: Analyzer = {
  name: "inventory",
  run(lines) {
    const types: Record<string, number> = {};
    let malformed = 0;
    for (const line of lines) {
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      const t =
        rec !== null && typeof rec === "object" && typeof (rec as { type?: unknown }).type === "string"
          ? (rec as { type: string }).type
          : "(none)";
      types[t] = (types[t] ?? 0) + 1;
    }
    const sorted = Object.fromEntries(Object.entries(types).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return { totalLines: lines.length, malformedLines: malformed, types: sorted };
  },
};

const analyzers: Analyzer[] = [inventory];
const fixtures = listFixtures();

describe("fixture corpus", () => {
  test("has fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });

  test("every jsonl has labels and vice versa", () => {
    expect(listLabelFiles()).toEqual(fixtures);
  });

  test.each(fixtures)("labels parse: %s", (name) => {
    const labels = readLabels(name);
    expect(labels.fixture).toBe(name);
    expect(labels.prompts.length).toBeGreaterThan(0);
  });
});

describe.each(analyzers)("golden: $name", (analyzer) => {
  test.each(fixtures)("%s", async (name) => {
    const lines = readFixtureLines(name);
    const first = analyzer.run(lines);
    const second = analyzer.run(lines);
    expect(second).toEqual(first);
    await expect(JSON.stringify(first, null, 2) + "\n").toMatchFileSnapshot(
      join(sessionsDir, "__golden__", `${name}.${analyzer.name}.json`),
    );
  });

  test("never throws on malformed lines", () => {
    expect(() => analyzer.run(["{ nope", "", "null", "42", '"str"', "[]"])).not.toThrow();
  });
});
