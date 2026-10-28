import { useContext, useEffect, useRef, useState } from "react";
import type { LlmTitlesResponse, PromptAnalysis, SessionAnalysis } from "@lgtm/core";
import { fetchTitles } from "./api";
import { HintList, ReviewCell, RuleMarkers } from "./Hints";
import { LiveContext } from "./LiveView";
import { StatusTag } from "./StatusDot";
import { TimeBar, TimeLegend } from "./TimeBar";
import { GENERATED_LABEL, GENERATED_NOTE, TITLES_POLL_MS, shouldPollTitles, titleForPrompt } from "./titles";
import { attentionPrompts, escapeToList, needText, rowKey, type Show } from "./triage";
import { PROMPT_PAGE, SHELL_EDIT_FILE, fileTotals, filesText, incompleteMarkers, nextLimit, kindLabel, navigateToList, plural, routeHref, retainKeys, rulesByPath, shortPath, toggleKey, visiblePrompts, splitInherited } from "./viewmodel";

/**
 * Loads generated titles for one session.
 * One GET immediately, then every {@link TITLES_POLL_MS} while `pending > 0` and `error` is null.
 * Pauses while live updates are paused or the document is hidden, and resumes at once.
 * Aborts the in-flight GET when the session payload changes or the view unmounts.
 */
