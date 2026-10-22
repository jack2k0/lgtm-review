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
