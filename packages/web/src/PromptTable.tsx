import { useEffect, useState } from "react";
import type { PromptAnalysis, SessionAnalysis } from "@lgtm/core";
import { HintList, ReviewCell, RuleMarkers } from "./Hints";
import { StatusTag } from "./StatusDot";
import { TimeBar, TimeLegend } from "./TimeBar";
import { attentionPrompts, escapeToList, needText, rowKey, type Show } from "./triage";
import { PROMPT_PAGE, fileTotals, filesText, incompleteMarkers, nextLimit, kindLabel, plural, routeHref, retainKeys, rulesByPath, shortPath, toggleKey, visiblePrompts, splitInherited } from "./viewmodel";

/** Changed files of a prompt; each path links to its diff (the link carries the exact path from the list). */
export function FileList({ sessionId, p }: { sessionId: string; p: PromptAnalysis }) {
  const paths = p.files.map((f) => f.path);
  const flagged = rulesByPath(p.hints);
  if (p.files.length === 0) return <p className="muted">No changed files.</p>;
  return (
    <ul className="files">
      {p.files.map((f) => (
        <li key={f.path}>
          <span className="kind" title={kindLabel(f.kind)}>{f.kind}</span>{" "}
          <a className="mono file-link" href={routeHref({ kind: "diff", id: sessionId, index: p.index, path: f.path })} title={`Open diff of ${f.path}`}>{shortPath(f.path, paths)}</a>{" "}
          +{f.added} -{f.removed}
          {f.maybeIncomplete ? <span className="marker">may be incomplete</span> : null}
          {flagged.has(f.path) ? <RuleMarkers rules={flagged.get(f.path)!} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function Row({ sessionId, p, open, onToggle }: { sessionId: string; p: PromptAnalysis; open: boolean; onToggle: () => void }) {
  const totals = fileTotals(p);
  const markers = incompleteMarkers(p);
  const detailId = `detail-${p.index}`;
  return (
    <>
      <tr className={open ? "open" : undefined}>
        <td className="nowrap"><StatusTag status={p.status} /></td>
        <td className="title">
          <button type="button" className="rowbtn" data-index={p.index} aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle}>
            <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className={open ? "text" : "text clamp"}>{p.text || "(empty prompt)"}</span>
          </button>
        </td>
        <td className="reason"><span className={open ? "" : "clamp"}>{p.reason}</span></td>
        <td className="review"><ReviewCell rec={p.recommendation} hints={p.hints} /></td>
        <td><TimeBar split={p.timeSplit} headline={p.headline} /></td>
        <td className="nowrap">
          {filesText(totals)}
          {markers.map((m) => (
            <span key={m} className="marker">{m}</span>
          ))}
        </td>
        <td className="nowrap">
          <a href={routeHref({ kind: "steps", id: sessionId, index: p.index })} aria-label={`Steps of prompt ${p.index + 1}`}>Steps</a>
          {" · "}
          <a href={routeHref({ kind: "map", id: sessionId, index: p.index })} aria-label={`Import map of prompt ${p.index + 1}`}>Map</a>
        </td>
      </tr>
      {open ? (
        <tr className="detail" id={detailId}>
          <td />
          <td colSpan={6}>
            <p className="full-reason"><strong>Reason:</strong> {p.reason}</p>
            <HintList hints={p.hints} pathLabel={(x) => shortPath(x, [...p.files.map((f) => f.path), ...p.hints.flatMap((h) => (h.path === null ? [] : [h.path]))])} />
            <FileList sessionId={sessionId} p={p} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

const PROMPT_COLUMNS = ["Status", "Prompt", "Reason", "Review", "Time (approx.)", "Files", "Detail"] as const;

function PromptHead() {
  return (
    <thead>
      <tr>
        {PROMPT_COLUMNS.map((c) => (
          <th key={c} scope="col">{c}</th>
        ))}
      </tr>
    </thead>
  );
}

/** Collapsed-by-default group of prompts inherited from an earlier session; its rows use the same Row as own prompts. */
function InheritedGroup({ sessionId, rows, from, openIdx, onToggle }: { sessionId: string; rows: readonly PromptAnalysis[]; from: string; openIdx: ReadonlySet<number>; onToggle: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="inherited-group">
      <button type="button" className="inherited-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {`${plural(rows.length, "inherited prompt")} from ${from.slice(0, 8)}`}
      </button>
      {open ? (
        <table className="prompts">
          <PromptHead />
          <tbody>
            {rows.map((p) => (
              <Row key={p.index} sessionId={sessionId} p={p} open={openIdx.has(p.index)} onToggle={() => onToggle(p.index)} />
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function PromptTable({ session, show = "all" }: { session: SessionAnalysis; show?: Show }) {
  const [limit, setLimit] = useState(PROMPT_PAGE);
  // Keyed by prompt index (append-only in a session file), so rows stay expanded across live refreshes.
  const [openState, setOpenIdx] = useState<ReadonlySet<number>>(new Set());
  const openIdx = retainKeys(openState, session.prompts.map((p) => p.index));
  const { own, inherited, from } = splitInherited(session.prompts);
  const attention = attentionPrompts(session.prompts);
  const rows = show === "attention" ? attention : own;
  const { shown, hidden } = visiblePrompts(rows, limit);

  const toggle = (i: number) => setOpenIdx((prev) => toggleKey(prev, i));

  const nonInheritedCount = own.length;
  const inheritedCount = inherited.length;
  const id = session.sessionId;

  // Escape on the session page goes back to the list (not while typing in a field).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (escapeToList(e)) {
        e.preventDefault();
        window.location.hash = routeHref({ kind: "list" });
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const onRowsKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.matches("button.rowbtn")) return;
    const k = rowKey(e);
    if (k === null) return;
    e.preventDefault();
    if (k === "next" || k === "prev") {
      const btns = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button.rowbtn"));
      const at = btns.indexOf(target);
      const to = btns[k === "next" ? at + 1 : at - 1];
      if (to) to.focus();
    } else if (k === "steps") {
      window.location.hash = routeHref({ kind: "steps", id, index: Number(target.dataset.index) });
    } else {
      window.location.hash = routeHref({ kind: "map", id, index: Number(target.dataset.index) });
    }
  };

  return (
    <>
      <div className="session-head">
        <h2>{session.title || session.sessionId}</h2>
        <p className="muted">
          {session.branch ? <span className="mono">{session.branch}</span> : null} {plural(nonInheritedCount, "prompt")}{inheritedCount > 0 ? ` + ${inheritedCount} inherited` : ""}
          {nonInheritedCount > 0 ? ` · ${needText(attention.length, "prompt")}` : ""}
        </p>
      </div>
      {nonInheritedCount > 0 ? (
        <nav className="filters" aria-label="Filter prompts">
          <a href={routeHref({ kind: "session", id })} aria-current={show === "all" ? "page" : undefined}>All ({nonInheritedCount})</a>
          <a href={routeHref({ kind: "session", id, show: "attention" })} aria-current={show === "attention" ? "page" : undefined}>Needs attention ({attention.length})</a>
        </nav>
      ) : null}
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
          {show === "attention" ? <p className="muted">Showing {rows.length} of {nonInheritedCount} prompts.</p> : null}
          <div className="prompt-rows" onKeyDown={onRowsKey}>
            {rows.length === 0 && show === "attention" ? (
              <p className="empty">No prompts need attention.</p>
            ) : (
              <>
                <TimeLegend />
                <table className="prompts">
                  <PromptHead />
                  <tbody>
                    {shown.map((p) => (
                      <Row key={p.index} sessionId={id} p={p} open={openIdx.has(p.index)} onToggle={() => toggle(p.index)} />
                    ))}
                  </tbody>
                </table>
                {hidden > 0 ? (
                  <p>
                    <button type="button" className="more" onClick={() => setLimit(nextLimit(limit, rows.length))}>
                      Show more ({hidden} hidden)
                    </button>
                  </p>
                ) : null}
              </>
            )}
            {inheritedCount > 0 ? <InheritedGroup sessionId={id} rows={inherited} from={from} openIdx={openIdx} onToggle={toggle} /> : null}
          </div>
          {rows.length > 0 ? <p className="muted keys">Keys: Tab to a prompt, ↑/↓ move, Enter expands, s Steps, m Map, Esc back to sessions.</p> : null}
        </>
      )}
    </>
  );
}
