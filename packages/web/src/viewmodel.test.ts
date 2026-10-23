import { describe, expect, test } from "vitest";
import type { PromptAnalysis } from "@lgtm/core";
import {
  PROMPT_PAGE, actionsLabel, checkOutcome, fileTotals, filesText, formatClock, formatDuration, formatStarted, formatStepDuration,
  incompleteMarkers, nextLimit, parseRoute, phaseLabel, promptHeading, routeHref, statusCountItems, statusLabel, stepTitle,
  retainKeys, splitInherited, timeBarText, timeSegments, toggleKey, visiblePrompts,
} from "./viewmodel";

const file = (added: number, removed: number, maybeIncomplete = false) => ({ path: "a", kind: "M" as const, added, removed, maybeIncomplete });

describe("labels and counts", () => {
  test("statusLabel", () => {
    expect(statusLabel("no-changes")).toBe("No changes");
    expect(statusLabel("failing")).toBe("Failing");
  });
  test("statusCountItems skips zeros, fixed order", () => {
    expect(statusCountItems({ checked: 2, unchecked: 0, failing: 1, "no-changes": 0 }).map((c) => `${c.status}:${c.count}`)).toEqual(["checked:2", "failing:1"]);
  });
});

describe("formatting", () => {
  test("formatDuration", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(80_000)).toBe("1m 20s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });
  test("formatStarted", () => {
    expect(formatStarted(null)).toBe("—");
    expect(formatStarted("nonsense")).toBe("—");
    expect(formatStarted(new Date(2026, 9, 3, 4, 5).toISOString())).toBe("2026-10-03 04:05");
  });
});

describe("time bar", () => {
  test("segments are proportional and skip empty phases", () => {
    const segs = timeSegments({ readMs: 10_000, writeMs: 30_000, checkMs: 0, fixMs: 0 });
    expect(segs.map((s) => [s.phase, s.pct])).toEqual([["read", 25], ["write", 75]]);
  });
  test("no timing data", () => {
    const z = { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 };
    expect(timeSegments(z)).toEqual([]);
    expect(timeBarText(z)).toBe("No timing data");
  });
  test("text alternative", () => {
    expect(timeBarText({ readMs: 10_000, writeMs: 30_000, checkMs: 0, fixMs: 0 })).toBe("Read 10s (25%), Write 30s (75%)");
  });
});

describe("files", () => {
  test("totals and text", () => {
    const t = fileTotals({ files: [file(3, 1), file(2, 0, true)] });
    expect(t).toEqual({ count: 2, added: 5, removed: 1, maybeIncomplete: true });
    expect(filesText(t)).toBe("2 files +5 -1");
    expect(filesText(fileTotals({ files: [file(1, 1)] }))).toBe("1 file +1 -1");
    expect(filesText(fileTotals({ files: [] }))).toBe("0 files +0 -0");
  });
  test("markers", () => {
    const p = (files: PromptAnalysis["files"], partial: boolean) => ({ files, partial });
    expect(incompleteMarkers(p([file(1, 0)], false))).toEqual([]);
    expect(incompleteMarkers(p([file(1, 0, true)], false))).toEqual(["may be incomplete"]);
    expect(incompleteMarkers(p([], true))).toEqual(["partial (subagents not analysed)"]);
    const r = (reason: string, partial = false) => ({ files: [], partial, reason });
    expect(incompleteMarkers(r("pnpm test passed after last edit (by subagent X)"))).toEqual([]);
    expect(incompleteMarkers(r("no checks ran; subagent transcript truncated (event cap)"))).toEqual(["subagent transcript truncated (event cap)"]);
    expect(incompleteMarkers(r("no checks ran; subagent transcript truncated (text cap)"))).toEqual(["subagent transcript truncated (text cap)"]);
    expect(incompleteMarkers(r("no checks ran; subagent activity not analysed (depth > 3)", true))).toEqual(["partial (subagents not analysed)"]);
  });
});

describe("paging", () => {
  const items = Array.from({ length: 1200 }, (_, i) => i);
  test("cap and show more", () => {
    expect(PROMPT_PAGE).toBe(500);
    const a = visiblePrompts(items, PROMPT_PAGE);
    expect(a.shown).toHaveLength(500);
    expect(a.hidden).toBe(700);
    expect(nextLimit(500, 1200)).toBe(1000);
    expect(nextLimit(1000, 1200)).toBe(1200);
    expect(visiblePrompts(items, 1200).hidden).toBe(0);
  });
});

describe("routing", () => {
  test("parse and build", () => {
    expect(parseRoute("")).toEqual({ kind: "list" });
    expect(parseRoute("#/")).toEqual({ kind: "list" });
    expect(parseRoute("#/session/abc-1")).toEqual({ kind: "session", id: "abc-1" });
    expect(parseRoute("#/session/a%2Fb")).toEqual({ kind: "session", id: "a/b" });
    expect(parseRoute("#/session/%E0%A4%A")).toEqual({ kind: "list" });
    expect(parseRoute("#/session/a/b")).toEqual({ kind: "list" });
    expect(routeHref({ kind: "session", id: "a/b" })).toBe("#/session/a%2Fb");
    expect(parseRoute(routeHref({ kind: "session", id: "x y" }))).toEqual({ kind: "session", id: "x y" });
  });
});

describe("steps routing", () => {
  test("steps and diff routes round-trip", () => {
    expect(parseRoute("#/session/abc/prompt/0")).toEqual({ kind: "steps", id: "abc", index: 0 });
    expect(parseRoute("#/session/a%2Fb/prompt/12")).toEqual({ kind: "steps", id: "a/b", index: 12 });
    expect(parseRoute("#/session/abc/prompt/3/diff?path=src%2Fa%20b.ts")).toEqual({ kind: "diff", id: "abc", index: 3, path: "src/a b.ts" });
    for (const r of [
      { kind: "steps", id: "x y", index: 7 },
      { kind: "diff", id: "x/y", index: 0, path: "dir/ü & ?.ts" },
    ] as const) expect(parseRoute(routeHref(r))).toEqual(r);
  });
  test("bad input falls back to the list", () => {
    for (const h of [
      "#/session/abc/prompt/-1", "#/session/abc/prompt/1e3", "#/session/abc/prompt/NaN", "#/session/abc/prompt/01",
      "#/session/abc/prompt/", "#/session/abc/prompt/1/other", "#/session/abc/prompt/1/diff", "#/session/abc/prompt/1/diff?path=",
      "#/session/abc/prompt/1/diff?path=%E0%A4%A", "#/session/abc/prompt/1234567890123", "#/session/abc/prompt/1/diff?path=a&x=1",
      "#/session/abc/diff?path=a.ts", "#/session/abc/prompt/01/map", "#/session/abc/map?x=1", "#/session/abc/prompt/1/map?x=1",
    ]) expect(parseRoute(h), h).toEqual({ kind: "list" });
  });
});

describe("map routing", () => {
  test("session and prompt maps parse and round-trip", () => {
    expect(parseRoute("#/session/abc/map")).toEqual({ kind: "map", id: "abc", index: null });
    expect(parseRoute("#/session/abc/prompt/7/map")).toEqual({ kind: "map", id: "abc", index: 7 });
    expect(routeHref({ kind: "map", id: "a/b", index: null })).toBe("#/session/a%2Fb/map");
    expect(routeHref({ kind: "map", id: "a/b", index: 2 })).toBe("#/session/a%2Fb/prompt/2/map");
    for (const r of [
      { kind: "map", id: "x y", index: null },
      { kind: "map", id: "x/y", index: 12 },
    ] as const) expect(parseRoute(routeHref(r))).toEqual(r);
  });
});

describe("step formatting", () => {
  test("formatStepDuration", () => {
    expect(formatStepDuration(0)).toBe("<1s");
    expect(formatStepDuration(499)).toBe("<1s");
    expect(formatStepDuration(1_000)).toBe("1s");
    expect(formatStepDuration(95_000)).toBe("1m 35s");
  });
  test("formatClock", () => {
    expect(formatClock(null)).toBe("");
    expect(formatClock("nonsense")).toBe("");
    expect(formatClock("2026-01-02T03:04:05")).toBe("03:04:05");
  });
  test("phaseLabel", () => {
    expect(phaseLabel("read")).toBe("Read");
    expect(phaseLabel("fix")).toBe("Fix");
  });
  test("stepTitle falls back to phase and number", () => {
    expect(stepTitle({ n: 2, phase: "check", title: "Run pnpm test -> passed" })).toBe("Run pnpm test -> passed");
    expect(stepTitle({ n: 4, phase: "write", title: "" })).toBe("Write step 4");
    expect(stepTitle({ n: 1, phase: "read", title: "   " })).toBe("Read step 1");
  });
  test("checkOutcome", () => {
    expect(checkOutcome({ exitCode: 0, passed: true })).toEqual({ text: "passed", tone: "pass" });
    expect(checkOutcome({ exitCode: 1, passed: false })).toEqual({ text: "exit 1", tone: "fail" });
    expect(checkOutcome({ exitCode: null, passed: false })).toEqual({ text: "failed", tone: "fail" });
    expect(checkOutcome({ exitCode: null, passed: null })).toEqual({ text: "did not run", tone: "none" });
    expect(checkOutcome({ exitCode: null, passed: null, stopped: true })).toEqual({ text: "stopped", tone: "none" });
  });
  test("labels", () => {
    expect(actionsLabel(1)).toBe("1 action");
    expect(actionsLabel(12)).toBe("12 actions");
    expect(promptHeading(0, "Fix the bug")).toBe("Prompt 1: Fix the bug");
    expect(promptHeading(4, "  ")).toBe("Prompt 5: (empty prompt)");
  });
});

describe("expanded state across live refreshes", () => {
  const promptsV1 = [{ index: 0 }, { index: 1 }, { index: 2 }];
  const promptsV2 = [...promptsV1, { index: 3 }]; // a new prompt was appended

  test("toggleKey flips a key without mutating", () => {
    const a: ReadonlySet<number> = new Set([1]);
    const b = toggleKey(a, 2);
    expect([...b].sort()).toEqual([1, 2]);
    expect([...a]).toEqual([1]);
    expect([...toggleKey(b, 1)]).toEqual([2]);
  });

  test("fresh data with the same prompt indices keeps the expanded rows (same set instance)", () => {
    const open: ReadonlySet<number> = new Set([0, 2]);
    expect(retainKeys(open, promptsV1.map((p) => p.index))).toBe(open);
    expect(retainKeys(open, promptsV2.map((p) => p.index))).toBe(open);
  });

  test("same step numbers keep expanded step lists; keys that vanished are dropped", () => {
    const open: ReadonlySet<number> = new Set([1, 3]);
    expect(retainKeys(open, [1, 2, 3, 4])).toBe(open);
    expect([...retainKeys(open, [1, 2])]).toEqual([1]);
    const empty: ReadonlySet<number> = new Set();
    expect(retainKeys(empty, [1])).toBe(empty);
  });
});

describe("splitInherited", () => {
  const p = (index: number, inheritedFrom?: string) => ({ index, inheritedFrom }) as PromptAnalysis;

  test("no inherited prompts", () => {
    const prompts = [p(0), p(1)];
    const r = splitInherited(prompts);
    expect(r.own).toEqual(prompts);
    expect(r.inherited).toEqual([]);
    expect(r.from).toBe("");
  });

  test("keeps original order and index values; from is the first inheritedFrom", () => {
    const prompts = [p(0, "sess-a"), p(1, "sess-b"), p(2), p(3, "sess-a"), p(4)];
    const r = splitInherited(prompts);
    expect(r.inherited.map((x) => x.index)).toEqual([0, 1, 3]);
    expect(r.own.map((x) => x.index)).toEqual([2, 4]);
    expect(r.from).toBe("sess-a");
  });

  test("all inherited: own is empty", () => {
    const r = splitInherited([p(0, "abc"), p(1, "abc")]);
    expect(r.own).toEqual([]);
    expect(r.inherited.map((x) => x.index)).toEqual([0, 1]);
    expect(r.from).toBe("abc");
  });
});
