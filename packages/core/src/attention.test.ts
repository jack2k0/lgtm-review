import { describe, expect, test } from "vitest";
import type { Hint, Status } from "./schema.js";
import { needsAttention } from "./attention.js";

const hint: Hint = { rule: "large-change", severity: "info", path: null, reason: "test" };

describe("needsAttention", () => {
  test.each<[Status, Hint[], boolean]>([
    ["checked", [], false],
    ["checked", [hint], true],
    ["unchecked", [], true],
    ["failing", [], true],
    ["no-changes", [], false],
    ["no-changes", [hint], true],
  ])("%s with %d hint(s) -> %s", (status, hints, expected) => {
    expect(needsAttention({ status, hints })).toBe(expected);
  });
});
