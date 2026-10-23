import { z } from "zod";

export const Status = z.enum(["checked", "unchecked", "failing", "no-changes"]);
export type Status = z.infer<typeof Status>;

export const Warning = z.object({
  file: z.string().optional(),
  line: z.number().int().nonnegative(),
  reason: z.string(),
});
export type Warning = z.infer<typeof Warning>;

export const FileChange = z.object({
  path: z.string(),
  kind: z.enum(["M", "A", "D"]),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  maybeIncomplete: z.boolean(),
});
export type FileChange = z.infer<typeof FileChange>;

/** Approximate active time per phase in milliseconds (see timing.ts for the model). */
export const TimeSplit = z.object({
  readMs: z.number().int().nonnegative(),
  writeMs: z.number().int().nonnegative(),
  checkMs: z.number().int().nonnegative(),
  fixMs: z.number().int().nonnegative(),
});
export type TimeSplit = z.infer<typeof TimeSplit>;

export const PromptAnalysis = z.object({
  index: z.number().int().nonnegative(),
  uuid: z.string(),
  /** First 200 characters of the prompt. */
  text: z.string(),
  status: Status,
  reason: z.string(),
  files: z.array(FileChange),
  /** True when the prompt spawned subagents whose activity is not analysed. */
  partial: z.boolean(),
  timeSplit: TimeSplit,
  /** Union of all phase intervals; phases that overlap in time can make the four values sum to more. */
  activeMs: z.number().int().nonnegative(),
  /** One sentence, e.g. "Mostly writing (62%), 1 check"; "No timing data" when activeMs is 0. */
  headline: z.string(),
});
export type PromptAnalysis = z.infer<typeof PromptAnalysis>;

export const SessionAnalysis = z.object({
  sessionId: z.string(),
  title: z.string(),
  branch: z.string(),
  /** ISO timestamp of the first record that has one, or null. */
  startedAt: z.string().nullable(),
  prompts: z.array(PromptAnalysis),
  warnings: z.array(Warning),
});
export type SessionAnalysis = z.infer<typeof SessionAnalysis>;

/** Result of analysing every session of a repo; the `--json` contract of the CLI. */
export const Analysis = z.object({
  dir: z.string(),
  sessions: z.array(SessionAnalysis),
});
export type Analysis = z.infer<typeof Analysis>;

/** One row of the session list (`GET /api/sessions`); no prompts. */
export const SessionSummary = z.object({
  id: z.string(),
  title: z.string(),
  branch: z.string(),
  startedAt: z.string().nullable(),
  promptCount: z.number().int().nonnegative(),
  statusCounts: z.object({
    checked: z.number().int().nonnegative(),
    unchecked: z.number().int().nonnegative(),
    failing: z.number().int().nonnegative(),
    "no-changes": z.number().int().nonnegative(),
  }),
  warningCount: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Body of `GET /api/sessions`. */
export const SessionsResponse = z.object({
  dir: z.string(),
  sessions: z.array(SessionSummary),
});
export type SessionsResponse = z.infer<typeof SessionsResponse>;

/** Phase of a step or action; same values as the keys of `TimeSplit` (without the `Ms` suffix). */
export const Phase = z.enum(["read", "write", "check", "fix"]);
export type Phase = z.infer<typeof Phase>;

/** One raw tool call of a step. `summary` is a file path, a command (<= 200 chars), a pattern or a tool name; never file content. */
export const Action = z.object({
  tool: z.string(),
  summary: z.string(),
  /** False when the call failed or has no result. */
  ok: z.boolean(),
  /** ISO timestamp of the call, or null when the log has none. */
  ts: z.string().nullable(),
});
export type Action = z.infer<typeof Action>;

/** Outcome of a check command. All null when the command has no usable result (still running, background, did not run). */
export const StepCheck = z.object({
  command: z.string(),
  exitCode: z.number().int().nonnegative().nullable(),
  passed: z.boolean().nullable(),
  /** First non-empty output lines of a failing check (<= 200 chars); empty otherwise. */
  excerpt: z.string(),
});
export type StepCheck = z.infer<typeof StepCheck>;

export const Step = z.object({
  /** 1-based position within the prompt. */
  n: z.number().int().positive(),
  phase: Phase,
  /** Mechanical title, e.g. "Read 3 files", "Fix: read 2 files, edit src/a.ts (+2 -1)", "Run pnpm test -> passed". */
  title: z.string(),
  startedAt: z.string().nullable(),
  /** Union of the step's action intervals (same model as the time split). */
  durationMs: z.number().int().nonnegative(),
  check: StepCheck.optional(),
  /** Agent text blocks (each <= 400 chars, at most 3) written right before the step's first action. */
  quotes: z.array(z.string()),
  actions: z.array(Action),
  /** Paths (as in `PromptAnalysis.files`) edited in this step; each can be opened with `diffFor`. */
  files: z.array(z.string()),
});
export type Step = z.infer<typeof Step>;

/** Everything the Steps view needs for one prompt (body of `GET /api/sessions/:id/prompts/:index`). */
export const PromptDetail = z.object({
  index: z.number().int().nonnegative(),
  /** First 200 characters of the prompt. */
  text: z.string(),
  status: Status,
  reason: z.string(),
  headline: z.string(),
  startedAt: z.string().nullable(),
  activeMs: z.number().int().nonnegative(),
  /** True when steps or actions were dropped because of the retention caps. */
  truncated: z.boolean(),
  steps: z.array(Step),
});
export type PromptDetail = z.infer<typeof PromptDetail>;

export const DiffLine = z.object({ t: z.enum(["+", "-", " "]), s: z.string() });
export type DiffLine = z.infer<typeof DiffLine>;

export const Hunk = z.object({
  /** `@@ -a,b +c,d @@` */
  header: z.string(),
  lines: z.array(DiffLine),
});
export type Hunk = z.infer<typeof Hunk>;

/** What the agent's edits did to one file, from the log only (not the final git state). */
export const FileDiff = z.object({
  path: z.string(),
  kind: z.enum(["M", "A", "D"]),
  /** Lines (2000 per diff) or characters (2000 per line) were cut. */
  truncated: z.boolean(),
  /** Shell edits, removals and moves may be missing. */
  maybeIncomplete: z.boolean(),
  hunks: z.array(Hunk),
});
export type FileDiff = z.infer<typeof FileDiff>;
