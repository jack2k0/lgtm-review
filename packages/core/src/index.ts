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
  PromptAnalysis,
  SessionAnalysis,
  Analysis,
} from "./schema.js";
export { classifyCommand } from "./check-patterns.js";
export type { CommandClass, RepoScripts } from "./check-patterns.js";
export { analyzeSession, createAnalyzer } from "./analyze.js";
export type { AnalyzeOptions, Analyzer } from "./analyze.js";
