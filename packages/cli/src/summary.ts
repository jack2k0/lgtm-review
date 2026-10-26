import { inheritedInfo, inheritedOthers } from "./format.js";
import { needsAttention, redact as coreRedact } from "@lgtm/core";
import type { Hint, PromptAnalysis, RedactOptions, Recommendation, SessionAnalysis, Status } from "@lgtm/core";
import { stripDroppedControls } from "./export-html.js";
import { osUsernames } from "./export.js";

export interface SummaryOptions {
  /** Show (redacted, shortened) prompt titles; false prints "Prompt N" instead. */
  titles: boolean;
  /** Repository directory; paths below it are printed relative to it. */
  root?: string;
  /** User names for redaction (defaults to osUsernames()). */
  usernames?: string[];
}

/** Longest prompt title in the summary, in characters. */
export const TITLE_MAX = 80;

const REC_LABEL: Record<Recommendation, string> = { skim: "Skim", "read-flagged": "Read flagged", "read-all": "Read all" };
const STATUS_ORDER: Status[] = ["checked", "unchecked", "failing", "no-changes"];

/** Replaces secrets, user names, and repo paths using the core redactor. */
export function redact(s: string, opts: RedactOptions = {}): string {
  const stripped = stripDroppedControls(s);
  const options: RedactOptions = {
    usernames: opts.usernames ?? osUsernames(),
    ...opts,
  };
  return stripped === "" ? "" : coreRedact(stripped, options).text;
}

