import { describe, expect, test } from "vitest";
import type { Hint } from "@lgtm/core";
import { attentionPrompts, escapeToList, needText, rowKey, sessionAttention } from "./triage";
import { makePrompt, makeSummary } from "./testing/fixtures";

const hint: Hint = { rule: "large-change", severity: "info", path: null, reason: "test" };

const target = (tagName: string, isContentEditable = false): EventTarget =>
  ({ tagName, isContentEditable }) as unknown as EventTarget;

describe("attentionPrompts", () => {
  test("keeps own unchecked, failing and hinted prompts in order", () => {
    const prompts = [
      makePrompt(0, { status: "checked" }),
      makePrompt(1, { status: "unchecked" }),
      makePrompt(2, { status: "checked", hints: [hint] }),
      makePrompt(3, { status: "failing" }),
      makePrompt(4, { status: "no-changes" }),
      makePrompt(5, { status: "no-changes", hints: [hint] }),
      makePrompt(6, { status: "unchecked", inheritedFrom: "abcdef0123456789" }),
      makePrompt(7, { status: "checked", hints: [hint], inheritedFrom: "abcdef0123456789" }),
    ];
    expect(attentionPrompts(prompts).map((p) => p.index)).toEqual([1, 2, 3, 5]);
  });
});

describe("sessionAttention", () => {
  test("uses attentionCount when present, including 0", () => {
    expect(sessionAttention(makeSummary({ attentionCount: 0, statusCounts: { checked: 0, unchecked: 2, failing: 1, "no-changes": 0 } }))).toBe(0);
    expect(sessionAttention(makeSummary({ attentionCount: 4 }))).toBe(4);
  });

  test("falls back to unchecked + failing for older servers", () => {
    expect(sessionAttention(makeSummary({ statusCounts: { checked: 3, unchecked: 2, failing: 1, "no-changes": 4 } }))).toBe(3);
  });
});

describe("needText", () => {
  test("pluralises the noun and the verb", () => {
    expect(needText(1, "prompt")).toBe("1 prompt needs attention");
    expect(needText(0, "session")).toBe("0 sessions need attention");
    expect(needText(3, "prompt")).toBe("3 prompts need attention");
  });
});

describe("rowKey", () => {
  test("maps the row keys", () => {
    expect(rowKey({ key: "ArrowDown" })).toBe("next");
    expect(rowKey({ key: "ArrowUp" })).toBe("prev");
    expect(rowKey({ key: "s" })).toBe("steps");
    expect(rowKey({ key: "m" })).toBe("map");
  });

  test("ignores other keys", () => {
    for (const key of ["S", "x", "Enter", "ArrowLeft"]) expect(rowKey({ key }), key).toBeNull();
  });

  test("any modifier or a handled event gives null", () => {
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(rowKey({ key: "ArrowDown", [mod]: true }), mod).toBeNull();
    }
    expect(rowKey({ key: "ArrowDown", defaultPrevented: true })).toBeNull();
  });
});

describe("escapeToList", () => {
  test("Escape outside a field goes back", () => {
    expect(escapeToList({ key: "Escape", target: target("BODY") })).toBe(true);
    expect(escapeToList({ key: "Escape", target: target("BUTTON") })).toBe(true);
    expect(escapeToList({ key: "Escape", target: null })).toBe(true);
  });

  test("Escape while typing in a field stays", () => {
    expect(escapeToList({ key: "Escape", target: target("INPUT") })).toBe(false);
    expect(escapeToList({ key: "Escape", target: target("TEXTAREA") })).toBe(false);
    expect(escapeToList({ key: "Escape", target: target("SELECT") })).toBe(false);
    expect(escapeToList({ key: "Escape", target: target("DIV", true) })).toBe(false);
  });

  test("modifiers, handled events and other keys do nothing", () => {
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(escapeToList({ key: "Escape", target: target("BODY"), [mod]: true }), mod).toBe(false);
    }
    expect(escapeToList({ key: "Escape", target: target("BODY"), defaultPrevented: true })).toBe(false);
    expect(escapeToList({ key: "Enter", target: target("BODY") })).toBe(false);
  });
});
