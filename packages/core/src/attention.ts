import type { PromptAnalysis } from "./schema.js";

/**
 * A prompt needs attention (FR-016) when it is unchecked or failing or has at least one review hint:
 * the rule of the "Needs attention" section of `--summary`. Callers leave inherited prompts out.
 */
export function needsAttention(p: Pick<PromptAnalysis, "status" | "hints">): boolean {
  return p.hints.length > 0 || p.status === "unchecked" || p.status === "failing";
}
