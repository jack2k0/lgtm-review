import { useState } from "react";
import type { Step } from "@lgtm/core";
import { actionsLabel, checkOutcome, formatClock, formatStepDuration, phaseLabel, stepTitle } from "./viewmodel";

/** Raw action rows rendered per click; a step can hold thousands of calls. */
export const ACTION_PAGE = 200;

/** Every string below comes from a session log and is rendered as a React text node only. */
export function StepCard({ step, open, onToggle, onOpenFile, pathLabel }: { step: Step; open: boolean; onToggle: () => void; onOpenFile?: (path: string) => void; pathLabel?: (path: string) => string }) {
  const [limit, setLimit] = useState(ACTION_PAGE);
  const listId = `actions-${step.n}`;
  const check = step.check;
  const outcome = check ? checkOutcome(check) : null;
  const shown = step.actions.slice(0, limit);
  const hidden = step.actions.length - shown.length;
  return (
    <li className="step">
      <div className="step-head">
        <span className={`badge badge-${step.phase}`}>{phaseLabel(step.phase)}</span>
        <h3 className="step-title">{stepTitle(step)}</h3>
        <span className="step-dur muted" title="Approximate active time of this step">{formatStepDuration(step.durationMs)}</span>
      </div>
      {step.quotes.map((q, i) => (
        <blockquote key={i} className="quote">{q}</blockquote>
      ))}
      {check && outcome ? (
        <div className="check">
          <div>
            <span className="mono check-cmd">{check.command}</span>
            <span className={`outcome outcome-${outcome.tone}`}>{outcome.text}</span>
          </div>
          {check.excerpt ? <pre className="excerpt">{check.excerpt}</pre> : null}
        </div>
      ) : null}
      {step.files.length > 0 ? (
        <ul className="chips" aria-label="Files edited in this step">
          {step.files.map((f) => (
            <li key={f}>
              <button
                type="button"
                className="chip mono"
                disabled={!onOpenFile}
                title={onOpenFile ? `Open diff of ${f}` : "The diff view is not available yet"}
                onClick={() => onOpenFile?.(f)}
              >
                {pathLabel ? pathLabel(f) : f}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {step.actions.length > 0 ? (
        <>
          <button type="button" className="disclosure" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={onToggle}>
            <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
            {actionsLabel(step.actions.length)}
          </button>
          {open ? (
            <>
              <ol className="actions" id={listId}>
                {shown.map((a, i) => (
                  <li key={i}>
                    <span className="mono action-tool">{a.tool}</span>
                    <span className="mono action-summary">{a.summary}</span>
                    {a.ok ? null : <span className="marker">failed</span>}
                    {a.ts ? <span className="muted action-ts">{formatClock(a.ts)}</span> : null}
                  </li>
                ))}
              </ol>
              {hidden > 0 ? (
                <p>
                  <button type="button" className="more" onClick={() => setLimit(limit + ACTION_PAGE)}>
                    Show more ({hidden} hidden)
                  </button>
                </p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </li>
  );
}
