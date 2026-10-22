import { expect, test } from "vitest";
import { Story } from "./index.js";

test("Story parses", () => {
  expect(Story.parse({ id: "1", title: "t" }).id).toBe("1");
});
