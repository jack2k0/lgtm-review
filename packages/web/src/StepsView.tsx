import type { PromptDetail } from "@lgtm/core";
import { StepCard } from "./StepCard";
import { StatusTag } from "./StatusDot";
import { formatDuration, formatStarted, plural, promptHeading, routeHref, shortPath } from "./viewmodel";

/** Steps of one prompt. The header comes from the same response, so a deep link needs no other request. */
export function StepsView({ sessionId, detail, onOpenFile }: { sessionId: string; detail: PromptDetail; onOpenFile?: (path: string) => void }) {
  const allFiles = [...new Set(detail.steps.flatMap((s) => s.files))];
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
      {detail.steps.length === 0 ? (
        <p className="empty">No steps were recorded for this prompt.</p>
      ) : (
        <ol className="steps">
          {detail.steps.map((s) => (
            <StepCard key={s.n} step={s} pathLabel={pathLabel} {...(onOpenFile ? { onOpenFile } : {})} />
          ))}
        </ol>
      )}
    </>
  );
}
