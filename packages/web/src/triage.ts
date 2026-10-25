import { needsAttention, type PromptAnalysis, type SessionSummary } from "@lgtm/core";
import { plural } from "./viewmodel";

export type Show = "all" | "attention";

/** Own (non-inherited) prompts that need attention, in table order. */
export function attentionPrompts(prompts: readonly PromptAnalysis[]): PromptAnalysis[] {
  return prompts.filter((p) => p.inheritedFrom === undefined && needsAttention(p));
}

/** Prompts of a session that need attention; without `attentionCount` (older server) unchecked + failing. */
export function sessionAttention(s: Pick<SessionSummary, "attentionCount" | "statusCounts">): number {
  return s.attentionCount ?? s.statusCounts.unchecked + s.statusCounts.failing;
}

/** "1 prompt needs attention", "3 prompts need attention", "0 sessions need attention". */
export function needText(n: number, noun: string): string {
  return `${plural(n, noun)} ${n === 1 ? "needs" : "need"} attention`;
}

export interface KeyLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
}

/** Key pressed on a focused prompt row button; null for anything else or with a modifier. */
export function rowKey(e: KeyLike): "next" | "prev" | "steps" | "map" | null {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === "ArrowDown") return "next";
  if (e.key === "ArrowUp") return "prev";
  if (e.key === "s") return "steps";
  if (e.key === "m") return "map";
  return null;
}

/** Escape on the session page goes back to the list, except while typing in a field. */
export function escapeToList(e: KeyLike & { target?: EventTarget | null }): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = (t?.tagName ?? "").toUpperCase();
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable === true);
}
