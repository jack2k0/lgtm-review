import type { SessionsResponse } from "@lgtm/core";
import { StatusDot } from "./StatusDot";
import { needText, sessionAttention, type Show } from "./triage";
import { formatStarted, plural, routeHref, setLastListRoute, statusCountItems } from "./viewmodel";
import { hasWorktrees, worktreeLabels, worktreeName } from "./worktree";

export function SessionList({ data, show = "all", worktree }: { data: SessionsResponse; show?: Show; worktree?: string }) {
  setLastListRoute({
    kind: "list",
    ...(show === "attention" ? { show: "attention" } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
  });
  if (data.sessions.length === 0) {
    return <p className="empty">No sessions found for {data.dir}</p>;
  }
  const total = data.sessions.length;
  const multi = hasWorktrees(data.sessions);
  // Without several worktrees the worktree query is ignored and the markup stays the S-17 markup.
  const wt = multi ? worktree : undefined;
  const inWorktree = wt === undefined ? data.sessions : data.sessions.filter((s) => (s.worktree ?? ".") === wt);
  const n = inWorktree.length;
  const attention = inWorktree.filter((s) => sessionAttention(s) > 0);
  const rows = show === "attention" ? attention : inWorktree;
  // Links keep the other filter: the worktree links keep `show`, the attention links keep the worktree.
  const keepShow = show === "attention" ? { show: "attention" as const } : {};
  const worktreeHref = (label?: string): string => routeHref({ kind: "list", ...keepShow, ...(label !== undefined ? { worktree: label } : {}) });
  const allHref = routeHref({ kind: "list", ...(wt !== undefined ? { worktree: wt } : {}) });
  const attentionHref = routeHref({ kind: "list", show: "attention", ...(wt !== undefined ? { worktree: wt } : {}) });
  const filtered = show === "attention" || wt !== undefined;
  return (
    <>
      <p className="muted">{plural(n, "session")} for {data.dir} · {needText(attention.length, "session")}</p>
      {multi ? (
        <nav className="filters" aria-label="Filter by worktree">
          <a href={worktreeHref()} aria-current={wt === undefined ? "page" : undefined}>All worktrees</a>
          {worktreeLabels(data.sessions).map((label) => (
            <a key={label} href={worktreeHref(label)} aria-current={wt === label ? "page" : undefined}>{worktreeName(label)}</a>
          ))}
        </nav>
      ) : null}
      <nav className="filters" aria-label="Filter sessions">
        <a href={allHref} aria-current={show === "all" ? "page" : undefined}>All ({n})</a>
        <a href={attentionHref} aria-current={show === "attention" ? "page" : undefined}>Needs attention ({attention.length})</a>
      </nav>
      {filtered ? <p className="muted">Showing {rows.length} of {total} sessions.</p> : null}
      {rows.length === 0 ? (
        <p className="empty">{show === "attention" ? "No sessions need attention." : "No sessions in this worktree."}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Branch</th>
              {multi ? <th scope="col">Worktree</th> : null}
              <th scope="col">Started</th>
              <th scope="col" className="num">Prompts</th>
              <th scope="col">Statuses</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const k = sessionAttention(s);
              return (
                <tr key={s.id}>
                  <td className="title">
                    <a href={routeHref({ kind: "session", id: s.id })}>{s.title || s.id}</a>
                    {s.archived ? (
                      <>
                        {" "}
                        <span className="badge muted" title="Original log deleted by Claude Code; read from the lgtm-review archive">
                          archived
                        </span>
                      </>
                    ) : null}
                    {s.warningCount > 0 ? <span className="muted"> ({plural(s.warningCount, "warning")})</span> : null}
                  </td>
                  <td className="mono">{s.branch || "—"}</td>
                  {multi ? <td className="mono">{worktreeName(s.worktree ?? ".")}</td> : null}
                  <td className="nowrap">{formatStarted(s.startedAt)}</td>
                  <td className="num">
                    {s.promptCount}{s.inheritedCount > 0 ? ` + ${s.inheritedCount} inherited` : ""}
                  </td>
                  <td>
                    <span className="counts">
                      {statusCountItems(s.statusCounts).map((c) => (
                        <StatusDot key={c.status} status={c.status} count={c.count} />
                      ))}
                    </span>
                    {k > 0 ? <span className="marker">{needText(k, "prompt")}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
