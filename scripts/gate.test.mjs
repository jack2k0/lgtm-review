import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removedLines, run, tierOf } from "./gate.mjs";

function hasHistory() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "21416d7^^{commit}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

  test(
    "Case 8: check against real history on commit 21416d7 (must report the 3 rows)",
    {
      skip:
        !process.env.CI && !hasHistory()
          ? "commit 21416d7 is missing, this looks like a shallow clone, run `git fetch --unshallow` to run this test"
          : false,
    },
    () => {
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
    }
  );

  test("F1: .each(cases) with external array is detected; fail closed if unresolved", () => {
    const oldContent = `
const cases = [
  {
    cmd: "a",
    want: 1,
  },
  {
    cmd: "b",
    want: 2,
  },
];
test.each(cases)("t %s", () => {});
`.trimStart();

    const diff = `
--- a/n.test.ts
+++ b/n.test.ts
@@ -6,4 +5,0 @@
-  {
-    cmd: "b",
-    want: 2,
-  },
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, [
      'n.test.ts:6: {',
      'n.test.ts:7: cmd: "b",',
      'n.test.ts:8: want: 2,',
      'n.test.ts:9: },',
    ]);

    // Unresolved external call -> fail closed
    const oldUnresolved = `
test.each(makeCases())("t", () => {});
const helper = 1;
`.trimStart();
    const diffUnresolved = `
--- a/u.test.ts
+++ b/u.test.ts
@@ -2 +1,0 @@
-const helper = 1;
`.trimStart();
    const removedUnresolved = removedLines(diffUnresolved, () => oldUnresolved);
    assert.deepEqual(removedUnresolved, ["u.test.ts:2: const helper = 1;"]);
  });

  test("F2: E3 moves are scoped to the same enclosing unit", () => {
    // Cross-table move: not excused
    const oldTables = `
test.each([
  { cmd: "echo hi", want: 1 },
])("x", () => {});
test.each([
  { cmd: "z", want: 9 },
])("y", () => {});
`.trimStart();

    const diffTables = `
--- a/q.test.ts
+++ b/q.test.ts
@@ -2 +1,0 @@
-  { cmd: "echo hi", want: 1 },
@@ -5,0 +5 @@
+  { cmd: "echo hi", want: 1 },
`.trimStart();

    const removedTables = removedLines(diffTables, () => oldTables);
    assert.deepEqual(removedTables, ['q.test.ts:2: { cmd: "echo hi", want: 1 },']);

    // Cross-test move: not excused
    const oldTests = `
test("a", () => {
  expect(f(1)).toBe(2);
});
test("b", () => {
  const x = 1;
});
`.trimStart();

    const diffTests = `
--- a/r.test.ts
+++ b/r.test.ts
@@ -2 +1,0 @@
-  expect(f(1)).toBe(2);
@@ -5,0 +5 @@
+  expect(f(1)).toBe(2);
`.trimStart();

    const removedTests = removedLines(diffTests, () => oldTests);
    assert.deepEqual(removedTests, ["r.test.ts:2: expect(f(1)).toBe(2);"]);
  });

  test("F3: diff header parse boundary and table comment preservation", () => {
    // Content starting with -- drop must not break diff parsing
    const oldM3 = `
test.each([
  { s: \`
-- drop
\`, w: 1 },
])("x", () => {});
`.trimStart();

    const diffM3 = `
--- a/m3.test.ts
+++ b/m3.test.ts
@@ -3 +2,0 @@
--- drop
`.trimStart();

    const removedM3 = removedLines(diffM3, () => oldM3);
    assert.deepEqual(removedM3, ["m3.test.ts:3: -- drop"]);

    // Comment line inside table template is preserved and not skipped
    const oldP2 = `
test.each([
  { out: \`
// keep
* keep2
\` },
])("y", () => {});
`.trimStart();

    const diffP2 = `
--- a/p2.test.ts
+++ b/p2.test.ts
@@ -3 +2,0 @@
-// keep
`.trimStart();

    const removedP2 = removedLines(diffP2, () => oldP2);
    assert.deepEqual(removedP2, ["p2.test.ts:3: // keep"]);
  });

  test("F4: backslash newline continuation does not drift line counter", () => {
    const oldContent = `
const a = \`1 \\
2\`;
const b = \`3 \\
4\`;
const c = \`5 \\
6\`;
test.each([
  { cmd: "a", want: 1 },
  {
    cmd: "b",
    want: 2,
    extra: 3,
  },
])("x", () => {});
`.trimStart();

    const diff = `
--- a/l3.test.ts
+++ b/l3.test.ts
@@ -9,5 +8,0 @@
-  {
-    cmd: "b",
-    want: 2,
-    extra: 3,
-  },
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, [
      'l3.test.ts:9: {',
      'l3.test.ts:10: cmd: "b",',
      'l3.test.ts:11: want: 2,',
      'l3.test.ts:12: extra: 3,',
      'l3.test.ts:13: },',
    ]);
  });

  test("F5: removed commented expectation // expect(...) is reported", () => {
    const oldContent = `
test("a", () => {
  // expect(f(1)).toBe(2);
  const x = 1;
});
`.trimStart();

    const diff = `
--- a/s.test.ts
+++ b/s.test.ts
@@ -2 +1,0 @@
-  // expect(f(1)).toBe(2);
`.trimStart();

    const removed = removedLines(diff, () => oldContent);
    assert.deepEqual(removed, ["s.test.ts:2: // expect(f(1)).toBe(2);"]);
  });
});

/** Temp repo with a base commit on main; `edit` runs on a change branch; `inspect(dir)` runs after the gate. */
function gateIn(base, edit, argv = ["--base", "main"], inspect = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "gate-cov-"));
  const cwd = process.cwd();
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  const put = (rel, text) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  try {
    sh("init", "-q", "-b", "main");
    sh("config", "user.email", "t@t");
    sh("config", "user.name", "t");
    for (const [k, v] of Object.entries(base)) put(k, v);
    sh("add", "-A");
    sh("commit", "-q", "-m", "base");
    sh("checkout", "-q", "-b", "change");
    process.chdir(dir);
    edit({ dir, put, sh });
    let text = "";
    const code = run(argv, process.env, (t) => (text += t));
    inspect(dir);
    return { code, text };
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gate coverage (S-39)", () => {
  const fx = "packages/core/fixtures/sessions/a.jsonl";
  test("modified existing session fixture is a hard fail", () => {
    const r = gateIn({ [fx]: "{}\n" }, ({ put }) => put(fx, '{"x":1}\n'));
    assert.equal(r.code, 1);
    assert.match(r.text, /FAIL ground-truth.*session fixture/);
  });
  test("deleted existing session fixture is a hard fail", () => {
    const r = gateIn({ [fx]: "{}\n" }, ({ dir }) => rmSync(join(dir, fx)));
    assert.equal(r.code, 1);
    assert.match(r.text, /FAIL ground-truth/);
  });
  test("a new session fixture stays allowed", () => {
    const r = gateIn({ "README.md": "x\n" }, ({ put }) => put(fx, "{}\n"));
    assert.match(r.text, /PASS ground-truth/);
  });
  test("pnpm-workspace.yaml needs deps: yes", () => {
    const r = gateIn({ "pnpm-workspace.yaml": "a: 1\n" }, ({ put }) => put("pnpm-workspace.yaml", "a: 2\n"));
    assert.equal(r.code, 1);
    assert.match(r.text, /FAIL dependencies/);
  });
  test("removed expectation in .mjs, .spec and perf tests is reported", () => {
    for (const f of ["scripts/x.test.mjs", "packages/a/src/y.spec.ts", "scripts/z.perf.test.mjs"]) {
      const r = gateIn({ [f]: 'test("a", () => {\n  assert.equal(1, 1);\n});\n' }, ({ put }) => put(f, 'test("a", () => {\n});\n'));
      assert.equal(r.code, 2, f);
      assert.match(r.text, /EYES removed-expectations/, f);
    }
  });
  test("tiers: new High files, spec/mjs tests Low, gate.test.mjs High", () => {
    for (const f of [
      "packages/cli/src/format.ts",
      "packages/cli/src/map.ts",
      "packages/cli/src/llm.ts",
      "packages/cli/src/paths.ts",
      "packages/core/src/llm-input.ts",
      "packages/core/src/steps.ts",
      "packages/core/src/node/discover.ts",
      "packages/core/src/node/worktrees.ts",
      "scripts/gate.test.mjs",
    ]) assert.equal(tierOf(f), "High", f);
    for (const f of ["packages/a/src/x.spec.ts", "scripts/other.test.mjs"]) assert.equal(tierOf(f), "Low", f);
  });
  test("gate does not rewrite .git/index (git --no-optional-locks)", () => {
    let before;
    let after;
    gateIn(
      { "a.txt": "a\n" },
      ({ dir, put }) => {
        put("b.txt", "b\n");
        execFileSync("git", ["add", "-A"], { cwd: dir });
        execFileSync("git", ["commit", "-q", "-m", "c"], { cwd: dir });
        const t = new Date(Date.now() + 5000); // stale stat cache: a plain `git status` would refresh the index
        utimesSync(join(dir, "b.txt"), t, t);
        before = readFileSync(join(dir, ".git", "index"));
      },
      ["--base", "main", "--merge"],
      (dir) => (after = readFileSync(join(dir, ".git", "index")))
    );
    assert.ok(before.equals(after));
  });
});
