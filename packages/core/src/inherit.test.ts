import { describe, expect, test } from "vitest";
import type { SessionAnalysis } from "./schema.js";
import { markInherited } from "./inherit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrompt(uuid: string, index = 0): SessionAnalysis["prompts"][number] {
  return {
    index,
    uuid,
    text: `prompt ${uuid}`,
    status: "checked",
    reason: "test",
    files: [],
    partial: false,
    timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
    activeMs: 0,
    headline: "No timing data",
    hints: [],
    recommendation: "skim",
  };
}

function makeSession(id: string, startedAt: string | null, uuids: string[]): SessionAnalysis {
  return {
    sessionId: id,
    title: id,
    branch: "main",
    startedAt,
    prompts: uuids.map((u, i) => makePrompt(u, i)),
    warnings: [],
  };
}

function inheritedFrom(result: SessionAnalysis[], sid: string): string[] {
  return (result.find((s) => s.sessionId === sid)?.prompts ?? [])
    .filter((p) => p.inheritedFrom !== undefined)
    .map((p) => p.inheritedFrom as string);
}

function ownedUuids(result: SessionAnalysis[], sid: string): string[] {
  return (result.find((s) => s.sessionId === sid)?.prompts ?? [])
    .filter((p) => p.inheritedFrom === undefined)
    .map((p) => p.uuid);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("markInherited", () => {
  test("empty input returns empty array", () => {
    expect(markInherited([])).toEqual([]);
  });

  test("single session: no prompts marked inherited", () => {
    const sessions = [makeSession("a", "2026-01-01T00:00:00.000Z", ["u1", "u2"])];
    const result = markInherited(sessions);
    expect(result[0]?.prompts.every((p) => p.inheritedFrom === undefined)).toBe(true);
  });

  test("resume: session B copies A's prompts + has 2 new ones", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["u1", "u2", "u3"]);
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["u1", "u2", "u3", "u4", "u5"]);
    const result = markInherited([a, b]);

    // A keeps all prompts (it's the owner)
    expect(ownedUuids(result, "a")).toEqual(["u1", "u2", "u3"]);
    expect(inheritedFrom(result, "a")).toEqual([]);

    // B's first 3 are inherited from a; last 2 are own
    expect(inheritedFrom(result, "b")).toEqual(["a", "a", "a"]);
    expect(ownedUuids(result, "b")).toEqual(["u4", "u5"]);
  });

  test("resume: input order reversed still gives same result", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["u1", "u2", "u3"]);
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["u1", "u2", "u3", "u4", "u5"]);
    const fwd = markInherited([a, b]);
    const rev = markInherited([b, a]);
    // Same inheritance regardless of input order; output order differs (preserves input)
    expect(rev.find((s) => s.sessionId === "a")).toEqual(fwd.find((s) => s.sessionId === "a"));
    expect(rev.find((s) => s.sessionId === "b")).toEqual(fwd.find((s) => s.sessionId === "b"));
  });

  test("fork chain A -> B -> C: C's copies of A's prompts come from A; C's copies of B's new prompts come from B", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["u1", "u2"]);
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["u1", "u2", "u3"]);
    const c = makeSession("c", "2026-01-01T02:00:00.000Z", ["u1", "u2", "u3", "u4"]);
    const result = markInherited([a, b, c]);

    // A: owns everything
    expect(ownedUuids(result, "a")).toEqual(["u1", "u2"]);
    // B: copies u1,u2 from A; owns u3
    expect(inheritedFrom(result, "b")).toEqual(["a", "a"]);
    expect(ownedUuids(result, "b")).toEqual(["u3"]);
    // C: copies u1,u2 from A; copies u3 from B; owns u4
    const cPrompts = result.find((s) => s.sessionId === "c")!.prompts;
    expect(cPrompts[0]?.inheritedFrom).toBe("a");
    expect(cPrompts[1]?.inheritedFrom).toBe("a");
    expect(cPrompts[2]?.inheritedFrom).toBe("b");
    expect(cPrompts[3]?.inheritedFrom).toBeUndefined();
  });

  test("chain: B and C have equal startedAt — smaller sessionId (b) wins", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["u1"]);
    // b and c have same startedAt; 'b' < 'c' lexicographically, so b owns u2
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["u1", "u2"]);
    const c = makeSession("c", "2026-01-01T01:00:00.000Z", ["u1", "u2", "u3"]);
    const result = markInherited([a, b, c]);

    // u1 owned by a, u2 owned by b (b < c), u3 owned by c
    expect(ownedUuids(result, "a")).toEqual(["u1"]);
    expect(ownedUuids(result, "b")).toEqual(["u2"]);
    expect(inheritedFrom(result, "b")).toEqual(["a"]);
    // c: u1 from a, u2 from b, u3 own
    const cPrompts = result.find((s) => s.sessionId === "c")!.prompts;
    expect(cPrompts[0]?.inheritedFrom).toBe("a");
    expect(cPrompts[1]?.inheritedFrom).toBe("b");
    expect(cPrompts[2]?.inheritedFrom).toBeUndefined();
  });

  test("null startedAt is last in ownership order", () => {
    const nullSession = makeSession("null-sess", null, ["u1", "u2"]);
    const dated = makeSession("dated", "2026-01-01T00:00:00.000Z", ["u1"]);
    const result = markInherited([nullSession, dated]);

    // dated owns u1 (has a startedAt); null-sess's u1 is inherited from dated
    expect(ownedUuids(result, "dated")).toEqual(["u1"]);
    expect(inheritedFrom(result, "null-sess")).toEqual(["dated"]);
    expect(ownedUuids(result, "null-sess")).toEqual(["u2"]);
  });

  test("two null startedAt sessions: smaller sessionId owns", () => {
    const x = makeSession("x-session", null, ["u1", "u2"]);
    const y = makeSession("y-session", null, ["u1", "u3"]);
    const result = markInherited([x, y]);

    // x < y lexicographically, so x owns u1
    expect(ownedUuids(result, "x-session")).toContain("u1");
    expect(inheritedFrom(result, "y-session")).toContain("x-session");
  });

  test("unrelated sessions: no inheritance", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["u1", "u2"]);
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["u3", "u4"]);
    const result = markInherited([a, b]);
    expect(result.every((s) => s.prompts.every((p) => p.inheritedFrom === undefined))).toBe(true);
  });

  test("empty uuid prompts are never marked inherited", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["", "u1"]);
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["", "u1"]);
    const result = markInherited([a, b]);
    // empty uuid in b is NOT marked inherited
    const bPrompts = result.find((s) => s.sessionId === "b")!.prompts;
    expect(bPrompts[0]?.inheritedFrom).toBeUndefined();
    expect(bPrompts[1]?.inheritedFrom).toBe("a");
  });

  test("determinism: shuffled input order produces identical per-session results", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["u1", "u2"]);
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["u1", "u2", "u3"]);
    const c = makeSession("c", "2026-01-01T02:00:00.000Z", ["u1", "u2", "u3", "u4"]);
    const d = makeSession("d", null, ["u5"]);

    const orders = [
      [a, b, c, d],
      [d, c, b, a],
      [b, d, a, c],
      [c, a, d, b],
    ];

    const results = orders.map((order) => markInherited(order));

    // All permutations must produce identical per-session data
    for (let i = 1; i < results.length; i++) {
      for (const sid of ["a", "b", "c", "d"]) {
        expect(
          results[i]!.find((s) => s.sessionId === sid),
          `session ${sid} in permutation ${i}`,
        ).toEqual(results[0]!.find((s) => s.sessionId === sid));
      }
    }
  });

  test("output preserves input order (not ownership order)", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["u1"]);
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["u1", "u2"]);
    const result = markInherited([b, a]); // input: b first, a second
    expect(result[0]?.sessionId).toBe("b");
    expect(result[1]?.sessionId).toBe("a");
  });

  test("does not mutate input sessions", () => {
    const a = makeSession("a", "2026-01-01T00:00:00.000Z", ["u1"]);
    const b = makeSession("b", "2026-01-01T01:00:00.000Z", ["u1"]);
    const origAPrompt0 = a.prompts[0];
    markInherited([a, b]);
    expect(a.prompts[0]).toBe(origAPrompt0);
    expect((a.prompts[0] as Record<string, unknown>)["inheritedFrom"]).toBeUndefined();
  });
});
