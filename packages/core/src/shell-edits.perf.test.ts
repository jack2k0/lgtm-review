import { describe, expect, test } from "vitest";
import { classifyShellMutation } from "./shell-edits.js";

describe("classifyShellMutation performance", () => {
  test("long commands stay linear-ish", () => {
    const cmd = "sed -i s/a/b/ " + Array.from({ length: 5000 }, (_, i) => `f${i}.js`).join(" ");
    const t = Date.now();
    expect(classifyShellMutation(cmd).edits.length).toBeLessThanOrEqual(20);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
