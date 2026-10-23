import { useState } from "react";
import type { PromptAnalysis, SessionAnalysis } from "@lgtm/core";
import { StatusTag } from "./StatusDot";
import { TimeBar, TimeLegend } from "./TimeBar";
import { PROMPT_PAGE, fileTotals, filesText, incompleteMarkers, nextLimit, plural, visiblePrompts } from "./viewmodel";

function Row({ p, open, onToggle }: { p: PromptAnalysis; open: boolean; onToggle: () => void }) {
  const totals = fileTotals(p);
  const markers = incompleteMarkers(p);
  const detailId = `detail-${p.index}`;
  return (
    <>
      <tr className={open ? "open" : undefined}>
        <td className="nowrap"><StatusTag status={p.status} /></td>
        <td className="title">
          <button type="button" className="rowbtn" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle}>
            <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className={open ? "text" : "text clamp"}>{p.text || "(empty prompt)"}</span>
          </button>
        </td>
        <td className="reason"><span className={open ? "" : "clamp"}>{p.reason}</span></td>
        <td><TimeBar split={p.timeSplit} headline={p.headline} /></td>
        <td className="nowrap">
          {filesText(totals)}
          {markers.map((m) => (
            <span key={m} className="marker">{m}</span>
          ))}
        </td>
      </tr>
      {open ? (
        <tr className="detail" id={detailId}>
          <td />
          <td colSpan={4}>
            <p className="full-reason"><strong>Reason:</strong> {p.reason}</p>
            {p.files.length === 0 ? (
              <p className="muted">No changed files.</p>
            ) : (
              <ul className="files">
                {p.files.map((f) => (
                  <li key={f.path}>
                    <span className="kind">{f.kind}</span> <span className="mono">{f.path}</span> +{f.added} -{f.removed}
                    {f.maybeIncomplete ? <span className="marker">may be incomplete</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function PromptTable({ session }: { session: SessionAnalysis }) {
  const [limit, setLimit] = useState(PROMPT_PAGE);
  const [openIdx, setOpenIdx] = useState<ReadonlySet<number>>(new Set());
  const { shown, hidden } = visiblePrompts(session.prompts, limit);

  const toggle = (i: number) =>
    setOpenIdx((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  return (
    <>
      <div className="session-head">
        <h2>{session.title || session.sessionId}</h2>
        <p className="muted">
          {session.branch ? <span className="mono">{session.branch}</span> : null} {plural(session.prompts.length, "prompt")}
        </p>
      </div>
      {session.warnings.length > 0 ? (
        <details className="warnings" open={session.warnings.length <= 5}>
          <summary>{plural(session.warnings.length, "warning")} while reading the log</summary>
          <ul>
            {session.warnings.slice(0, 100).map((w, i) => (
              <li key={i}>
                {w.file ? <span className="mono">{w.file}:{w.line}</span> : <span className="mono">line {w.line}</span>} {w.reason}
              </li>
            ))}
          </ul>
          {session.warnings.length > 100 ? <p className="muted">{session.warnings.length - 100} more not shown.</p> : null}
        </details>
      ) : null}
      {session.prompts.length === 0 ? (
        <p className="empty">This session has no prompts.</p>
      ) : (
        <>
          <TimeLegend />
          <table className="prompts">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Prompt</th>
                <th scope="col">Reason</th>
                <th scope="col">Time (approx.)</th>
                <th scope="col">Files</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <Row key={p.index} p={p} open={openIdx.has(p.index)} onToggle={() => toggle(p.index)} />
              ))}
            </tbody>
          </table>
          {hidden > 0 ? (
            <p>
              <button type="button" className="more" onClick={() => setLimit(nextLimit(limit, session.prompts.length))}>
                Show more ({hidden} hidden)
              </button>
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
