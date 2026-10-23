import { isEnvFilePath, redact } from "@lgtm/core";
import type { FileDiff, Hint, PromptAnalysis, PromptDetail, RedactOptions, Recommendation, SessionAnalysis, Severity, Status, Step, TimeSplit } from "@lgtm/core";
import { EXPORT_CSS } from "./export-css.js";

export { EXPORT_CSS };

export interface ExportInput {
  analysis: SessionAnalysis;
  details: PromptDetail[];
  /** Diffs by prompt index; a file of a prompt without an entry here is shown as "diff not included". */
  diffs: Map<number, FileDiff[]>;
}

export interface ExportOptions {
  /** Show the (redacted) prompt text and session title; false prints "Prompt N" only. */
  titles: boolean;
  /** Include per-file diffs. */
  diffs: boolean;
  /** `YYYY-MM-DD` shown in the banner (injected so the output is deterministic). */
  exportedAt: string;
  /** Options for `redact` (user names, repository directory); `envFile` is set per diff by the renderer. */
  redact?: RedactOptions;
  /** Diffs were left out because of the size cap (the export builder stops collecting them). */
  diffsCapped?: boolean;
}

export interface ExportResult {
  html: string;
  /** Total number of redaction replacements made while rendering (see `redact`). */
  redactions: number;
}

/** Content-Security-Policy of the document: no scripts, no network, only inline styles and data: images. */
export const EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** Rendered actions per step; the rest is summarised as a count. */
export const ACTIONS_PER_STEP_MAX = 200;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/**
 * Escapes text for an HTML text node or a quoted attribute value. Control characters other than `\n` and `\t`
 * (including NUL, CR, DEL, C1) and bidirectional overrides are dropped first. Must run AFTER `redact`.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "")
    .replace(/[&<>"'`]/g, (c) => ESC[c]!);
}

const STATUS_LABEL: Record<Status, string> = { checked: "Checked", unchecked: "Unchecked", failing: "Failing", "no-changes": "No changes" };
const STATUS_ORDER: Status[] = ["checked", "unchecked", "failing", "no-changes"];
const REC_LABEL: Record<Recommendation, string> = { skim: "Skim", "read-flagged": "Read flagged", "read-all": "Read all" };
const REC_MARK: Record<Recommendation, string> = { skim: "○", "read-flagged": "◐", "read-all": "●" };
const REC_HELP: Record<Recommendation, string> = {
  skim: "no high-severity hints",
  "read-flagged": "review the files with hints",
  "read-all": "several high-severity kinds of hints",
};
const SEV_LABEL: Record<Severity, string> = { high: "high", warn: "warn", info: "info" };
const PHASE_LABEL = { read: "Read", write: "Write", check: "Check", fix: "Fix" } as const;
const KIND_LABEL = { M: "Modified", A: "Added", D: "Deleted" } as const;
const SPLIT: { phase: keyof typeof PHASE_LABEL; key: keyof TimeSplit }[] = [
  { phase: "read", key: "readMs" },
  { phase: "write", key: "writeMs" },
  { phase: "check", key: "checkMs" },
  { phase: "fix", key: "fixMs" },
];

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const stepDuration = (ms: number): string => (ms < 500 ? "<1s" : formatDuration(ms));

/** `YYYY-MM-DD HH:MM UTC` from an ISO timestamp; anything else is "unknown". Built from digits only. */
function formatStarted(iso: string | null): string {
  const m = iso === null ? null : /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : "unknown";
}

function clock(iso: string | null): string {
  const m = iso === null ? null : /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : "";
}

/**
 * Renders one session as a self-contained HTML document: no script, no external resource, no link built from log
 * text (the only `href`s are `#p<number>` anchors), CSP meta, constant stylesheet. Every string from the log goes
 * through `redact` first and `escapeHtml` second; attribute values never carry log text.
 */
