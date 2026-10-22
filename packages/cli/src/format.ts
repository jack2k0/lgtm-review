import type { FileChange, SessionAnalysis, Status } from "@lgtm/core";

export interface FormatOptions {
  color: boolean;
  dir: string;
  /** Max warning lines shown before "… and K more". */
  warningCap?: number;
}

const STATUS_ORDER: Status[] = ["checked", "unchecked", "failing", "no-changes"];
const CODES: Record<Status, string> = { checked: "32", unchecked: "33", failing: "31", "no-changes": "90" };

function paint(opts: FormatOptions, code: string, text: string): string {
  return opts.color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function fileLine(f: FileChange): string {
  return `${f.kind} ${f.path} +${f.added} -${f.removed}${f.maybeIncomplete ? " (incomplete)" : ""}`;
}

/** Newest first by start time (missing last), then by id. */
export function sortSessions(sessions: SessionAnalysis[]): SessionAnalysis[] {
  return [...sessions].sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt === null) return 1;
      if (b.startedAt === null) return -1;
      return a.startedAt < b.startedAt ? 1 : -1;
    }
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
}

export function formatText(sessions: SessionAnalysis[], opts: FormatOptions): string {
  const out: string[] = [];
  const warnings: string[] = [];
  for (const s of sortSessions(sessions)) {
    const counts = STATUS_ORDER.map((st) => [st, s.prompts.filter((p) => p.status === st).length] as const)
      .filter(([, n]) => n > 0)
      .map(([st, n]) => `${n} ${st}`)
      .join(", ");
    out.push(
      `${paint(opts, "1", s.sessionId.slice(0, 8))}  ${oneLine(s.title, 60)}  [${s.branch}]  ${s.startedAt ?? "unknown start"}`,
    );
    out.push(`  ${s.prompts.length} prompt(s)${counts ? `: ${counts}` : ""}`);
    for (const p of s.prompts) {
      out.push(`  ${p.index + 1}. ${paint(opts, CODES[p.status], p.status.padEnd(10))} ${oneLine(p.text, 200)}`);
      out.push(`       ${p.reason}`);
      for (const f of p.files) out.push(`       ${fileLine(f)}`);
    }
    out.push("");
    for (const w of s.warnings) warnings.push(`${w.file ?? s.sessionId}:${w.line}: ${w.reason}`);
  }
  if (warnings.length > 0) {
    const cap = opts.warningCap ?? 20;
    out.push(`Warnings (${warnings.length})`);
    for (const w of warnings.slice(0, cap)) out.push(`  ${w}`);
    if (warnings.length > cap) out.push(`  … and ${warnings.length - cap} more`);
    out.push("");
  }
  return out.join("\n");
}
