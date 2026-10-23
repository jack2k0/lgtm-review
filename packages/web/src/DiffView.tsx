import type { FileDiff } from "@lgtm/core";
import { diffCounts, diffPrefix, kindLabel, plural, routeHref } from "./viewmodel";

export const INCOMPLETE_NOTE = "may be incomplete (shell edits, removals and moves may be missing)";

/**
 * Unified diff of one file as recorded in the session log. Every string (path, hunk headers, line text)
 * comes from the log and is rendered as a React text node inside `<pre>` only.
 */
export function DiffView({ sessionId, index, diff }: { sessionId: string; index: number; diff: FileDiff }) {
  const { added, removed } = diffCounts(diff.hunks);
  return (
    <>
      <p><a href={routeHref({ kind: "steps", id: sessionId, index })}>&larr; Back to steps</a></p>
      <div className="session-head">
        <h2 className="diff-path mono">{diff.path}</h2>
        <p className="prompt-meta">
          <span className={`kind-label kind-${diff.kind}`}>{kindLabel(diff.kind)}</span>
          <span className="muted">
            prompt {index + 1} · {plural(diff.hunks.length, "hunk")} · +{added} -{removed}
          </span>
        </p>
      </div>
      <p className="banner" role="note">agent edits, not final git state</p>
      {diff.maybeIncomplete ? <p className="banner" role="note">{INCOMPLETE_NOTE}</p> : null}
      {diff.truncated ? (
        <p className="banner" role="note">This diff was truncated: lines or characters beyond the retention limits are not shown.</p>
      ) : null}
      {diff.hunks.length === 0 ? (
        <p className="empty">No changed lines were recorded for this file.</p>
      ) : (
        <pre className="diff" tabIndex={0} aria-label={`Unified diff of ${diff.path}`}>
          <span className="diff-body">
          {diff.hunks.map((h, i) => (
            <span key={i} className="hunk">
              <span className="dl dl-hunk">{h.header}</span>
              {h.lines.map((l, j) => (
                <span key={j} className={`dl ${l.t === "+" ? "dl-add" : l.t === "-" ? "dl-del" : "dl-ctx"}`}>
                  <span className="dp">{diffPrefix(l.t)}</span>
                  {l.s}
                </span>
              ))}
            </span>
          ))}
          </span>
        </pre>
      )}
    </>
  );
}
