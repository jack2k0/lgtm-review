import type { SessionsResponse } from "@lgtm/core";
import { StatusDot } from "./StatusDot";
import { needText, sessionAttention, type Show } from "./triage";
import { formatStarted, plural, routeHref, statusCountItems } from "./viewmodel";

export function SessionList({ data, show = "all" }: { data: SessionsResponse; show?: Show }) {
  if (data.sessions.length === 0) {
    return <p className="empty">No sessions found for {data.dir}</p>;
  }
  const n = data.sessions.length;
  const attention = data.sessions.filter((s) => sessionAttention(s) > 0);
  const rows = show === "attention" ? attention : data.sessions;
  return (
    <>
      <p className="muted">{plural(n, "session")} for {data.dir} · {needText(attention.length, "session")}</p>
      <nav className="filters" aria-label="Filter sessions">
        <a href={routeHref({ kind: "list" })} aria-current={show === "all" ? "page" : undefined}>All ({n})</a>
        <a href={routeHref({ kind: "list", show: "attention" })} aria-current={show === "attention" ? "page" : undefined}>Needs attention ({attention.length})</a>
      </nav>
      {show === "attention" ? <p className="muted">Showing {rows.length} of {n} sessions.</p> : null}
      {rows.length === 0 ? (
        <p className="empty">No sessions need attention.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Branch</th>
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
