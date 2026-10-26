import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../../scripts/gate.mjs");
const LABELS = "packages/core/fixtures/sessions/a.labels.json";

let tmp: string;
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const put = (dir: string, files: Record<string, string>) => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
};
/** A repo on `main` with some base files, then a branch `work` where `change` is applied and committed. */
function repo(base: Record<string, string>, change: Record<string, string>, opts: { advanceMain?: boolean } = {}) {
  const dir = join(tmp, `r${n++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  put(dir, { "README.md": "x\n", ...base });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-qb", "work");
  put(dir, change);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "work");
  if (opts.advanceMain) {
    git(dir, "checkout", "-q", "main");
    put(dir, { "other.txt": "o\n" });
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "main moves");
    git(dir, "checkout", "-q", "work");
  }
  return dir;
}
const gate = (cwd: string, args: string[] = [], env: Record<string, string> = {}) => {
  const r = spawnSync("node", [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const plan = (dir: string, body: string) => {
  const p = join(dir, "..", `plan${n++}.md`);
  writeFileSync(p, `# plan\n\n\`\`\`gate\n${body}\n\`\`\`\n`);
  return p;
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-gate-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("scripts/gate.mjs", () => {
  test("clean docs-only branch passes with tier Low and exit 0", () => {
    const d = repo({}, { "docs/a.md": "hi\n" });
    const r = gate(d);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^tier: Low$/m);
    expect(r.out).toMatch(/^changed files: 1$/m);
    expect(r.out).toMatch(/^base main [0-9a-f]{10} \/ head worktree [0-9a-f]{10}$/m);
    expect(r.out.trimEnd().split("\n").length).toBeLessThanOrEqual(20);
  });

  test("a stale branch needs eyes (exit 2) and says to merge main", () => {
    const d = repo({}, { "docs/a.md": "hi\n" }, { advanceMain: true });
    const r = gate(d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/EYES up-to-date: merge main first/);
  });

  test("scope: files outside allow are a hard fail; matching files pass; no gate block skips", () => {
    const d = repo({}, { "packages/core/src/scope.ts": "a\n", "packages/core/src/other.ts": "b\n" });
    const bad = gate(d, ["--plan", plan(d, "allow: ^packages/core/src/scope\\.ts$")]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/FAIL scope: 1 file/);
    expect(bad.out).toContain("packages/core/src/other.ts");
    const ok = gate(d, ["--plan", plan(d, "allow: ^packages/core/src/scope\\.ts$\nallow: other\\.ts$")]);
    expect(ok.out).toMatch(/PASS scope/);
    const skipped = join(tmp, "noblock.md");
    writeFileSync(skipped, "# no block\n");
    expect(gate(d, ["--plan", skipped]).out).toMatch(/SKIP scope: no gate block/);
  });

  test("ground truth: modifying or deleting an existing labels file fails, even with labels: new-only", () => {
    const m = repo({ [LABELS]: "{}\n" }, { [LABELS]: '{"a":1}\n' });
    const r = gate(m, ["--plan", plan(m, "allow: .*\nlabels: new-only")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL ground-truth: 1 existing label file/);
    expect(r.out).toContain(`M ${LABELS}`);
    expect(r.out).toMatch(/^tier: High$/m);
    const del = repo({ [LABELS]: "{}\n" }, {});
    spawnSync("git", ["rm", "-q", LABELS], { cwd: del });
    expect(gate(del).out).toMatch(/FAIL ground-truth/);
  });

  test("ground truth: a new labels file is allowed by default and fails with labels: none", () => {
    const d = repo({}, { [LABELS]: "{}\n" });
    expect(gate(d).code).toBe(0);
    const r = gate(d, ["--plan", plan(d, "labels: none")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL ground-truth: 1 new label file/);
  });

  test("goldens: needs eyes without a gate block, passes when matching, fails otherwise", () => {
    const d = repo({}, { "packages/core/src/__golden__/scoped-checks.json": "1\n" });
    const none = gate(d);
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/EYES goldens: 1 golden file\(s\) changed, no gate block/);
    expect(gate(d, ["--plan", plan(d, "goldens: scoped-checks\\.")]).code).toBe(0);
    const bad = gate(d, ["--plan", plan(d, "goldens: other\\.")]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/FAIL goldens/);
  });

  test("removed expectations are listed with the old file:line (needs eyes); added ones are not", () => {
    const base = { "packages/core/src/x.test.ts": 'a\nexpect(1).toBe(1);\nconst k = 2;\n  ["row", 1],\ntest("t", () => {});\n' };
    const d = repo(base, { "packages/core/src/x.test.ts": 'a\nconst k = 3;\nexpect(2).toBe(2);\n' });
    const r = gate(d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/EYES removed-expectations: 3 removed/);
    expect(r.out).toContain("packages/core/src/x.test.ts:2: expect(1).toBe(1);");
    expect(r.out).toContain('packages/core/src/x.test.ts:4: ["row", 1],');
    expect(r.out).toContain('packages/core/src/x.test.ts:5: test("t"');
    expect(r.out).not.toContain(":3:");
    const only = repo(base, { "packages/core/src/x.test.ts": `${base["packages/core/src/x.test.ts"]}expect(3);\n` });
    expect(gate(only).code).toBe(0);
  });

  test("listed items are capped at 15", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`packages/core/src/__golden__/g${i}.json`] = "1\n";
    const r = gate(repo({}, many));
    expect(r.out).toContain("… 5 more");
  });

  test("dependencies: fail by default, allowed with deps: yes (tier High, needs eyes)", () => {
    const d = repo({ "package.json": "{}\n" }, { "package.json": '{"a":1}\n', "pnpm-lock.yaml": "x\n" });
    const r = gate(d);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL dependencies: 2 manifest/);
    const ok = gate(d, ["--plan", plan(d, "deps: yes")]);
    expect(ok.code).toBe(2);
    expect(ok.out).toMatch(/^tier: High$/m);
  });

  test("schema: hard fail unless schema: yes", () => {
    const d = repo({}, { "packages/core/src/schema.ts": "s\n" });
    const r = gate(d);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL schema/);
    const ok = gate(d, ["--plan", plan(d, "schema: yes")]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/PASS schema: schema.ts changed, allowed/);
  });

  test("uncommitted and untracked changes count; --head compares a ref instead of the worktree", () => {
    const d = repo({}, { "docs/a.md": "hi\n" });
    writeFileSync(join(d, "packages-new.ts"), "x\n");
    mkdirSync(join(d, "packages/core/src"), { recursive: true });
    writeFileSync(join(d, "packages/core/src/schema.ts"), "s\n");
    const wt = gate(d);
    expect(wt.code).toBe(1);
    expect(wt.out).toMatch(/^changed files: 3$/m);
    const ref = gate(d, ["--head", "work"]);
    expect(ref.code).toBe(0);
    expect(ref.out).toMatch(/^changed files: 1$/m);
  });

  test("tier is the highest across changed files", () => {
    const tier = (files: Record<string, string>) => /^tier: (\w+)$/m.exec(gate(repo({}, files)).out)?.[1];
    expect(tier({ "README.md": "y\n", "context/a.txt": "1\n", "packages/cli/src/a.test.ts": "t\n" })).toBe("Low");
    expect(tier({ "README.md": "y\n", "scripts/x.mjs": "1\n" })).toBe("Medium");
    expect(tier({ "packages/web/src/ui.tsx": "1\n", "scripts/x.mjs": "1\n" })).toBe("Medium");
    expect(tier({ "docs/a.md": "y\n", "packages/cli/src/server.ts": "1\n" })).toBe("High");
    expect(tier({ ".github/workflows/ci.yml": "1\n" })).toBe("High");
    expect(tier({ "scripts/smoke-pack.mjs": "1\n" })).toBe("High");
    expect(tier({ "REVIEW.md": "1\n" })).toBe("High");
    expect(tier({ "docs/REVIEW.md": "1\n" })).toBe("Low");
  });

  test("--run-check runs GATE_CHECK_CMD, prints the last 5 lines, and a non-zero exit is a hard fail", () => {
    const d = repo({}, { "docs/a.md": "hi\n" });
    const ok = gate(d, ["--run-check"], { GATE_CHECK_CMD: "seq 1 9" });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/PASS check/);
    expect(ok.out).toMatch(/5\n6\n7\n8\n9\n```/);
    expect(ok.out).not.toMatch(/^4$/m);
    const fail = gate(d, ["--run-check"], { GATE_CHECK_CMD: "echo boom; exit 3" });
    expect(fail.code).toBe(1);
    expect(fail.out).toMatch(/FAIL check: check exited 3/);
    expect(fail.out).toContain("boom");
  });

  test("without --merge the review check is skipped; Low needs no ledger", () => {
    const d = repo({}, { "docs/a.md": "hi\n" });
    expect(gate(d).out).toMatch(/SKIP review: not checked/);
    const r = gate(d, ["--merge"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PASS review: tier Low/);
  });

  test("--merge: Medium/High without a ledger, or with too few reviewers, is a hard fail", () => {
    const d = repo({}, { "scripts/x.mjs": "1\n" });
    const none = gate(d, ["--merge"]);
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/FAIL review: tier Medium needs 1 reviewer\(s\); no findings ledger \(--findings or --plan\)/);
    const p = plan(d, "allow: .*");
    expect(gate(d, ["--merge", "--plan", p]).out).toMatch(/no findings ledger at .*reviews\/findings\.md/);
    const hi = repo({}, { "packages/cli/src/server.ts": "1\n" });
    const f = join(tmp, `f${n++}.md`);
    writeFileSync(f, "reviewers: agy\n");
    const r = gate(hi, ["--merge", "--findings", f]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL review: tier High needs 2 reviewer\(s\), ledger names 1/);
    expect(r.out).toMatch(/^owner: read this block before push/m);
  });

  test("--merge: every finding needs a verdict; the ledger next to the plan is found by default", () => {
    const d = repo({}, { "packages/cli/src/server.ts": "1\n" });
    const p = plan(d, "allow: .*");
    const dir = join(dirname(p), "reviews");
    mkdirSync(dir, { recursive: true });
    const ledger = (rows: string) =>
      writeFileSync(join(dir, "findings.md"), `# Findings\n\nreviewers: Agy, OpenCode, agy\n\n| # | Tag | file:line | Verdict | Evidence |\n|---|---|---|:---:|---|\n${rows}`);
    ledger("| 1 | Important | a.ts:1 | fixed (abc123) | test |\n| 2 | Nit | b.ts:2 | | |\n| 3 | Nit | c.ts:3 | todo | |\n");
    const r = gate(d, ["--merge", "--plan", p]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL review: 2 unanswered finding/);
    expect(r.out).toMatch(/findings\.md:8: verdict ""/);
    expect(r.out).toMatch(/findings\.md:9: verdict "todo"/);
    ledger("| 1 | Important | a.ts:1 | fixed (abc123) | test |\n| 2 | Nit | b.ts:2 | Rejected | wrong |\n| 3 | Nit | c.ts:3 | deferred | later |\n");
    const ok = gate(d, ["--merge", "--plan", p]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/PASS review: agy \+ opencode; 3 finding\(s\): 1 fixed, 1 rejected, 1 deferred/);
  });

  test("--merge: ledgers fail closed (no Verdict column, no outer pipes, escaped pipes, loose verdicts, placeholders)", () => {
    const d = repo({}, { "scripts/x.mjs": "1\n" });
    const run = (body: string) => {
      const f = join(tmp, `l${n++}.md`);
      writeFileSync(f, body);
      return gate(d, ["--merge", "--findings", f]);
    };
    const noVerdict = run("reviewers: a\n\n| # | Status |\n|---|---|\n| 1 | open |\n");
    expect(noVerdict.code).toBe(1);
    expect(noVerdict.out).toMatch(/FAIL review: 1 unanswered/);
    expect(run("reviewers: a\n\n# | Verdict\n--|--\n1 | open\n").out).toMatch(/FAIL review: 1 unanswered/);
    expect(run("reviewers: a\n\n| # | Finding | Verdict | Why |\n|---|---|---|---|\n| 1 | a \\| fixed | | e |\n").out).toMatch(/FAIL review: 1 unanswered/);
    expect(run("reviewers: a\n\n| Verdict |\n|---|\n| fixed? |\n| fixed-not |\n| not fixed |\n").out).toMatch(/FAIL review: 3 unanswered/);
    expect(run("reviewers: <a>\n").out).toMatch(/ledger names 0/);
    expect(run("reviewers: a\n\n- 1. Important: leak. Verdict: open\n").out).toMatch(/FAIL review: no findings table rows/);
    expect(run("reviewers: a\nfindings: none\n").code).toBe(0);
    expect(run("reviewers: a\nfindings: none\n\n| Verdict |\n|---|\n| fixed |\n").out).toMatch(/FAIL review: `findings: none` but 1/);
    const T = "| # | Finding | Verdict |\n|---|---|---|\n| 1 | x | fixed |\n";
    expect(run(`reviewers: a\n\n${T}\n| 2 | after a blank line | |\n`).out).toMatch(/FAIL review: 1 unanswered.*\n.*:7: verdict ""/);
    expect(run(`reviewers: a\n\n${T}| 2 | in \`a | b\` | fixed | |\n`).out).toMatch(/FAIL review: 1 unanswered/);
    expect(run("reviewers: @a\n\n| Verdict |\n|---|\n| **fixed** |\n| `rejected`: no |\n").out).toMatch(/PASS review: a; 2 finding/);
    const ok = run("reviewers: a\n\n```\n| x | y |\n```\n\n| # | Verdict |\n|---|---|\n| 1 | fixed (abc) |\n| 2 | Deferred: S-22 |\n");
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/2 finding\(s\): 1 fixed, 0 rejected, 1 deferred/);
  });

  test("--merge fails on uncommitted or untracked files; without --merge they only count as changes", () => {
    const d = repo({}, { "docs/a.md": "hi\n" });
    writeFileSync(join(d, "docs/a.md"), "changed\n");
    writeFileSync(join(d, "docs/new.md"), "n\n");
    const r = gate(d, ["--merge"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL committed: 2 uncommitted or untracked file/);
    expect(r.out).toContain("docs/new.md");
    expect(gate(d).out).not.toMatch(/committed/);
    git(d, "add", "-A");
    git(d, "commit", "-qm", "c");
    expect(gate(d, ["--merge"]).out).toMatch(/PASS committed: worktree clean/);
  });

  test("--tiers prints the table with reviewer counts", () => {
    const r = gate(repo({}, {}), ["--tiers"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^High   2 +\^\\\.github/m);
    expect(r.out).toMatch(/^Medium 1 +\^scripts/m);
  });

  test("an unknown base is a hard fail with a message on stderr", () => {
    const r = gate(repo({}, {}), ["--base", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^gate: /m);
  });
});
