import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { removedLines, findTableLines } from "./gate.mjs";

describe("removedLines and test.each table detection", () => {
  test("Case 1: exact sa12 diff shape (rows deleted from test.each table -> 3 removals; fails on old code)", () => {
    const oldContent = `
describe("classifyShellMutation: edits", () => {
  test.each([
    "sed 's/a/b/' x.js",
    "echo hi 2> err.txt",
    "ls 2>&1",
    "ls >&2",
    "ls &> all.txt",
    "cmd > \\"$OUT\\"",
    "echo hi | tee /tmp/out.txt",
  ])("%s", () => {});
});
`.trimStart();

    const diff = `
--- a/packages/core/src/shell-edits.test.ts
+++ b/packages/core/src/shell-edits.test.ts
@@ -4 +3,0 @@
-    "echo hi 2> err.txt",
@@ -7,2 +5,0 @@
-    "ls &> all.txt",
-    "cmd > \\"$OUT\\"",
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, [
      'packages/core/src/shell-edits.test.ts:4: "echo hi 2> err.txt",',
      'packages/core/src/shell-edits.test.ts:7: "ls &> all.txt",',
      'packages/core/src/shell-edits.test.ts:8: "cmd > \\"$OUT\\"",',
    ]);
  });

  test("Case 2: it.each with template-literal table", () => {
    const oldContent = `
it.each\`
  a | b | expected
  1 | 2 | 3
  4 | 5 | 9
\`("adds", () => {});
`.trimStart();

    const diff = `
--- a/test.ts
+++ b/test.ts
@@ -3 +2,0 @@
-  1 | 2 | 3
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, ["test.ts:3: 1 | 2 | 3"]);
  });

  test("Case 3: row moved within the table (0 removals)", () => {
    const oldContent = `
test.each([
  "case-1",
  "case-2",
])("%s", () => {});
`.trimStart();

    const diff = `
--- a/test.ts
+++ b/test.ts
@@ -2,2 +2,2 @@
-  "case-1",
-  "case-2",
+  "case-2",
+  "case-1",
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, []);
  });

  test("Case 4: row edited (counted as removal)", () => {
    const oldContent = `
test.each([
  "case-old",
])("%s", () => {});
`.trimStart();

    const diff = `
--- a/test.ts
+++ b/test.ts
@@ -2 +2 @@
-  "case-old",
+  "case-new",
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, ['test.ts:2: "case-old",']);
  });

  test("Case 5: removed expect( line still counted", () => {
    const oldContent = `
test("something", () => {
  expect(1).toBe(1);
});
`.trimStart();

    const diff = `
--- a/test.ts
+++ b/test.ts
@@ -2 +1,0 @@
-  expect(1).toBe(1);
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, ["test.ts:2: expect(1).toBe(1);"]);
  });

  test("Case 6: removed plain helper line outside any table not counted", () => {
    const oldContent = `
const helper = (x) => x + 1;
test("something", () => {});
`.trimStart();

    const diff = `
--- a/test.ts
+++ b/test.ts
@@ -1 +0,0 @@
-const helper = (x) => x + 1;
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, []);
  });

  test("Case 7: unreadable old file -> fail closed", () => {
    const diff = `
--- a/test.ts
+++ b/test.ts
@@ -1 +0,0 @@
-const helper = (x) => x + 1;
`.trimStart();

    const removed = removedLines(diff, () => null);
    assert.deepEqual(removed, ["test.ts:1: const helper = (x) => x + 1;"]);
  });

  test("Case 8: check against real history on commit 21416d7 (must report the 3 rows)", () => {
    const diff = execFileSync(
      "git",
      ["diff", "-U0", "21416d7^", "21416d7", "--", "packages/core/src/shell-edits.test.ts"],
      { encoding: "utf8" }
    );
    const removed = removedLines(diff, (p) =>
      execFileSync("git", ["show", `21416d7^:${p}`], { encoding: "utf8" })
    );
    assert.deepEqual(removed, [
      'packages/core/src/shell-edits.test.ts:81: "echo hi 2> err.txt",',
      'packages/core/src/shell-edits.test.ts:84: "ls &> all.txt",',
      'packages/core/src/shell-edits.test.ts:85: "cmd > \\"$OUT\\"",',
    ]);
  });
});
