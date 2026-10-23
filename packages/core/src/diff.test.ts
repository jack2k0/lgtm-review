import { beforeEach, describe, expect, test } from "vitest";
import { createAnalyzer } from "./analyze.js";
import { capPatch, createPatch, DIFF_LINES_MAX, DIFF_LINE_CHARS_MAX, extractPatch, hunkHeader, buildFileDiff } from "./diff.js";
import { parseLines } from "./parse.js";
import { FileDiff } from "./schema.js";
import { prompt, resetIds, toolResult, toolUse } from "./testing/records.js";

beforeEach(resetIds);

const P = "/home/user/project";
const h = (os: number, ol: number, ns: number, nl: number, lines: string[]) => ({ oldStart: os, oldLines: ol, newStart: ns, newLines: nl, lines });
const upd = (patch: unknown[], extra: Record<string, unknown> = {}) => ({ type: "update", structuredPatch: patch, ...extra });

function analyzer(lines: string[]) {
  const a = createAnalyzer({ detail: true });
  for (const l of lines) a.push(l);
  a.finish();
  return a;
}
const edit = (id: string, file: string, tur: unknown, tool = "Edit"): string[] => [
  toolUse(id, tool, { file_path: file, old_string: "a", new_string: "b" }),
  toolResult(id, "ok", { toolUseResult: tur }),
];
const many = (n: number, prefix: string, len = 5): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(len - 1, "0")}`);

describe("hunks", () => {
  test("header format and line prefixes", () => {
    const a = analyzer([prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(3, 2, 3, 3, [" ctx", "-old", "+new", "+more"])]))]);
    const d = a.diffFor(0, `${P}/a.ts`)!;
    expect(FileDiff.safeParse(d).success).toBe(true);
    expect(d).toEqual({
      path: `${P}/a.ts`,
      kind: "M",
      truncated: false,
      maybeIncomplete: false,
      hunks: [{ header: "@@ -3,2 +3,3 @@", lines: [{ t: " ", s: "ctx" }, { t: "-", s: "old" }, { t: "+", s: "new" }, { t: "+", s: "more" }] }],
    });
    expect(hunkHeader({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 4 })).toBe("@@ -0,0 +1,4 @@");
  });

  test("lines with another prefix (e.g. 'no newline' markers) are kept as context", () => {
    const a = analyzer([prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(1, 1, 1, 1, ["-a", "+b", "\\ No newline at end of file"])]))]);
    expect(a.diffFor(0, `${P}/a.ts`)!.hunks[0]!.lines[2]).toEqual({ t: " ", s: "\\ No newline at end of file" });
  });

  test("several edits of one file are consecutive hunks in order, kind and counts stay consistent", () => {
    const a = analyzer([
      prompt("p"),
      ...edit("e1", `${P}/a.ts`, upd([h(1, 1, 1, 1, ["-1", "+one"])])),
      ...edit("e2", `${P}/b.ts`, upd([h(1, 1, 1, 1, ["-x", "+y"])])),
      ...edit("e3", `${P}/a.ts`, upd([h(9, 1, 9, 1, ["-9", "+nine"]), h(20, 1, 20, 1, ["-20", "+twenty"])])),
    ]);
    const d = a.diffFor(0, `${P}/a.ts`)!;
    expect(d.hunks.map((x) => x.header)).toEqual(["@@ -1,1 +1,1 @@", "@@ -9,1 +9,1 @@", "@@ -20,1 +20,1 @@"]);
    expect(a.diffFor(0, `${P}/b.ts`)!.hunks).toHaveLength(1);
  });

  test("Write create becomes one synthetic all-plus hunk", () => {
    const content = "one\ntwo\nthree\n";
    const a = analyzer([prompt("p"), ...edit("w", `${P}/n.ts`, { type: "create", content, structuredPatch: [] }, "Write")]);
    expect(a.diffFor(0, `${P}/n.ts`)).toEqual({
      path: `${P}/n.ts`,
      kind: "A",
      truncated: false,
      maybeIncomplete: false,
      hunks: [{ header: "@@ -0,0 +1,3 @@", lines: [{ t: "+", s: "one" }, { t: "+", s: "two" }, { t: "+", s: "three" }] }],
    });
  });

  test("create then edit: kind A with both hunks", () => {
    const a = analyzer([
      prompt("p"),
      ...edit("w", `${P}/n.ts`, { type: "create", content: "a\nb\n" }, "Write"),
      ...edit("e", `${P}/n.ts`, upd([h(2, 1, 2, 1, ["-b", "+c"])])),
    ]);
    const d = a.diffFor(0, `${P}/n.ts`)!;
    expect(d.kind).toBe("A");
    expect(d.hunks.map((x) => x.header)).toEqual(["@@ -0,0 +1,2 @@", "@@ -2,1 +2,1 @@"]);
  });

  test("an emptied file is M with an all-minus hunk", () => {
    const a = analyzer([prompt("p"), ...edit("w", `${P}/e.ts`, upd([h(1, 2, 0, 0, ["-x", "-y"])]), "Write")]);
    const d = a.diffFor(0, `${P}/e.ts`)!;
    expect(d.kind).toBe("M");
    expect(d.maybeIncomplete).toBe(false);
    expect(d.hunks[0]!.lines.every((l) => l.t === "-")).toBe(true);
  });

  test("shell edits come from bashEditDiff", () => {
    const bashEdit = (files: unknown[]) => [
      toolUse("b", "Bash", { command: "sed -i x y" }),
      toolResult("b", "", { toolUseResult: { stdout: "", bashEditDiff: { files } } }),
    ];
    const a = analyzer([prompt("p"), ...bashEdit([{ filePath: `${P}/s.ts`, hunks: [h(1, 1, 1, 1, ["-a", "+b"])] }])]);
    expect(a.diffFor(0, `${P}/s.ts`)).toMatchObject({ kind: "M", maybeIncomplete: false, hunks: [{ header: "@@ -1,1 +1,1 @@" }] });
  });

  test("shell removal with known content is D; without content D is incomplete with no hunks", () => {
    const rm = (files: unknown[]) => [toolUse("b", "Bash", { command: "rm x" }), toolResult("b", "", { toolUseResult: { bashEditDiff: { files } } })];
    const a = analyzer([
      prompt("p"),
      ...rm([{ filePath: `${P}/gone.ts`, hunks: [h(1, 2, 0, 0, ["-a", "-b"])] }]),
      ...rm([{ filePath: `${P}/empty-gone.ts`, hunks: [h(1, 0, 0, 0, [])] }]),
      ...rm([{ filePath: `${P}/moved.ts`, hunks: [] }]),
    ]);
    expect(a.diffFor(0, `${P}/gone.ts`)).toMatchObject({ kind: "D", maybeIncomplete: false, hunks: [{ header: "@@ -1,2 +0,0 @@" }] });
    expect(a.diffFor(0, `${P}/empty-gone.ts`)).toMatchObject({ kind: "D", maybeIncomplete: true, hunks: [] });
    expect(a.diffFor(0, `${P}/moved.ts`)).toMatchObject({ kind: "M", maybeIncomplete: true, hunks: [] });
  });

  test("edits without a patch are marked incomplete", () => {
    const a = analyzer([prompt("p"), ...edit("n", `${P}/nb.ipynb`, { type: "update" }, "NotebookEdit")]);
    expect(a.diffFor(0, `${P}/nb.ipynb`)).toMatchObject({ maybeIncomplete: true, hunks: [] });
  });

  test("unknown prompt, unknown path, bad index: null", () => {
    const a = analyzer([prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(1, 1, 1, 1, ["-a", "+b"])]))]);
    expect(a.diffFor(0, `${P}/other.ts`)).toBeNull();
    expect(a.diffFor(1, `${P}/a.ts`)).toBeNull();
    expect(a.diffFor(-1, `${P}/a.ts`)).toBeNull();
    expect(a.diffFor(Number.NaN, `${P}/a.ts`)).toBeNull();
    expect(a.diffFor(0, "../../etc/passwd")).toBeNull();
    expect(a.diffFor(0, "")).toBeNull();
  });

  test("diffs are scoped to their prompt", () => {
    const a = analyzer([
      prompt("one"),
      ...edit("e1", `${P}/a.ts`, upd([h(1, 1, 1, 1, ["-1", "+2"])])),
      prompt("two"),
      ...edit("e2", `${P}/a.ts`, upd([h(5, 1, 5, 1, ["-5", "+6"])])),
    ]);
    expect(a.diffFor(0, `${P}/a.ts`)!.hunks.map((x) => x.header)).toEqual(["@@ -1,1 +1,1 @@"]);
    expect(a.diffFor(1, `${P}/a.ts`)!.hunks.map((x) => x.header)).toEqual(["@@ -5,1 +5,1 @@"]);
  });

  test("originalFile and full tool output are never retained", () => {
    const a = analyzer([prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(1, 1, 1, 1, ["-a", "+b"])], { originalFile: "ORIGINAL-SECRET".repeat(100) }))]);
    expect(JSON.stringify(a.details())).not.toContain("ORIGINAL-SECRET");
    expect(JSON.stringify(a.diffFor(0, `${P}/a.ts`))).not.toContain("ORIGINAL-SECRET");
    const ev = parseLines([prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(1, 1, 1, 1, ["-a", "+b"])], { originalFile: "ORIGINAL-SECRET" }))], { detail: true }).events;
    expect(JSON.stringify(ev)).not.toContain("ORIGINAL-SECRET");
  });
});

describe("truncation (enforced while parsing)", () => {
  test("the parser keeps at most 2000 lines of one patch", () => {
    const lines = many(5000, "+l");
    const { events } = parseLines([prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(1, 0, 1, 5000, lines)]))], { detail: true });
    const res = events.find((e) => e.type === "tool_result");
    if (res?.type !== "tool_result") throw new Error("no result");
    expect(res.patch?.hunks[0]!.lines).toHaveLength(DIFF_LINES_MAX);
    expect(res.patch?.cut).toBe(true);
    expect(res.structuredPatch?.added).toBe(5000);
  });

  test("diff capped at 2000 lines with truncated: true", () => {
    const a = analyzer([prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(1, 0, 1, 3000, many(3000, "+l"))]))]);
    const d = a.diffFor(0, `${P}/a.ts`)!;
    expect(d.truncated).toBe(true);
    expect(d.hunks[0]!.lines).toHaveLength(2000);
    expect(d.hunks[0]!.header).toBe("@@ -1,0 +1,3000 @@");
  });

  test("the cap is per (prompt, file) over several edits", () => {
    const a = analyzer([
      prompt("p"),
      ...edit("e1", `${P}/a.ts`, upd([h(1, 0, 1, 1500, many(1500, "+a"))])),
      ...edit("e2", `${P}/a.ts`, upd([h(2000, 0, 2000, 1500, many(1500, "+b"))])),
      ...edit("e3", `${P}/a.ts`, upd([h(4000, 0, 4000, 10, many(10, "+c"))])),
    ]);
    const d = a.diffFor(0, `${P}/a.ts`)!;
    expect(d.truncated).toBe(true);
    expect(d.hunks.reduce((n, x) => n + x.lines.length, 0)).toBe(2000);
    // the counts of the list stay exact
    expect(a.finish().prompts[0]!.files[0]).toMatchObject({ added: 3010 });
  });

  test("lines are cut at 2000 characters", () => {
    const a = analyzer([prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(1, 0, 1, 1, ["+" + "x".repeat(5000)])]))]);
    const d = a.diffFor(0, `${P}/a.ts`)!;
    expect(d.hunks[0]!.lines[0]!.s).toHaveLength(DIFF_LINE_CHARS_MAX);
    expect(d.truncated).toBe(true);
  });

  test("Write create: first 2000 lines, header keeps the real line count", () => {
    const content = many(2600, "row").join("\n");
    const a = analyzer([prompt("p"), ...edit("w", `${P}/big.txt`, { type: "create", content }, "Write")]);
    const d = a.diffFor(0, `${P}/big.txt`)!;
    expect(d.truncated).toBe(true);
    expect(d.hunks[0]!.header).toBe("@@ -0,0 +1,2600 @@");
    expect(d.hunks[0]!.lines).toHaveLength(2000);
    expect(a.finish().prompts[0]!.files[0]).toMatchObject({ kind: "A", added: 2600 });
  });

  test("session retention budget: later diffs are dropped but flagged", () => {
    const wide = "+" + "w".repeat(1000);
    const lines = [prompt("p")];
    for (let i = 0; i < 10; i++) lines.push(...edit(`e${i}`, `${P}/f${i}.ts`, upd([h(1, 0, 1, 2000, Array(2000).fill(wide))])));
    const a = analyzer(lines);
    const first = a.diffFor(0, `${P}/f0.ts`)!;
    const last = a.diffFor(0, `${P}/f9.ts`)!;
    expect(first.truncated).toBe(false);
    expect(first.hunks[0]!.lines).toHaveLength(2000);
    expect(last).toMatchObject({ truncated: true, hunks: [] });
    expect(a.detailBytes()).toBeLessThan(40_000_000);
  });
});

describe("helpers", () => {
  test("extractPatch ignores non-arrays and non-string lines", () => {
    expect(extractPatch(undefined)).toBeUndefined();
    expect(extractPatch([{ lines: ["+a", 5, null] }, "junk", { lines: "no" }])).toEqual({
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+a"] }],
      cut: false,
    });
  });

  test("createPatch handles empty content, no trailing newline and CRLF", () => {
    expect(createPatch("").hunks).toEqual([]);
    expect(createPatch("a").hunks[0]).toMatchObject({ newLines: 1, lines: ["+a"] });
    expect(createPatch("a\n\nb").hunks[0]).toMatchObject({ newLines: 3, lines: ["+a", "+", "+b"] });
  });

  test("capPatch and buildFileDiff are pure", () => {
    const p = { hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ["+a", "+b", "+c"] }], cut: false };
    const capped = capPatch(p, 2);
    expect(capped.cut).toBe(true);
    expect(p.hunks[0]!.lines).toHaveLength(3);
    expect(buildFileDiff("x", "M", false, [capped]).truncated).toBe(true);
    expect(buildFileDiff("x", "M", false, [])).toEqual({ path: "x", kind: "M", truncated: false, maybeIncomplete: false, hunks: [] });
  });

  test("diffs are deterministic", () => {
    const lines = [prompt("p"), ...edit("e", `${P}/a.ts`, upd([h(1, 1, 1, 1, ["-a", "+b"])]))];
    expect(JSON.stringify(analyzer(lines).diffFor(0, `${P}/a.ts`))).toBe(JSON.stringify(analyzer(lines).diffFor(0, `${P}/a.ts`)));
  });
});