export function renderExport(input: ExportInput, opts: ExportOptions): ExportResult {
  let redactions = 0;

  /** Redacted (not yet escaped) text; the count is added by the caller that actually uses the result. */
  const red = (s: string, extra: RedactOptions = {}): { text: string; count: number } => (s === "" ? { text: "", count: 0 } : redact(s, { ...opts.redact, ...extra }));
  /** Redacted and escaped text for a text node. */
  const t = (s: string): string => {
    const r = red(s);
    redactions += r.count;
    return escapeHtml(r.text);
  };

  const { analysis } = input;
  const detailByIndex = new Map(input.details.map((d) => [d.index, d]));
  const titles = opts.titles;
  const promptTitle = (p: { index: number; text: string }): string => (titles && p.text.trim() !== "" ? t(p.text) : "");

  // ---- timing bar

  function timeBar(split: TimeSplit, headline: string): string {
    const total = SPLIT.reduce((a, s) => a + split[s.key], 0);
    const parts = SPLIT.filter((s) => split[s.key] > 0);
    const label = total <= 0 ? "No timing data" : parts.map((s) => `${PHASE_LABEL[s.phase]} ${formatDuration(split[s.key])} (${Math.round((split[s.key] / total) * 100)}%)`).join(", ");
    const segs = parts.map((s) => `<span class="seg seg-${s.phase}" style="width:${((split[s.key] / total) * 100).toFixed(2)}%"></span>`).join("");
    return `<div class="timebar" role="img" aria-label="Approximate time split">${segs}</div><div class="headline">${t(headline)}</div><div class="headline">${escapeHtml(label)}</div>`;
  }

  // ---- small parts

  const statusHtml = (s: Status): string => `<span class="status"><span class="dot dot-${s}" aria-hidden="true"></span>${STATUS_LABEL[s]}</span>`;
  const recHtml = (r: Recommendation): string => `<span class="rec rec-${r}"><span aria-hidden="true">${REC_MARK[r]}</span> ${REC_LABEL[r]}</span>`;

  function hintList(hints: readonly Hint[]): string {
    if (hints.length === 0) return `<p class="muted">No review hints.</p>`;
    const items = hints.map(
      (h) =>
        `<li class="hint"><span class="sev sev-${h.severity}">${SEV_LABEL[h.severity]}</span><code>${t(h.rule)}</code>` +
        (h.path === null ? `<span class="muted">whole prompt</span>` : `<code>${t(h.path)}</code>`) +
        `<span>${t(h.reason)}</span></li>`,
    );
    return `<ul class="hints" aria-label="Review hints">${items.join("")}</ul>`;
  }

  function fileLine(f: PromptAnalysis["files"][number]): string {
    return `<li><span class="kind kind-${f.kind}">${KIND_LABEL[f.kind]}</span> <code>${t(f.path)}</code> <span class="muted">+${f.added} -${f.removed}${f.maybeIncomplete ? " (may be incomplete)" : ""}</span></li>`;
  }

  function stepHtml(s: Step): string {
    const title = s.title.trim() === "" ? `${PHASE_LABEL[s.phase]} step ${s.n}` : t(s.title);
    const out: string[] = [`<details class="step"><summary><span class="badge badge-${s.phase}">${PHASE_LABEL[s.phase]}</span>${title} <span class="muted">${escapeHtml(stepDuration(s.durationMs))}</span></summary>`];
    for (const q of s.quotes) out.push(`<blockquote class="quote">${t(q)}</blockquote>`);
    if (s.check) {
      const c = s.check;
      const outcome = c.passed === true ? ["pass", "passed"] : c.exitCode !== null ? ["fail", `exit ${c.exitCode}`] : c.passed === false ? ["fail", "failed"] : ["none", "did not run"];
      out.push(`<p class="check"><code>${t(c.command)}</code><span class="outcome outcome-${outcome[0]}">${outcome[1]}</span></p>`);
      if (c.excerpt !== "") out.push(`<pre class="excerpt">${t(c.excerpt)}</pre>`);
    }
    if (s.files.length > 0) out.push(`<ul class="chips" aria-label="Files edited in this step">${s.files.map((f) => `<li class="chip">${t(f)}</li>`).join("")}</ul>`);
    if (s.actions.length > 0) {
      const shown = s.actions.slice(0, ACTIONS_PER_STEP_MAX);
      out.push(`<p class="muted">${plural(s.actions.length, "action")}</p><ol class="actions">`);
      for (const a of shown) {
        const ts = clock(a.ts);
        out.push(`<li><span class="tool">${t(a.tool)}</span>${a.via === "subagent" ? `<span class="marker">subagent</span>` : ""}<code>${t(a.summary)}</code>${a.ok ? "" : ` <span class="marker">failed</span>`}${ts === "" ? "" : ` <span class="muted">${ts}</span>`}</li>`);
      }
      out.push("</ol>");
      if (s.actions.length > shown.length) out.push(`<p class="note">${s.actions.length - shown.length} more actions not shown.</p>`);
    }
    out.push("</details>");
    return out.join("");
  }

  function diffHtml(d: FileDiff): string {
    const env = isEnvFilePath(d.path);
    let added = 0;
    let removed = 0;
    const hunks: string[] = [];
    for (const h of d.hunks) {
      for (const l of h.lines) {
        if (l.t === "+") added++;
        else if (l.t === "-") removed++;
      }
      // Redact the hunk as one text so multi-line constructs (private key blocks) are caught; the line count is preserved.
      let body = red(h.lines.map((l) => l.s).join("\n"), { envFile: env });
      let lines = body.text.split("\n");
      let count = body.count;
      if (lines.length !== h.lines.length) {
        count = 0;
        lines = h.lines.map((l) => {
          const r = red(l.s, { envFile: env });
          count += r.count;
          return r.text;
        });
      }
      redactions += count;
      const rows = h.lines.map((l, i) => `<span class="dl ${l.t === "+" ? "dl-add" : l.t === "-" ? "dl-del" : "dl-ctx"}"><span class="dp">${l.t}</span>${escapeHtml(lines[i]!)}</span>`);
      hunks.push(`<span class="dl dl-hunk">${t(h.header)}</span>${rows.join("")}`);
    }
    const flags = [d.maybeIncomplete ? "may be incomplete (shell edits, removals and moves may be missing)" : "", d.truncated ? "truncated (lines or characters beyond the limits are not shown)" : ""].filter((x) => x !== "");
    return (
      `<details class="diff-file"><summary><span class="kind kind-${d.kind}">${KIND_LABEL[d.kind]}</span> <code>${t(d.path)}</code> <span class="muted">${plural(d.hunks.length, "hunk")} +${added} -${removed}</span></summary>` +
      `<p class="muted">Agent edits as recorded in the log, not the final git state.${flags.length > 0 ? " " + flags.join("; ") + "." : ""}</p>` +
      (d.hunks.length === 0 ? `<p class="muted">No changed lines were recorded for this file.</p>` : `<pre class="diff" tabindex="0"><span class="diff-body">${hunks.join("")}</span></pre>`) +
      `</details>`
    );
  }

  function diffsSection(p: PromptAnalysis): string {
    if (!opts.diffs || p.files.length === 0) return "";
    const have = input.diffs.get(p.index) ?? [];
    const byPath = new Map(have.map((d) => [d.path, d]));
    const missing = p.files.filter((f) => !byPath.has(f.path)).length;
    const parts = p.files.map((f) => byPath.get(f.path)).filter((d): d is FileDiff => d !== undefined).map(diffHtml);
    const note = missing === 0 ? "" : `<p class="note">${opts.diffsCapped === true ? "Diffs omitted (size cap)" : "Diff not available"} for ${plural(missing, "file")}.</p>`;
    return `<h4>Diffs</h4>${parts.join("")}${note}`;
  }

  function promptSection(p: PromptAnalysis): string {
    const d = detailByIndex.get(p.index);
    const title = promptTitle(p);
    const head = `<div class="prompt-head"><h3>Prompt ${p.index + 1}</h3>${statusHtml(p.status)}${recHtml(p.recommendation)}</div>`;
    const out: string[] = [`<section class="prompt" id="p${p.index + 1}">`, head];
    if (title !== "") out.push(`<p class="prompt-text">${title}</p>`);
    out.push(`<p>${t(p.reason)}${p.partial ? ` <span class="marker">partial: subagent activity not analysed</span>` : ""}</p>`);
    out.push(`<p class="muted">${REC_LABEL[p.recommendation]}: ${REC_HELP[p.recommendation]}.</p>`);
    out.push(timeBar(p.timeSplit, p.headline));
    out.push(`<h4>Hints</h4>${hintList(p.hints)}`);
    if (p.files.length > 0) out.push(`<h4>Files</h4><ul class="files">${p.files.map(fileLine).join("")}</ul>`);
    out.push(diffsSection(p));
    if (d && d.steps.length > 0) {
      out.push(`<details class="steps-box"><summary>Steps (${d.steps.length})</summary>${d.truncated ? `<p class="note">Some steps or actions were dropped because of retention limits.</p>` : ""}<div>${d.steps.map(stepHtml).join("")}</div></details>`);
    }
    out.push("</section>");
    return out.join("");
  }

  // ---- prompt table

  function tableRow(p: PromptAnalysis): string {
    const title = promptTitle(p);
    const add = p.files.reduce((a, f) => a + f.added, 0);
    const rem = p.files.reduce((a, f) => a + f.removed, 0);
    const rules = [...new Set(p.hints.map((h) => h.rule))].map((r) => `<span class="marker">${t(r)}</span>`).join("");
    return (
      `<tr><td class="num"><a href="#p${p.index + 1}">${p.index + 1}</a></td><td>${statusHtml(p.status)}</td>` +
      `<td>${recHtml(p.recommendation)}<div>${rules}</div></td>` +
      `<td class="text">${title === "" ? "" : `<div>${title}</div>`}<div class="muted">${t(p.reason)}</div></td>` +
      `<td>${timeBar(p.timeSplit, p.headline)}</td>` +
      `<td class="num">${plural(p.files.length, "file")}<br>+${add} -${rem}</td></tr>`
    );
  }

  // ---- document

  const counts = STATUS_ORDER.map((st) => [st, analysis.prompts.filter((p) => p.status === st).length] as const)
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${STATUS_LABEL[st].toLowerCase()}`)
    .join(", ");

  const sessionTitle = titles ? t(analysis.title) : "";
  const meta =
    `<dl class="meta"><dt>Session</dt><dd><code>${t(analysis.sessionId)}</code></dd><dt>Branch</dt><dd><code>${t(analysis.branch)}</code></dd>` +
    `<dt>Started</dt><dd>${formatStarted(analysis.startedAt)}</dd>` +
    `<dt>Prompts</dt><dd>${analysis.prompts.length === 0 ? "none" : `${analysis.prompts.length}: ${counts}`}</dd></dl>`;

  const body: string[] = [];
  if (analysis.prompts.length === 0) body.push(`<p class="muted">This session has no prompts.</p>`);
  else {
    body.push(`<h2>Prompts</h2><table class="prompts"><thead><tr><th class="num">#</th><th>Status</th><th>Review</th><th>Prompt</th><th>Time (approx.)</th><th class="num">Files</th></tr></thead><tbody>${analysis.prompts.map(tableRow).join("")}</tbody></table>`);
    body.push(`<p class="muted">Time bar: <span class="badge badge-read">Read</span><span class="badge badge-write">Write</span><span class="badge badge-check">Check</span><span class="badge badge-fix">Fix</span> shares of approximate active time.</p>`);
    body.push(`<h2>Details</h2>`);
    body.push(...analysis.prompts.map(promptSection));
  }
  if (analysis.warnings.length > 0) {
    const items = analysis.warnings.slice(0, 100).map((w) => `<li>${w.file === undefined ? "" : `<code>${t(w.file)}</code>:`}${w.line}: ${t(w.reason)}</li>`);
    body.push(`<details><summary>Analysis warnings (${analysis.warnings.length})</summary><ul>${items.join("")}</ul>${analysis.warnings.length > 100 ? `<p class="note">${analysis.warnings.length - 100} more warnings not shown.</p>` : ""}</details>`);
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(opts.exportedAt) ? opts.exportedAt : "an unknown date";
  const banner =
    `<p class="banner" role="note">Exported from a local Claude Code session log on ${date}. Statuses and hints are heuristic: they come from the agent's own log (edits and shell commands it ran), not from git or from rerunning anything. ` +
    `Secrets and personal paths are redacted on a best-effort basis (${plural(redactions, "replacement")}); review this file before sharing it.` +
    (opts.diffs ? "" : " Diffs are not included.") +
    `</p>`;

  const docTitle = sessionTitle === "" ? "Review export" : `Review export: ${sessionTitle}`;
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n<meta name="referrer" content="no-referrer">\n` +
    `<title>${docTitle}</title>\n<style>\n${EXPORT_CSS}</style>\n</head>\n<body>\n` +
    `<header><h1>${docTitle}</h1>${meta}${banner}</header>\n<main>\n${body.join("\n")}\n</main>\n</body>\n</html>\n`;

  return { html, redactions };
}
