import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeSession, createAnalyzer } from "./analyze.js";
import { FileDiff, PromptDetail, SessionAnalysis } from "./schema.js";
import { listFixtures, listLabelFiles, readFixtureLines, readLabels, sessionsDir } from "./testing/fixtures.js";

const fixtures = listFixtures();

describe("fixture corpus", () => {
  test("has fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(7);
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

describe("golden: analysis", () => {
  test.each(fixtures)("%s", async (name) => {
    const lines = readFixtureLines(name);
    const first = analyzeSession(lines, { sessionId: name, file: `${name}.jsonl` });
    const second = analyzeSession(lines, { sessionId: name, file: `${name}.jsonl` });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(SessionAnalysis.safeParse(first).success).toBe(true);
    await expect(JSON.stringify(first, null, 2) + "\n").toMatchFileSnapshot(
      join(sessionsDir, "__golden__", `${name}.analysis.json`),
    );
  });

  test("never throws on malformed lines", () => {
    expect(() => analyzeSession(["{ nope", "", "null", "42", '"str"', "[]", '{"type":"user"}', '{"type":"user","message":5}'])).not.toThrow();
  });
});

function detailOf(name: string) {
  const a = createAnalyzer({ detail: true, sessionId: name, file: `${name}.jsonl` });
  for (const l of readFixtureLines(name)) a.push(l);
  const analysis = a.finish();
  return { a, analysis, details: a.details() };
}

describe("golden: steps and diffs (detail mode)", () => {
  test.each(fixtures)("detail mode does not change the analysis: %s", (name) => {
    const plain = analyzeSession(readFixtureLines(name), { sessionId: name, file: `${name}.jsonl` });
    expect(JSON.stringify(detailOf(name).analysis)).toBe(JSON.stringify(plain));
  });

  test.each(fixtures)("steps: %s", async (name) => {
    const { details } = detailOf(name);
    const again = detailOf(name).details;
    expect(JSON.stringify(again)).toBe(JSON.stringify(details));
    for (const d of details) expect(PromptDetail.safeParse(d).success).toBe(true);
    await expect(JSON.stringify(details, null, 2) + "\n").toMatchFileSnapshot(join(sessionsDir, "__golden__", `${name}.steps.json`));
  });

  test.each(fixtures)("diffs: %s", async (name) => {
    const { a, analysis } = detailOf(name);
    const diffs: Record<string, FileDiff> = {};
    for (const p of analysis.prompts) {
      for (const f of p.files) {
        const d = a.diffFor(p.index, f.path);
        expect(d, `${p.index}:${f.path}`).not.toBeNull();
        expect(FileDiff.safeParse(d).success).toBe(true);
        expect(d?.kind).toBe(f.kind);
        diffs[`${p.index}:${f.path}`] = d!;
      }
    }
    await expect(JSON.stringify(diffs, null, 2) + "\n").toMatchFileSnapshot(join(sessionsDir, "__golden__", `${name}.diffs.json`));
  });
});

describe("status accuracy against labels", () => {
  test("status match >= 95% over the whole corpus", () => {
    let total = 0;
    let matched = 0;
    const misses: string[] = [];
    for (const name of fixtures) {
      const analysis = analyzeSession(readFixtureLines(name));
      const labels = readLabels(name);
      if (analysis.prompts.length !== labels.prompts.length) {
        misses.push(`${name}: ${analysis.prompts.length} prompts, ${labels.prompts.length} labels`);
      }
      for (const l of labels.prompts) {
        total++;
        const got = analysis.prompts[l.index]?.status;
        if (got === l.expectedStatus) matched++;
        else misses.push(`${name}#${l.index}: expected ${l.expectedStatus}, got ${String(got)}`);
      }
    }
    const ratio = matched / total;
    // eslint-disable-next-line no-console
    console.log(`status match: ${matched}/${total} (${(ratio * 100).toFixed(1)}%)`);
    expect(misses, misses.join("\n")).toEqual([]);
    expect(ratio).toBeGreaterThanOrEqual(0.95);
  });
});
