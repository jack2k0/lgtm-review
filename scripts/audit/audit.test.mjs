// Self-test of the audit scripts on the synthetic fixture (no real logs).  Run: node --test scripts/audit/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { categorize, toolReasonClass, truthOf } from "./compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function runTruth() {
  const tmp = mkdtempSync(join(tmpdir(), "lgtm-audit-test-"));
  try {
    const out = join(tmp, "truth.json");
    const r = spawnSync("python3", ["-I", join(here, "truth.py"), "--projects-dir", join(here, "fixtures/projects"), "--min-age-minutes", "0", "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("truth.py reproduces the expected status and reason class of every synthetic prompt", () => {
  const truth = runTruth();
  const expected = JSON.parse(readFileSync(join(here, "fixtures/expected.json"), "utf8"));
  const rows = truth.rows.filter((r) => r.session.startsWith("1111"));
  assert.equal(rows.length, expected.prompts.length);
  rows.forEach((r, i) => assert.deepEqual([r.status, r.reason], [expected.prompts[i].status, expected.prompts[i].reason], expected.prompts[i].label));
});

test("fork copies are marked as duplicates of the owning session and the new prompt is not", () => {
  const truth = runTruth();
  const fork = truth.rows.filter((r) => r.session.startsWith("2222"));
  assert.deepEqual(fork.map((r) => r.dup), [true, true, false]);
  assert.equal(fork[2].status, "checked");
});

test("the subagent transcript is merged into the spawning prompt", () => {
  const truth = runTruth();
  const row = truth.rows.find((r) => r.session.startsWith("1111") && r.agent);
  assert.ok(row);
  assert.equal(row.status, "checked");
  assert.ok(row.flags.includes("sub-edit") && row.flags.includes("sub-check"));
});

test("tool reason texts map to reason classes", () => {
  assert.equal(toolReasonClass("unchecked", "no checks ran (shell edits may be incomplete)"), "u-nocheck");
  assert.equal(toolReasonClass("unchecked", "2 edits after last check"), "u-after");
  assert.equal(toolReasonClass("unchecked", "check did not complete"), "u-incomplete");
  assert.equal(toolReasonClass("no-changes", "no edits (git operations only)"), "nc-git");
  assert.equal(toolReasonClass("no-changes", "no code edits (documentation only)"), "nc-doc");
  assert.equal(toolReasonClass("checked", "pnpm test passed after last edit"), "c-passed");
  assert.equal(toolReasonClass("failing", "pnpm test failed: 1 failed"), "f-failed");
});

test("categorize names the smallest tool behaviour that reproduces the tool answer", () => {
  const g = { status: "no-changes", reason: "nc-doc", statusStrict: "no-changes", reasonStrict: "nc-doc", statusCmd: "no-changes", reasonCmd: "nc-doc", agent: false, alt: { "shell-written-doc-or-scratch-counts": ["unchecked", "u-nocheck"] } };
  const c = categorize({ status: "unchecked", reasonClass: "u-nocheck" }, g);
  assert.equal(c.kind, "status");
  assert.match(c.cat, /shell-written-doc-or-scratch-counts/);
  assert.equal(categorize({ status: "checked", reasonClass: "c-passed" }, g).cat, "unexplained");
  assert.deepEqual(truthOf(g, "strict"), { status: "no-changes", reason: "nc-doc" });
});
