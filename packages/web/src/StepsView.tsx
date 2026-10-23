import { useState } from "react";
import type { PromptDetail } from "@lgtm/core";
import { WhereToLook } from "./Hints";
import { StepCard } from "./StepCard";
import { StatusTag } from "./StatusDot";
import { formatDuration, formatStarted, plural, promptHeading, retainKeys, routeHref, shortPath, toggleKey } from "./viewmodel";

/** Steps of one prompt. The header comes from the same response, so a deep link needs no other request. */
export function StepsView({ sessionId, detail, onOpenFile }: { sessionId: string; detail: PromptDetail; onOpenFile?: (path: string) => void }) {
  // Expanded action lists are keyed by step number, which is stable across live refreshes.
  const [openState, setOpen] = useState<ReadonlySet<number>>(new Set());
  const openSteps = retainKeys(openState, detail.steps.map((s) => s.n));
  const allFiles = [...new Set([...detail.steps.flatMap((s) => s.files), ...detail.hints.flatMap((h) => (h.path === null ? [] : [h.path]))])];
  const pathLabel = (p: string): string => shortPath(p, allFiles);
  return (
    <>
      <p><a href={routeHref({ kind: "session", id: sessionId })}>&larr; Back to session</a></p>
      <div className="session-head">
        <h2 className="prompt-title">{promptHeading(detail.index, detail.text)}</h2>
        <p className="prompt-meta">
          <StatusTag status={detail.status} />
          <span className="muted">{detail.reason}</span>
        </p>
        <p className="muted">
          {detail.headline} · active {formatDuration(detail.activeMs)} · started {formatStarted(detail.startedAt)} · {plural(detail.steps.length, "step")}
        </p>
      </div>
      {detail.truncated ? (
        <p className="banner" role="note">
          This prompt is large: some steps or actions beyond the retention limits are not shown.
        </p>
      ) : null}
      <WhereToLook rec={detail.recommendation} hints={detail.hints} pathLabel={pathLabel} />
      {detail.steps.length === 0 ? (
        <p className="empty">No steps were recorded for this prompt.</p>
      ) : (
        <ol className="steps">
          {detail.steps.map((s) => (
            <StepCard key={s.n} step={s} open={openSteps.has(s.n)} onToggle={() => setOpen((prev) => toggleKey(prev, s.n))} pathLabel={pathLabel} {...(onOpenFile ? { onOpenFile } : {})} />
          ))}
        </ol>
      )}
    </>
  );
}
