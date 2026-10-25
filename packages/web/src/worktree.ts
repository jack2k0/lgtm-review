import type { SessionSummary } from "@lgtm/core";

/** Distinct worktree labels of the sessions ("." first, then sorted); sessions without a label count as "." */
export function worktreeLabels(sessions: readonly Pick<SessionSummary, "worktree">[]): string[] {
  const labels = new Set(sessions.map((s) => s.worktree ?? "."));
  const rest = [...labels].filter((l) => l !== ".").sort();
  return labels.has(".") ? [".", ...rest] : rest;
}

/** The Worktree column and filter appear only when the sessions come from at least two worktrees. */
export function hasWorktrees(sessions: readonly Pick<SessionSummary, "worktree">[]): boolean {
  return worktreeLabels(sessions).length >= 2;
}

/** "main checkout" for ".", the relative path otherwise. */
export function worktreeName(label: string): string {
  return label === "." ? "main checkout" : label;
}
