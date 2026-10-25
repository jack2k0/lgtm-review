#!/usr/bin/env node
// Re-runs the status audit on a local Claude Code projects dir: runs the built CLI (`--list --json`)
// and prints AGGREGATE COUNTS ONLY (no prompt text, paths, commands or reasons).
//
//   node scripts/audit-status.mjs [--dir <path>] [--projects-dir <path>] [--cli <path>] [--json]
//
// Build first: `pnpm build`. --dir and --projects-dir are passed to the CLI (defaults: cwd, ~/.claude/projects).
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const SHELL_SUFFIX = "(shell edits may be incomplete)";
const UNRELIABLE_SUFFIXES = ["(exit code not verified)", "(edits may have been reverted)", "(exit code masked)"];
const DOC_REASON_RE = /^no code edits \(documentation only\)|; \d+ documentation edits? after it/;

/** Aggregates of a parsed `--list --json` result. Exported-shape: plain numbers only. */
export function aggregate(analysis) {
  const sessions = Array.isArray(analysis?.sessions) ? analysis.sessions : [];
  const prompts = sessions.flatMap((s) => (Array.isArray(s.prompts) ? s.prompts : []));
  const status = { checked: 0, unchecked: 0, failing: 0, "no-changes": 0 };
  let partial = 0;
  let shell = 0;
  let docEdit = 0;
  let checkPrompts = 0;
  let unreliable = 0;
  for (const p of prompts) {
    if (p.status in status) status[p.status]++;
    if (p.partial === true) partial++;
    const reason = typeof p.reason === "string" ? p.reason : "";
    if (reason.includes(SHELL_SUFFIX)) shell++;
    if (DOC_REASON_RE.test(reason)) docEdit++;
    // A prompt that ends checked or failing on a completed check carries that check's reliability in its reason.
    if (p.status === "checked" || (p.status === "failing" && /(?:failed|masked)/.test(reason))) {
      checkPrompts++;
      if (UNRELIABLE_SUFFIXES.some((x) => reason.includes(x))) unreliable++;
    }
  }
  const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
  return {
    sessions: sessions.length,
    sessionsWithPrompts: sessions.filter((s) => Array.isArray(s.prompts) && s.prompts.length > 0).length,
    prompts: prompts.length,
    status,
    statusPct: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, pct(v, prompts.length)])),
    partial,
    partialPct: pct(partial, prompts.length),
    shellEditPrompts: shell,
    shellEditPct: pct(shell, prompts.length),
    docEditPrompts: docEdit,
    docEditPct: pct(docEdit, prompts.length),
    checkPrompts,
    unreliableChecks: unreliable,
    unreliableChecksPct: pct(unreliable, checkPrompts),
  };
}

function fmt(n, pct) {
  return pct === null ? `${n} (n/a)` : `${n} (${pct}%)`;
}

export function render(a) {
  const lines = [
    `sessions: ${a.sessions} (${a.sessionsWithPrompts} with prompts)`,
    `prompts: ${a.prompts}`,
    ...Object.keys(a.status).map((k) => `  ${k}: ${fmt(a.status[k], a.statusPct[k])}`),
    `partial (subagent activity not analysed): ${fmt(a.partial, a.partialPct)}`,
    `prompts with heuristic shell edits: ${fmt(a.shellEditPrompts, a.shellEditPct)}`,
    `prompts with documentation edits not counted: ${fmt(a.docEditPrompts, a.docEditPct)}`,
    `checks with unverified exit code (of ${a.checkPrompts} prompts that ended on a completed check): ${fmt(a.unreliableChecks, a.unreliableChecksPct)}`,
  ];
  return lines.join("\n");
}

function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      "projects-dir": { type: "string" },
      cli: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: node scripts/audit-status.mjs [--dir <path>] [--projects-dir <path>] [--cli <path>] [--json]\nPrints aggregate counts of `lgtm-review --list --json`; never prints content.");
    return 0;
  }
  const cli = resolve(values.cli ?? join(here, "../packages/cli/dist/cli.js"));
  const args = [cli, "--list", "--json"];
  if (values.dir !== undefined) args.push("--dir", values.dir);
  if (values["projects-dir"] !== undefined) args.push("--projects-dir", values["projects-dir"]);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) {
    console.error(`audit-status: the CLI failed (exit ${r.status ?? "none"}); is it built (pnpm build)?`);
    return 1;
  }
  let analysis;
  try {
    analysis = JSON.parse(r.stdout);
  } catch {
    console.error("audit-status: the CLI output is not JSON");
    return 1;
  }
  const agg = aggregate(analysis);
  console.log(values.json ? JSON.stringify(agg, null, 2) : render(agg));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
