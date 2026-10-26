#!/usr/bin/env node
// Deterministic pre-merge gate: mechanical checks on a branch plus a risk tier, printed as a short evidence block.
//
//   node scripts/gate.mjs [--base main] [--head <ref>] [--plan <plan.md>] [--run-check] [--merge [--findings <findings.md>]]
//   node scripts/gate.mjs --tiers        (print the tier table; REVIEW.md points here)
//
// Run from a worktree. Without --head the working tree is compared (committed + uncommitted + untracked).
// Exit 0 = pass, 1 = hard fail, 2 = pass but needs a human look. Git is only called read-only with fixed args (no shell).
//
// A plan may carry a fenced block (language `gate`); keys: allow (regex, repeatable), goldens (regex),
// labels (new-only | none), deps (yes | no), schema (yes | no):
//   ```gate
//   allow: ^packages/core/src/(check-patterns|scope)(\.test)?\.ts$
//   goldens: scoped-checks\.
//   ```
//
// --merge adds the pre-merge review check (REVIEW.md): Low needs no reviewer, Medium one, High two. The ledger is
// --findings, default <plan dir>/reviews/findings.md, with a `reviewers: a, b` line and a Markdown table whose
// Verdict column is fixed | rejected | deferred for every row. A missing ledger, too few reviewers or an
// unanswered finding is a hard fail.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Risk tier table. First match wins, High before Low before Medium; no match = Medium. Edit here only. */
export const TIERS = {
  High: [
    /^packages\/core\/src\/(analyze|check-patterns|shell-edits|parse|subagents|redact|schema|inherit|hints|scope)\.ts$/,
    /^packages\/cli\/src\/(server|security|export|export-html|summary|api)\.ts$/,
    /^packages\/core\/src\/node\/(git|archive|read|subagents)\.ts$/,
    /^packages\/web\/src\/token\.ts$/,
    /\.labels\.json$/,
    /^\.github\//,
    /(^|\/)package\.json$/,
    /^pnpm-lock\.yaml$/,
    /^scripts\/(smoke-pack|build-demo|gate)\.mjs$/,
    /^(REVIEW|AGENTS|CLAUDE)\.md$/,
  ],
  Low: [/\.md$/, /^context\//, /^docs\//, /\.test\.tsx?$/, /(^|\/)__golden__\//],
  Medium: [/^packages\/[^/]+\/src\//, /^scripts\//],
};
const RANK = { Low: 0, Medium: 1, High: 2 };
/** Distinct pre-merge reviewers required per tier (REVIEW.md). */
export const REVIEWERS = { Low: 0, Medium: 1, High: 2 };
const VERDICTS = ["fixed", "rejected", "deferred"];
const LIST_CAP = 15;
const LABELS_RE = /^packages\/core\/fixtures\/sessions\/[^/]+\.labels\.json$/;
const DEP_RE = /(^|\/)package\.json$|^pnpm-lock\.yaml$/;
const SCHEMA = "packages/core/src/schema.ts";
const EXPECT_RE = /expect\(|assert| it\(|test\(|^\s*\[/;

export function tierOf(file) {
  for (const t of ["High", "Low", "Medium"]) if (TIERS[t].some((re) => re.test(file))) return t;
  return "Medium";
}

/** Parse the first fenced `gate` block of a plan; null when there is none. */
export function parseGateBlock(text) {
  const m = /^```gate[ \t]*\r?\n([\s\S]*?)^```/m.exec(text);
  if (!m) return null;
  const g = { allow: [], goldens: null, labels: "new-only", deps: "no", schema: "no" };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([a-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === "allow") g.allow.push(new RegExp(v));
    else if (k === "goldens") g.goldens = new RegExp(v);
    else if (k === "labels" || k === "deps" || k === "schema") g[k] = v;
  }
  return g;
}

/**
 * Parse a findings ledger: reviewer names, and one { line, verdict } per table row below a header. Fails closed:
 * a row in a table without a Verdict column gets verdict "" (unanswered). Rows may omit the outer pipes; `\|` is
 * a literal pipe inside a cell. Only a bare name counts as a reviewer (a placeholder like `<a>` does not).
 */
export function parseLedger(text) {
  const rv = /^reviewers\s*:\s*(.*)$/im.exec(text);
  const names = (rv?.[1] ?? "").split(",").map((r) => r.trim().toLowerCase());
  const reviewers = [...new Set(names.filter((r) => /^[a-z0-9][\w.+-]*$/.test(r) && r !== "none"))];
  const rows = [];
  let col = null; // null = outside a table; -1 = table without a Verdict column
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const t = line.trim();
    if (fence || !/(^|[^\\])\|/.test(t)) return void (col = null);
    const cells = t.replace(/^\|/, "").replace(/(^|[^\\])\|$/, "$1").split(/(?<!\\)\|/).map((c) => c.trim());
    if (col === null) return void (col = cells.findIndex((c) => /^verdict\b/i.test(c)));
    if (cells.every((c) => /^:?-+:?$/.test(c))) return;
    const cell = col < 0 ? "" : (cells[col] ?? "").toLowerCase();
    rows.push({ line: i + 1, verdict: /^([a-z]+)(?=$|[\s(:,;])/.exec(cell)?.[1] ?? cell });
  });
  return { reviewers, rows };
}

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** Removed lines of test files as "file:oldLine: text" (old-side line numbers). */
export function removedLines(diff) {
  const out = [];
  let file = null;
  let old = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) file = line.startsWith("--- a/") ? line.slice(6) : null;
    else if (line.startsWith("+++ ")) continue;
    else if (line.startsWith("@@")) old = Number(/^@@ -(\d+)/.exec(line)?.[1] ?? 0);
    else if (line.startsWith("-")) {
      if (file && EXPECT_RE.test(line.slice(1))) out.push(`${file}:${old}: ${line.slice(1).trim().slice(0, 80)}`);
      old++;
    }
  }
  return out;
}

function parseStatus(text) {
  return text.split("\n").filter(Boolean).map((l) => {
    const [s, ...p] = l.split("\t");
    return { status: s[0], path: p.join("\t") };
  });
}

function short(sha) {
  return sha.slice(0, 10);
}

export function run(argv, env = process.env, out = (s) => process.stdout.write(s)) {
  const { values } = parseArgs({ args: argv, options: { base: { type: "string", default: "main" }, head: { type: "string" }, plan: { type: "string" }, "run-check": { type: "boolean", default: false }, merge: { type: "boolean", default: false }, findings: { type: "string" }, tiers: { type: "boolean", default: false } } });
  if (values.tiers) {
    const lines = ["tier   reviewers  paths (first match wins: High, Low, Medium; no match = Medium)"];
    for (const t of ["High", "Low", "Medium"]) for (const re of TIERS[t]) lines.push(`${t.padEnd(7)}${String(REVIEWERS[t]).padEnd(11)}${re.source}`);
    out(`${lines.join("\n")}\n`);
    return 0;
  }
  const head = values.head ?? "HEAD";
  const baseSha = git(["rev-parse", "--verify", `${values.base}^{commit}`]).trim();
  const headSha = git(["rev-parse", "--verify", `${head}^{commit}`]).trim();
  const mb = git(["merge-base", headSha, baseSha]).trim();
  const gate = values.plan ? parseGateBlock(readFileSync(values.plan, "utf8")) : null;

  // Files changed since the merge-base. Renames are split into delete + add so a moved file counts on both sides.
  const target = values.head ? [mb, headSha] : [mb];
  const files = parseStatus(git(["diff", "--name-status", "--no-renames", ...target]));
  if (!values.head) {
    for (const p of git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) files.push({ status: "A", path: p });
  }
  const paths = files.map((f) => f.path);

  const results = []; // { name, verdict: PASS|FAIL|EYES|SKIP, reason, items }
  const add = (name, verdict, reason, items = []) => results.push({ name, verdict, reason, items });
  const bad = (name, list, reason, verdict = "FAIL") => (list.length ? add(name, verdict, `${list.length} ${reason}`, list) : null);

  // 1. Up to date
  if (mb === baseSha) add("up-to-date", "PASS", `merge-base is ${values.base} head`);
  else add("up-to-date", "EYES", `merge ${values.base} first (merge-base ${short(mb)} != ${short(baseSha)})`);

  // 2. Scope
  if (!gate || gate.allow.length === 0) add("scope", "SKIP", values.plan ? "no gate block with allow in the plan" : "no --plan given");
  else {
    const out = paths.filter((p) => !gate.allow.some((re) => re.test(p)));
    if (!bad("scope", out, "file(s) outside the allowlist")) add("scope", "PASS", "all files match allow");
  }

  // 3. Ground truth
  const labels = files.filter((f) => LABELS_RE.test(f.path));
  const touched = labels.filter((f) => f.status !== "A").map((f) => `${f.status} ${f.path}`);
  const added = labels.filter((f) => f.status === "A").map((f) => `A ${f.path}`);
  const labelsMode = gate?.labels ?? "new-only";
  if (touched.length) add("ground-truth", "FAIL", `${touched.length} existing label file(s) modified/deleted (a label change means the rule is wrong)`, touched);
  else if (added.length && labelsMode !== "new-only") add("ground-truth", "FAIL", `${added.length} new label file(s) but labels: ${labelsMode}`, added);
  else add("ground-truth", "PASS", added.length ? `${added.length} new label file(s) only` : "no label changes", added);

  // 4. Goldens
  const goldens = paths.filter((p) => /(^|\/)__golden__\//.test(p));
  if (!goldens.length) add("goldens", "PASS", "no golden changes");
  else if (!gate) add("goldens", "EYES", `${goldens.length} golden file(s) changed, no gate block`, goldens);
  else {
    const out = goldens.filter((p) => !(gate.goldens && gate.goldens.test(p)));
    if (!bad("goldens", out, "golden file(s) outside the goldens pattern")) add("goldens", "PASS", `${goldens.length} golden file(s), all match goldens`, goldens);
  }

  // 5. Removed expectations
  const testPaths = paths.filter((p) => /\.test\.tsx?$/.test(p));
  const removed = testPaths.length ? removedLines(git(["diff", "-U0", "--no-renames", ...target, "--", "*.test.ts", "*.test.tsx"])) : [];
  if (!bad("removed-expectations", removed, "removed test line(s) with expectations", "EYES")) add("removed-expectations", "PASS", "none removed");

  // 6. Dependencies
  const deps = paths.filter((p) => DEP_RE.test(p));
  const depsMode = gate?.deps ?? "no";
  let forceHigh = false;
  if (!deps.length) add("dependencies", "PASS", "no manifest/lockfile changes");
  else if (depsMode === "yes") {
    forceHigh = true;
    add("dependencies", "EYES", `${deps.length} manifest/lockfile change(s) allowed by plan (tier High)`, deps);
  } else add("dependencies", "FAIL", `${deps.length} manifest/lockfile change(s) but deps: ${depsMode}`, deps);

  // 7. Schema
  if (!paths.includes(SCHEMA)) add("schema", "PASS", "schema.ts unchanged");
  else if (gate?.schema === "yes") add("schema", "PASS", "schema.ts changed, allowed by plan");
  else add("schema", "FAIL", "schema.ts changed without schema: yes", [SCHEMA]);

  // 8. Check
  let tail = null;
  if (values["run-check"]) {
    const cmd = env.GATE_CHECK_CMD;
    const r = cmd ? spawnSync(cmd, { shell: true, encoding: "utf8", env }) : spawnSync("pnpm", ["check"], { encoding: "utf8", env });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n");
    tail = text.slice(-5);
    add("check", r.status === 0 ? "PASS" : "FAIL", r.status === 0 ? "check exited 0" : `check exited ${r.status ?? r.signal ?? "with an error"}`);
  } else add("check", "SKIP", "not run (no --run-check)");

  // 9. Tier
  let tier = "Low";
  for (const p of paths) if (RANK[tierOf(p)] > RANK[tier]) tier = tierOf(p);
  if (forceHigh) tier = "High";

  // 10. Pre-merge review (only with --merge; workers run the gate before review exists)
  const need = REVIEWERS[tier];
  const ledgerPath = values.findings ?? (values.plan ? join(dirname(values.plan), "reviews", "findings.md") : null);
  if (!values.merge) add("review", "SKIP", "not checked (no --merge)");
  else if (need === 0) add("review", "PASS", "tier Low: no reviewer required");
  else if (!ledgerPath || !existsSync(ledgerPath)) add("review", "FAIL", `tier ${tier} needs ${need} reviewer(s); no findings ledger${ledgerPath ? ` at ${ledgerPath}` : " (--findings or --plan)"}`);
  else {
    const { reviewers, rows } = parseLedger(readFileSync(ledgerPath, "utf8"));
    const open = rows.filter((r) => !VERDICTS.includes(r.verdict)).map((r) => `${ledgerPath}:${r.line}: verdict "${r.verdict}"`);
    const tally = VERDICTS.map((v) => `${rows.filter((r) => r.verdict === v).length} ${v}`).join(", ");
    if (reviewers.length < need) add("review", "FAIL", `tier ${tier} needs ${need} reviewer(s), ledger names ${reviewers.length}`);
    else if (!bad("review", open, "unanswered finding(s) (verdict must be fixed | rejected | deferred)")) add("review", "PASS", `${reviewers.join(" + ")}; ${rows.length} finding(s): ${tally}`);
  }

  const lines = ["## Merge gate", `base ${values.base} ${short(baseSha)} / head ${values.head ?? "worktree"} ${short(headSha)}`, `changed files: ${paths.length}`, `tier: ${tier}`];
  for (const r of results) {
    lines.push(`- ${r.verdict} ${r.name}: ${r.reason}`);
    for (const it of r.items.slice(0, LIST_CAP)) lines.push(`    ${it}`);
    if (r.items.length > LIST_CAP) lines.push(`    … ${r.items.length - LIST_CAP} more`);
  }
  if (tail) lines.push("check output (last 5 lines):", "```", ...tail, "```");
  const code = results.some((r) => r.verdict === "FAIL") ? 1 : results.some((r) => r.verdict === "EYES") ? 2 : 0;
  if (values.merge && tier === "High") lines.push("owner: read this block before push (tier High)");
  lines.push(`result: ${["PASS", "FAIL", "NEEDS-EYES"][code]} (exit ${code})`);
  out(`${lines.join("\n")}\n`);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`gate: ${e instanceof Error ? e.message.split("\n")[0] : e}\n`);
    process.exitCode = 1;
  }
}
