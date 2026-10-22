import { z } from "zod";

export const Story = z.object({
  id: z.string(),
  title: z.string(),
});
export type Story = z.infer<typeof Story>;

export { Status, Warning, FileChange, PromptAnalysis, SessionAnalysis } from "./schema.js";
