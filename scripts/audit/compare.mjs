#!/usr/bin/env node
// Joins `lgtm-review --list --json` (the tool) with the independent truth (scripts/audit/truth.py) per prompt
// and prints AGGREGATES ONLY: no prompt text, commands, paths or reasons.
//
//   node scripts/audit/compare.mjs [--projects-dir <dir>] [--cli <cli.js>] [--truth <truth.json>] [--min-age-minutes 30] [--json]
//
// Build first (`pnpm build`). Without --truth the script runs `python3 -I scripts/audit/truth.py` into a private
// temp dir that is removed afterwards. Never commit any output of the truth script.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

/** Reason class of the tool's reason text (see truth.py for the classes). */
export function toolReasonClass(status, reason) {
  const r = String(reason ?? "").toLowerCase();
  if (status === "no-changes") {
    if (/^no edits \(git operations only\)/.test(r)) return "nc-git";
    if (/^no code edits \(documentation and scratch/.test(r)) return "nc-docscratch";
    if (/^no code edits \(documentation only\)/.test(r)) return "nc-doc";
    if (/^no code edits \(scratch/.test(r)) return "nc-scratch";
    if (/^no edits/.test(r)) return "nc-none";
    return "nc-other";
  }
  if (status === "failing") return "f-failed";
  if (status === "checked") return "c-passed";
  if (/^no checks ran/.test(r)) return "u-nocheck";
  if (/^check did not complete/.test(r)) return "u-incomplete";
  if (/edits? after last/.test(r)) return "u-after";
  return "u-other";
}

const VARIANTS = ["main", "cmd", "strict"];
/** Truth status and reason class of a row for a variant: main (PRD v0.3 rules, git operations never count), cmd (command-level git reading), strict (git operations count). */
export function truthOf(g, variant) {
  if (variant === "strict") return { status: g.statusStrict, reason: g.reasonStrict };
  if (variant === "cmd") return { status: g.statusCmd, reason: g.reasonCmd };
  return { status: g.status, reason: g.reason };
}

/** Toggle names of truth.py, in priority order (the first toggle that reproduces the tool's answer names the category). */
export const TOGGLE_ORDER = [
  "git-op-in-mixed-command-counts",
  "git-ops-count-as-edits",
  "shell-written-doc-or-scratch-counts",
  "tool-written-scratch-counts",
  "tool-written-doc-counts",
  "subagents-not-analysed",
  "background-checks-unresolved",
  "masked-failure-evidence-ignored",
  "edit-after-check-in-same-command",
  "shell-edits-invisible",
  "wrapped-check-not-recognised",
  "script-checks-not-recognised",
];

/**
 * Category of a disagreement (main truth variant): the smallest set of tool behaviours, each a deviation from the truth
 * rules, under which the truth would equal the tool's answer. `exact` = status and reason class both reproduced,
 * `status-only` = only the status. No set of at most two behaviours reproduces it: "unexplained".
 */
export function categorize(t, g) {
  const base = truthOf(g, "main");
  const kind = t.status !== base.status ? "status" : "reason";
  const rank = (name) => name.split("+").map((x) => TOGGLE_ORDER.indexOf(x));
  const cmp = (a, b) => a.split("+").length - b.split("+").length || Math.min(...rank(a)) - Math.min(...rank(b)) || Math.max(...rank(a)) - Math.max(...rank(b));
  const alts = Object.entries(g.alt ?? {});
  const exact = alts.filter(([, v]) => v[0] === t.status && v[1] === t.reasonClass).map(([k]) => k).sort(cmp);
  const statusOnly = alts.filter(([, v]) => v[0] === t.status).map(([k]) => k).sort(cmp);
  let cat;
  if (exact.length) cat = `tool acts as if: ${exact[0].replaceAll("+", " + ")}`;
  else if (kind === "status" && statusOnly.length) cat = `tool acts as if: ${statusOnly[0].replaceAll("+", " + ")} (status only)`;
  else cat = g.agent ? "unexplained (prompt with Agent calls)" : "unexplained";
  const dir = kind === "status" ? `${t.status} -> ${base.status}` : `${t.reasonClass} -> ${base.reason}`;
  return { kind, cat, dir };
}

function firstCwds(file, max = 80) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const out = [];
    for (const line of buf.toString("utf8", 0, n).split("\n").slice(0, max)) {
      try {
        const o = JSON.parse(line);
        if (typeof o.cwd === "string") out.push(o.cwd);
      } catch {}
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

const encode = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

/** Repo dir of a project: a session cwd whose encoding is the project directory name (else the most common cwd). */
export function projectDir(projectsDir, name) {
  const counts = new Map();
  const dir = join(projectsDir, name);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const c of firstCwds(join(dir, f))) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const exact = [...counts].filter(([c]) => encode(c) === name).sort((a, b) => b[1] - a[1]);
  if (exact.length) return exact[0][0];
  const any = [...counts].sort((a, b) => b[1] - a[1]);
  return any.length ? any[0][0] : null;
}

const pct = (n, d) => (d === 0 ? "n/a" : `${n}/${d} = ${((n / d) * 100).toFixed(1)}%`);

export function compare(toolRows, truthRows, excluded) {
  const gmap = new Map(truthRows.map((g) => [`${g.session}|${g.uuid}`, g]));
  const skip = new Set(excluded.map((e) => e.session));
  const joined = [];
  let toolExtra = 0;
  let toolSkipped = 0;
  const seen = new Set();
  for (const t of toolRows) {
    if (skip.has(t.session)) {
      toolSkipped++;
      continue;
    }
    const g = gmap.get(`${t.session}|${t.uuid}`);
    if (!g) {
      toolExtra++;
      continue;
    }
    seen.add(`${t.session}|${t.uuid}`);
    t.reasonClass = toolReasonClass(t.status, t.reason);
    joined.push({ t, g });
  }
  const missing = { noActivity: 0, withActivity: 0 };
  for (const g of truthRows) {
    if (seen.has(`${g.session}|${g.uuid}`)) continue;
    if (g.nevents === 0 && g.status === "no-changes") missing.noActivity++;
    else missing.withActivity++;
  }
  return { joined, toolExtra, toolSkipped, missing };
}

function measure(rows, variant) {
  const n = rows.length;
  let st = 0;
  let rc = 0;
  for (const { t, g } of rows) {
    const v = truthOf(g, variant);
    if (t.status === v.status) st++;
    if (t.reasonClass === v.reason && t.status === v.status) rc++;
  }
  return { n, st, rc };
}

function confusion(rows, variant) {
  const names = ["checked", "unchecked", "failing", "no-changes"];
  const m = Object.fromEntries(names.map((a) => [a, Object.fromEntries(names.map((b) => [b, 0]))]));
  for (const { t, g } of rows) m[t.status][truthOf(g, variant).status]++;
  return { names, m };
}

function main() {
  const { values } = parseArgs({
    options: {
      "projects-dir": { type: "string" },
      cli: { type: "string" },
      truth: { type: "string" },
      "min-age-minutes": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: node scripts/audit/compare.mjs [--projects-dir <dir>] [--cli <cli.js>] [--truth <truth.json>] [--min-age-minutes 30] [--json]\nPrints aggregates only.");
    return 0;
  }
  const projectsDir = resolve(values["projects-dir"] ?? join(homedir(), ".claude", "projects"));
  if (!existsSync(projectsDir)) {
    console.error(`compare: no projects dir at ${projectsDir}`);
    return 2;
  }
  const cli = resolve(values.cli ?? join(here, "../../packages/cli/dist/cli.js"));
  const tmp = mkdtempSync(join(tmpdir(), "lgtm-audit-"));
  try {
    let truthFile = values.truth;
    if (!truthFile) {
      truthFile = join(tmp, "truth.json");
      const r = spawnSync("python3", ["-I", join(here, "truth.py"), "--projects-dir", projectsDir, "--out", truthFile, "--min-age-minutes", values["min-age-minutes"] ?? "30"], { encoding: "utf8" });
      if (r.status !== 0) {
        console.error(`compare: truth.py failed (${r.error ? r.error.message : `exit ${r.status}`})${r.stderr ? `: ${r.stderr.trim().split("\n").pop()}` : ""}`);
        return 1;
      }
    }
    const truth = JSON.parse(readFileSync(truthFile, "utf8"));
    const emptyArchive = join(tmp, "archive");
    const toolRows = [];
    let projects = 0;
    for (const name of readdirSync(projectsDir)) {
      let dir;
      try {
        dir = projectDir(projectsDir, name);
      } catch {
        continue;
      }
      if (!dir) continue;
      projects++;
      const r = spawnSync(process.execPath, [cli, "--dir", dir, "--projects-dir", projectsDir, "--archive-dir", emptyArchive, "--no-worktrees", "--list", "--json"], { encoding: "utf8", maxBuffer: 1 << 30 });
      if (r.status !== 0) {
        console.error(`compare: the CLI failed for one project (exit ${r.status}); is it built (pnpm build)?`);
        return 1;
      }
      for (const s of JSON.parse(r.stdout).sessions)
        for (const p of s.prompts) toolRows.push({ project: name, session: s.sessionId, uuid: p.uuid, status: p.status, reason: p.reason, partial: p.partial === true, inherited: p.inheritedFrom !== undefined });
    }
    const { joined, toolExtra, toolSkipped, missing } = compare(toolRows, truth.rows, truth.excluded);
    const populations = {
      A: joined.filter((x) => !x.g.agent),
      B: joined,
      C: joined.filter((x) => x.g.agent),
    };
    const out = { projects, toolRows: toolRows.length, toolRowsInCurrentSession: toolSkipped, toolRowsWithoutTruth: toolExtra, truthPromptsMissingFromTool: missing, populations: {}, confusionB: {}, mismatches: {} };
    const lines = [];
    lines.push(`projects: ${projects}; tool rows: ${toolRows.length}; excluded (session modified in the last ${values["min-age-minutes"] ?? 30} min): ${toolSkipped}; tool rows without truth row: ${toolExtra}`);
    lines.push(`truth prompts absent from the tool: ${missing.noActivity} without any activity (ignored), ${missing.withActivity} with activity`);
    for (const [pn, rows] of Object.entries(populations)) {
      const uniq = rows.filter((x) => !x.g.dup);
      const dupAgree = rows.filter((x) => x.g.dup).length === rows.filter((x) => x.t.inherited).length;
      const res = {};
      for (const variant of VARIANTS) res[variant] = { rows: measure(rows, variant), unique: measure(uniq, variant) };
      out.populations[pn] = { rows: rows.length, unique: uniq.length, duplicatesSameAsToolInherited: dupAgree, ...res };
      lines.push(`${pn}: rows ${rows.length}, unique uuid ${uniq.length}`);
      for (const variant of VARIANTS) {
        const m = res[variant];
        lines.push(`   ${variant.padEnd(6)} status ${pct(m.rows.st, m.rows.n)} (unique ${pct(m.unique.st, m.unique.n)}) | reason class ${pct(m.rows.rc, m.rows.n)} (unique ${pct(m.unique.rc, m.unique.n)})`);
      }
    }
    lines.push(`fork copies: duplicates by truth (uuid owned by an earlier session) == tool inheritedFrom rows: ${out.populations.B.duplicatesSameAsToolInherited}`);
    for (const variant of VARIANTS) {
      const cm = confusion(populations.B, variant);
      out.confusionB[variant] = cm.m;
      lines.push(`confusion matrix, B rows, truth variant ${variant} (tool rows x truth columns): ` + cm.names.join(" / "));
      for (const a of cm.names) lines.push(`  tool ${a.padEnd(10)} ${cm.names.map((b) => String(cm.m[a][b]).padStart(4)).join(" ")}`);
    }
    for (const [pn, rows] of Object.entries(populations)) {
      for (const variant of VARIANTS) {
        const cats = new Map();
        for (const { t, g } of rows) {
          const v = truthOf(g, variant);
          if (t.status === v.status && t.reasonClass === v.reason) continue;
          const c = categorize(t, g);
          const key = `${c.kind}: ${c.cat} (${c.dir})`;
          cats.set(key, (cats.get(key) ?? 0) + 1);
        }
        out.mismatches[`${pn} ${variant}`] = Object.fromEntries(cats);
        if (variant !== "main") continue;
        lines.push(`mismatch categories ${pn}, truth ${variant}:`);
        for (const [k, v] of [...cats].sort((a, b) => b[1] - a[1])) lines.push(`  ${String(v).padStart(3)}  ${k}`);
      }
    }
    {
      const bad = new Set();
      const all = new Set();
      for (const { t, g } of populations.B) {
        all.add(g.session);
        const v = truthOf(g, "main");
        if (t.status !== v.status || t.reasonClass !== v.reason) bad.add(g.session);
      }
      out.sessionsWithMismatch = { withMismatch: bad.size, sessions: all.size };
      lines.push(`sessions with at least one disagreement (B, main truth): ${bad.size} of ${all.size}`);
    }
    console.log(values.json ? JSON.stringify(out, null, 2) : lines.join("\n"));
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
