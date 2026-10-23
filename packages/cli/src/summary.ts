import type { Hint, PromptAnalysis, Recommendation, SessionAnalysis, Status } from "@lgtm/core";

export interface SummaryOptions {
  /** Show (redacted, shortened) prompt titles; false prints "Prompt N" instead. */
  titles: boolean;
  /** Repository directory; paths below it are printed relative to it. */
  root?: string;
}

/** Longest prompt title in the summary, in characters. */
export const TITLE_MAX = 80;

const REC_LABEL: Record<Recommendation, string> = { skim: "Skim", "read-flagged": "Read flagged", "read-all": "Read all" };
const STATUS_ORDER: Status[] = ["checked", "unchecked", "failing", "no-changes"];

/** Secret-looking text in titles and labels; applied before shortening so a token is never cut in half. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g,
  /\bBearer\s+\S+/gi,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
  /[A-Za-z0-9+/_=-]{32,}/g,
];

/** Replaces token-like text with `[redacted]`. */
export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

function flat(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
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
export function summaryTitle(text: string, index: number, titles: boolean): string {
  const t = titles ? shorten(redact(flat(text)), TITLE_MAX) : "";
  return t === "" ? `Prompt ${index + 1}` : mdText(t);
}

/** Heading text of a prompt in the "Needs attention" section: "Prompt N" plus the title when there is one. */
function promptHeading(p: PromptAnalysis, titles: boolean): string {
  const t = summaryTitle(p.text, p.index, titles);
  return t === `Prompt ${p.index + 1}` ? t : `Prompt ${p.index + 1}: ${t}`;
}

/** Why a prompt is not "checked", without any command output: a failing check keeps only `<command> failed`. */
export function summaryReason(p: Pick<PromptAnalysis, "status" | "reason">): string {
  if (p.status === "failing") {
    const m = /^([\s\S]*?) failed(?:: |\s*\(exit|$)/.exec(p.reason);
    const label = m ? shorten(redact(flat(m[1]!)), 60) : "";
    return label === "" ? "check failed" : `${label} failed`;
  }
  // The "not analysed" hedge is dropped (as before); "transcript truncated" and "by subagent" stay in the reason.
  const r = p.reason.replace(/;\s*subagent activity not analysed(?: \(depth > 3\))?/g, "");
  return shorten(redact(flat(r)), 120);
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

function hintLine(h: Hint, root: string | undefined): string {
  const where = h.path === null ? "(whole prompt)" : mdCode(relPath(h.path, root));
  return `- **${h.severity}** ${mdCode(h.rule)}: ${where}`;
}

/** More hints than this of one warn/info rule are collapsed into a single line. */
export const COLLAPSE_OVER = 3;

/** Hint lines of a prompt: repeated warn/info hints of one rule collapse into one line; high ones are always listed. */
function hintLines(hints: Hint[], root: string | undefined): string[] {
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
      out.push(hintLine(h, root));
      continue;
    }
    if (done.has(k)) continue;
    done.add(k);
    const first = g.slice(0, 3).map((x) => (x.path === null ? "(whole prompt)" : mdCode(relPath(x.path, root))));
    out.push(`- **${h.severity}** ${mdCode(h.rule)}: ${g.length} files (first: ${first.join(", ")}, …)`);
  }
  return out;
}

function needsAttention(p: PromptAnalysis): boolean {
  return p.hints.length > 0 || p.status === "unchecked" || p.status === "failing";
}

const FOOTER =
  "_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._";

/**
 * Markdown for a PR description: one session, a table of prompts and, for prompts that need attention, the reason and hints.
 * Contains no command output, file content or full prompt text; titles are redacted and cut to 80 characters.
 */
export function formatSummary(s: SessionAnalysis, opts: SummaryOptions): string {
  const out: string[] = [];
  const title = opts.titles ? shorten(redact(flat(s.title)), TITLE_MAX) : "";
  out.push(title === "" ? "# Review summary" : `# Review summary: ${mdText(title)}`, "");
  const date = s.startedAt && /^\d{4}-\d{2}-\d{2}/.test(s.startedAt) ? s.startedAt.slice(0, 10) : "unknown date";
  out.push(`Branch: ${mdCode(s.branch)} · Date: ${date} · Session: ${mdCode(s.sessionId.slice(0, 8))}`, "");

  const counts = STATUS_ORDER.map((st) => [st, s.prompts.filter((p) => p.status === st).length] as const)
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${st}`)
    .join(", ");
  if (s.prompts.length === 0) {
    out.push("This session has no prompts.", "");
  } else {
    out.push(`${s.prompts.length} ${s.prompts.length === 1 ? "prompt" : "prompts"}: ${counts}.`, "");
    out.push("| # | Status | Review | Prompt | Files | +/- |", "| ---: | --- | --- | --- | ---: | --- |");
    for (const p of s.prompts) {
      const t = totals(p);
      out.push(`| ${p.index + 1} | ${p.status} | ${REC_LABEL[p.recommendation]} | ${summaryTitle(p.text, p.index, opts.titles)} | ${p.files.length} | +${t.added} -${t.removed} |`);
    }
    out.push("");
    const attention = s.prompts.filter(needsAttention);
    if (attention.length > 0) {
      out.push("## Needs attention", "");
      for (const p of attention) {
        out.push(`### ${promptHeading(p, opts.titles)}`, "");
        out.push(`- Status: ${p.status} (${mdText(summaryReason(p))})`);
        out.push(`- Review: ${REC_LABEL[p.recommendation]}`);
        out.push(...hintLines(p.hints, opts.root));
        out.push("");
      }
    }
  }
  out.push("---", "", FOOTER, "");
  return out.join("\n");
}