function usePromptTitles(token: string | null, session: SessionAnalysis): LlmTitlesResponse | null {
  const live = useContext(LiveContext);
  const [box, setBox] = useState<{ id: string; res: LlmTitlesResponse } | null>(null);
  const pausedRef = useRef(live.paused);
  pausedRef.current = live.paused;
  const nudgeRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!token) {
      nudgeRef.current = () => {};
      return;
    }
    const sessionId = session.sessionId;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ac: AbortController | null = null;
    let latest: LlmTitlesResponse | null = null;
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const allowed = () => !stopped && !pausedRef.current && !document.hidden;

    const schedule = () => {
      clearTimer();
      if (!allowed() || !shouldPollTitles(latest)) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, TITLES_POLL_MS);
    };

    const run = async () => {
      if (!allowed() || ac) return;
      clearTimer();
      const ctrl = new AbortController();
      ac = ctrl;
      try {
        const res = await fetchTitles(token, sessionId, null, ctrl.signal);
        if (stopped || ctrl.signal.aborted) return;
        ac = null;
        if (res.kind !== "ok") return;
        latest = res.data;
        setBox({ id: sessionId, res: res.data });
        schedule();
      } catch {
        if (stopped || ctrl.signal.aborted) return;
        ac = null;
      }
    };

    const nudge = () => {
      if (stopped) return;
      if (!allowed()) {
        clearTimer();
        return;
      }
      if (ac) return;
      clearTimer();
      if (latest === null || shouldPollTitles(latest)) void run();
    };
    nudgeRef.current = nudge;
    const onVisibility = () => nudge();
    document.addEventListener("visibilitychange", onVisibility);
    if (allowed()) void run();
    return () => {
      stopped = true;
      clearTimer();
      ac?.abort();
      ac = null;
      document.removeEventListener("visibilitychange", onVisibility);
      if (nudgeRef.current === nudge) nudgeRef.current = () => {};
    };
  }, [token, session]);

  useEffect(() => {
    nudgeRef.current();
  }, [live.paused]);

  if (!token || box === null || box.id !== session.sessionId) return null;
  return box.res;
}

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
          {f.path === SHELL_EDIT_FILE ? (
            <span className="mono">{f.path}</span>
          ) : (
            <a className="mono file-link" href={routeHref({ kind: "diff", id: sessionId, index: p.index, path: f.path })} title={`Open diff of ${f.path}`}>{shortPath(f.path, paths)}</a>
          )}{" "}
          +{f.added} -{f.removed}
          {f.maybeIncomplete ? <span className="marker">may be incomplete</span> : null}
          {flagged.has(f.path) ? <RuleMarkers rules={flagged.get(f.path)!} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function Row({ sessionId, p, open, onToggle, generated = null }: { sessionId: string; p: PromptAnalysis; open: boolean; onToggle: () => void; generated?: string | null }) {
  const totals = fileTotals(p);
  const markers = incompleteMarkers(p);
  const detailId = `detail-${p.index}`;
  // Inherited prompts keep the earlier session's text; a generated title is never shown for them.
  const title = p.inheritedFrom === undefined && generated ? generated : null;
  return (
    <>
      <tr className={open ? "open" : undefined}>
        <td className="nowrap"><StatusTag status={p.status} /></td>
        <td className="title">
          <button type="button" className="rowbtn" data-index={p.index} aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle}>
            <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className="title-stack">
              {title === null ? null : (
                <span className="gen-title">
                  {title}{" "}
                  <span className="gen-label" title={GENERATED_NOTE}>{GENERATED_LABEL}</span>
                </span>
              )}
              <span className={open ? "text" : "text clamp"}>{p.text.trim() || "(empty prompt)"}</span>
            </span>
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
          {p.inheritedFrom === undefined ? (
            <>
              {" · "}
              <a href={routeHref({ kind: "map", id: sessionId, index: p.index })} aria-label={`Import map of prompt ${p.index + 1}`}>Map</a>
            </>
          ) : null}
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
export function InheritedGroup({ sessionId, rows, from, others, openIdx, onToggle, titles }: { sessionId: string; rows: readonly PromptAnalysis[]; from: string; others: number; openIdx: ReadonlySet<number>; onToggle: (i: number) => void; titles?: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="inherited-group">
      <button type="button" className="inherited-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {`${plural(rows.length, "inherited prompt")} from ${from.slice(0, 8)}${others > 0 ? ` and ${plural(others, "other session")}` : ""}`}
      </button>
      {open ? (
        <div className="table-scroll">
          <table className="prompts">
            <PromptHead />
            <tbody>
              {rows.map((p) => (
                <Row key={p.index} sessionId={sessionId} p={p} open={openIdx.has(p.index)} onToggle={() => onToggle(p.index)} generated={titleForPrompt(titles, p)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function PromptTable({ session, show = "all", token = null }: { session: SessionAnalysis; show?: Show; token?: string | null }) {
  const [limit, setLimit] = useState(PROMPT_PAGE);
  const titlesRes = usePromptTitles(token, session);
  const titleMap = titlesRes?.enabled ? titlesRes.titles : undefined;
  // Keyed by prompt index (append-only in a session file), so rows stay expanded across live refreshes.
  const [openState, setOpenIdx] = useState<ReadonlySet<number>>(new Set());
  const openIdx = retainKeys(openState, session.prompts.map((p) => p.index));
  const { own, inherited, from, others } = splitInherited(session.prompts);
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
        navigateToList();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const titlesError = titlesRes?.enabled && titlesRes.error ? <p className="muted titles-error" role="status">{titlesRes.error}</p> : null;

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
      const idx = Number(target.dataset.index);
      if (session.prompts[idx]?.inheritedFrom !== undefined) return;
      window.location.hash = routeHref({ kind: "map", id, index: idx });
    }
  };

  return (
    <>
      <div className="session-head">
        <h2>{session.title || session.sessionId}</h2>
        <p className="muted">
          {session.branch ? <span className="mono">{session.branch}</span> : null}
          {session.worktree === undefined ? null : session.worktree === "." ? " · main checkout" : ` · worktree ${session.worktree}`}
          {" "}{plural(nonInheritedCount, "prompt")}{inheritedCount > 0 ? ` + ${inheritedCount} inherited` : ""}
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
        <>
          <p className="empty">This session has no prompts.</p>
          {titlesError}
        </>
      ) : (
        <>
          {show === "attention" ? <p className="muted">Showing {rows.length} of {nonInheritedCount} prompts.</p> : null}
          <div className="prompt-rows" onKeyDown={onRowsKey}>
            {rows.length === 0 && show === "attention" ? (
              <p className="empty">No prompts need attention.</p>
            ) : (
              <>
                <TimeLegend />
                <div className="table-scroll">
                  <table className="prompts">
                    <PromptHead />
                    <tbody>
                      {shown.map((p) => (
                        <Row key={p.index} sessionId={id} p={p} open={openIdx.has(p.index)} onToggle={() => toggle(p.index)} generated={titleForPrompt(titleMap, p)} />
                      ))}
                    </tbody>
                  </table>
                </div>
                {hidden > 0 ? (
                  <p>
                    <button type="button" className="more" onClick={() => setLimit(nextLimit(limit, rows.length))}>
                      Show more ({hidden} hidden)
                    </button>
                  </p>
                ) : null}
              </>
            )}
            {inheritedCount > 0 ? <InheritedGroup sessionId={id} rows={inherited} from={from} others={others} openIdx={openIdx} onToggle={toggle} titles={titleMap} /> : null}
          </div>
          {titlesError}
          {rows.length > 0 ? <p className="muted keys">Keys: Tab to a prompt, ↑/↓ move, Enter expands, s Steps, m Map, Esc back to sessions.</p> : null}
        </>
      )}
    </>
  );
}
