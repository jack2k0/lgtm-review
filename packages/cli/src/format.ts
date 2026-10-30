import { inheritedSource, redact as coreRedact } from "@lgtm/core";
import type { Analysis, FileChange, PromptAnalysis, RedactOptions, SessionAnalysis, Status } from "@lgtm/core";
import { osUsernames } from "./export.js";

export interface FormatOptions {
  color: boolean;
  dir: string;
  /** Max warning lines shown before "… and K more". */
  warningCap?: number;
  raw?: boolean;
  redact?: RedactOptions;
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

function fileLine(f: FileChange, red: (s: string) => string = (s) => s): string {
  return `${f.kind} ${red(f.path)} +${f.added} -${f.removed}${f.maybeIncomplete ? " (incomplete)" : ""}`;
}

const EXEMPT_KEYS = new Set([
  "dir",
  "sessionId",
  "inheritedFrom",
  "status",
  "kind",
  "rule",
  "severity",
  "recommendation",
]);

/**
 * Walks an `Analysis` object and redacts every string value, keeping keys, numbers, and structure.
 * `sessionId`, `status`, schema enums and `dir` are preserved; log-supplied values such as `startedAt` and `uuid` go through the redactor.
 */
export function redactAnalysis(
  analysis: Analysis,
  defaultOpts?: RedactOptions,
  sessionRoots?: Map<string, string>,
): Analysis {
  const baseOpts: RedactOptions = {
    usernames: defaultOpts?.usernames ?? osUsernames(),
    repoDir: defaultOpts?.repoDir ?? analysis.dir,
    ...defaultOpts,
  };

  function redactValue(val: unknown, key?: string, currentOpts: RedactOptions = baseOpts): unknown {
    if (typeof val === "string") {
      if (key !== undefined && EXEMPT_KEYS.has(key)) {
        return val;
      }
      return val === "" ? "" : coreRedact(val, currentOpts).text;
    }
    if (Array.isArray(val)) {
      return val.map((item) => redactValue(item, key, currentOpts));
    }
    if (val !== null && typeof val === "object") {
      const res: Record<string, unknown> = {};
      let objOpts = currentOpts;
      if ("sessionId" in val && typeof (val as { sessionId: unknown }).sessionId === "string") {
        const sid = (val as { sessionId: string }).sessionId;
        const root = sessionRoots?.get(sid);
        if (root && root !== objOpts.repoDir) {
          objOpts = { ...objOpts, repoDir: root };
        }
      }
      for (const [k, v] of Object.entries(val)) {
        res[k] = redactValue(v, k, objOpts);
      }
      return res;
    }
    return val;
  }

  return redactValue(analysis) as Analysis;
}

/** Inherited prompts of a session (resumed or forked copies), the session most of them came from and how many other sources there are; null when none. */
export function inheritedInfo(prompts: readonly PromptAnalysis[]): { count: number; from: string; others: number } | null {
  return inheritedSource(prompts);
}

/** " and 1 other session" when the inherited prompts come from more than one session, else "". */
export function inheritedOthers(inh: { others: number }): string {
  return inh.others > 0 ? ` and ${inh.others} other ${inh.others === 1 ? "session" : "sessions"}` : "";
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
  const redactOpts: RedactOptions = {
    usernames: opts.redact?.usernames ?? osUsernames(),
    repoDir: opts.redact?.repoDir ?? opts.dir,
    ...opts.redact,
  };
  const red = opts.raw ? (s: string) => s : (s: string) => (s === "" ? "" : coreRedact(s, redactOpts).text);
  const out: string[] = [];
  const warnings: string[] = [];
  for (const s of sortSessions(sessions)) {
    const own = s.prompts.filter((p) => p.inheritedFrom === undefined);
    const inh = inheritedInfo(s.prompts);
    const counts = STATUS_ORDER.map((st) => [st, own.filter((p) => p.status === st).length] as const)
      .filter(([, n]) => n > 0)
      .map(([st, n]) => `${n} ${st}`)
      .join(", ");
    const archived = (s.archived ? " (archived)" : "") + (s.worktree !== undefined && s.worktree !== "." ? ` [worktree ${s.worktree}]` : "");
    out.push(
      `${paint(opts, "1", s.sessionId.slice(0, 8))}  ${oneLine(red(s.title), 60)}  [${red(s.branch)}]  ${red(s.startedAt ?? "unknown start")}${red(archived)}`,
    );
    out.push(`  ${own.length} prompt(s)${counts ? `: ${counts}` : ""}${inh ? ` (+${inh.count} inherited from ${inh.from.slice(0, 8)}${inheritedOthers(inh)})` : ""}`);
    for (const p of s.prompts) {
      const mark = p.inheritedFrom === undefined ? "" : ` (inherited from ${p.inheritedFrom.slice(0, 8)})`;
      out.push(`  ${p.index + 1}. ${paint(opts, CODES[p.status], p.status.padEnd(10))} ${oneLine(red(p.text), 200)}${mark}`);
      out.push(`       ${red(p.reason)}`);
      for (const f of p.files) out.push(`       ${fileLine(f, red)}`);
    }
    out.push("");
    for (const w of s.warnings) warnings.push(`${w.file !== undefined ? red(w.file) : s.sessionId}:${w.line}: ${red(w.reason)}`);
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
