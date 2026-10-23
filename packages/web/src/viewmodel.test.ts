import { describe, expect, test } from "vitest";
import type { PromptAnalysis } from "@lgtm/core";
import {
  PROMPT_PAGE, fileTotals, filesText, formatDuration, formatStarted, incompleteMarkers, nextLimit, parseRoute,
  routeHref, statusCountItems, statusLabel, timeBarText, timeSegments, visiblePrompts,
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