function flat(s: string): string {
  const clean = stripDroppedControls(s);
  // eslint-disable-next-line no-control-regex
  return clean.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

function shorten(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s;
}

/** Escapes text for a table cell or a line of prose: backslash, `|`, backtick, emphasis, links and HTML. */
export function mdText(s: string): string {
  return flat(s).replace(/[\\|`*_[\]<>~]/g, (c) => `\\${c}`);
}

/** Inline code span for a path or name; the fence is longer than any backtick run inside and `|` is escaped for tables. */
export function mdCode(s: string): string {
  const t = flat(s).replaceAll("|", "\\|");
  const runs = t.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

function relPath(path: string, root: string | undefined): string {
  if (root === undefined) return path;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : path;
}

/** Prompt title for the summary: one line, redacted, at most 80 characters, escaped; "Prompt N" without titles or text. */
export function summaryTitle(text: string, index: number, titles: boolean, opts?: SummaryOptions): string {
  const red = (s: string) => redact(s, { repoDir: opts?.root, usernames: opts?.usernames });
  const t = titles ? shorten(red(flat(text)), TITLE_MAX) : "";
  return t === "" ? `Prompt ${index + 1}` : mdText(t);
}

/** Heading text of a prompt in the "Needs attention" section: "Prompt N" plus the title when there is one. */
function promptHeading(p: PromptAnalysis, titles: boolean, opts?: SummaryOptions): string {
  const t = summaryTitle(p.text, p.index, titles, opts);
  return t === `Prompt ${p.index + 1}` ? t : `Prompt ${p.index + 1}: ${t}`;
}

/** Why a prompt is not "checked", without any command output: a failing check keeps only `<command> failed`. */
export function summaryReason(p: Pick<PromptAnalysis, "status" | "reason">, opts?: SummaryOptions): string {
  const red = (s: string) => redact(s, { repoDir: opts?.root, usernames: opts?.usernames });
  if (p.status === "failing") {
    const m = /^([\s\S]*?) failed(?:: |\s*\(exit|$)/.exec(p.reason);
    const label = m ? shorten(red(flat(m[1]!)), 60) : "";
    return label === "" ? "check failed" : `${label} failed`;
  }
  // The "not analysed" hedge is dropped (as before); "transcript truncated" and "by subagent" stay in the reason.
  const r = p.reason.replace(/;\s*subagent activity not analysed(?: \(depth > 3\))?/g, "");
  return shorten(red(flat(r)), 120);
}

function totals(p: PromptAnalysis): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of p.files) {
    added += f.added;
    removed += f.removed;
  }
  return { added, removed };
}

function hintLine(h: Hint, root: string | undefined, red: (s: string) => string): string {
  const where = h.path === null ? "(whole prompt)" : mdCode(red(relPath(h.path, root)));
  return `- **${h.severity}** ${mdCode(red(h.rule))}: ${where}`;
}

/** More hints than this of one warn/info rule are collapsed into a single line. */
export const COLLAPSE_OVER = 3;

/** Hint lines of a prompt: repeated warn/info hints of one rule collapse into one line; high ones are always listed. */
function hintLines(hints: Hint[], root: string | undefined, red: (s: string) => string): string[] {
  const groups = new Map<string, Hint[]>();
  for (const h of hints) {
    if (h.severity === "high") continue;
    const k = `${h.severity}\u0000${h.rule}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  const done = new Set<string>();
  const out: string[] = [];
  for (const h of hints) {
    const k = `${h.severity}\u0000${h.rule}`;
    const g = h.severity === "high" ? undefined : groups.get(k);
    if (!g || g.length <= COLLAPSE_OVER) {
      out.push(hintLine(h, root, red));
      continue;
    }
    if (done.has(k)) continue;
    done.add(k);
    const first = g.slice(0, 3).map((x) => (x.path === null ? "(whole prompt)" : mdCode(red(relPath(x.path, root)))));
    out.push(`- **${h.severity}** ${mdCode(red(h.rule))}: ${g.length} files (first: ${first.join(", ")}, …)`);
  }
  return out;
}

const FOOTER =
  "_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._";

/**
 * Markdown for a PR description: one session, a table of prompts and, for prompts that need attention, the reason and hints.
 * Contains no command output, file content or full prompt text; titles are redacted and cut to 80 characters.
 */
export function formatSummary(s: SessionAnalysis, opts: SummaryOptions): string {
  const red = (text: string): string =>
    redact(text, { repoDir: opts.root, usernames: opts.usernames });
  const out: string[] = [];
  const title = opts.titles ? shorten(red(flat(s.title)), TITLE_MAX) : "";
  out.push(title === "" ? "# Review summary" : `# Review summary: ${mdText(title)}`, "");
  const date = s.startedAt && /^\d{4}-\d{2}-\d{2}/.test(s.startedAt) ? s.startedAt.slice(0, 10) : "unknown date";
  out.push(`Branch: ${mdCode(red(s.branch))} · Date: ${date} · Session: ${mdCode(red(s.sessionId.slice(0, 8)))}`, "");

  const prompts = s.prompts.filter((p) => p.inheritedFrom === undefined);
  const inh = inheritedInfo(s.prompts);
  const counts = STATUS_ORDER.map((st) => [st, prompts.filter((p) => p.status === st).length] as const)
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${st}`)
    .join(", ");
  if (inh && prompts.length === 0) {
    out.push(`All ${inh.count} ${inh.count === 1 ? "prompt" : "prompts"} inherited from ${mdText(red(inh.from.slice(0, 8)))}${inheritedOthers(inh)}. No prompts to review.`, "");
    return out.join("\n");
  }
  if (prompts.length === 0) {
    out.push("This session has no prompts.", "");
  } else {
    out.push(`${prompts.length} ${prompts.length === 1 ? "prompt" : "prompts"}: ${counts}.`, "");
    if (inh) out.push(`${inh.count} ${inh.count === 1 ? "prompt" : "prompts"} inherited from ${mdText(red(inh.from.slice(0, 8)))}${inheritedOthers(inh)} omitted`, "");
    out.push("| # | Status | Review | Prompt | Files | +/- |", "| ---: | --- | --- | --- | ---: | --- |");
    for (const p of prompts) {
      const t = totals(p);
      out.push(`| ${p.index + 1} | ${p.status} | ${REC_LABEL[p.recommendation]} | ${summaryTitle(p.text, p.index, opts.titles, opts)} | ${p.files.length} | +${t.added} -${t.removed} |`);
    }
    out.push("");
    const attention = prompts.filter(needsAttention);
    if (attention.length > 0) {
      out.push("## Needs attention", "");
      for (const p of attention) {
        out.push(`### ${promptHeading(p, opts.titles, opts)}`, "");
        out.push(`- Status: ${p.status} (${mdText(summaryReason(p, opts))})`);
        out.push(`- Review: ${REC_LABEL[p.recommendation]}`);
        out.push(...hintLines(p.hints, opts.root, red));
        out.push("");
      }
    }
  }
  out.push("---", "", FOOTER, "");
  return out.join("\n");
}
