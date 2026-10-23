import { z } from "zod";

export const Story = z.object({
  id: z.string(),
  title: z.string(),
});
export type Story = z.infer<typeof Story>;

export {
  Status,
  Warning,
  FileChange,
  TimeSplit,
  Severity,
  HintRule,
  Hint,
  Recommendation,
  PromptAnalysis,
  SessionAnalysis,
  Analysis,
  SessionSummary,
  SessionsResponse,
  Phase,
  Action,
  StepCheck,
  Step,
  PromptDetail,
  DiffLine,
  Hunk,
  FileDiff,
} from "./schema.js";
export { makeHeadline } from "./timing.js";
export { computeHints, recommend, isTestPath, sensitiveMatch, isManifestPath, isConfigPath, publicSurfaceKind } from "./hints.js";
export { classifyCommand } from "./check-patterns.js";
export type { CommandClass, RepoScripts } from "./check-patterns.js";
export { analyzeSession, createAnalyzer } from "./analyze.js";
export type { AnalyzeOptions, Analyzer } from "./analyze.js";
export { redact, isEnvFilePath } from "./redact.js";
export type { RedactOptions, RedactResult } from "./redact.js";
