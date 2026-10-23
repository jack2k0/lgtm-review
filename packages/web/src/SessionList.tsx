import type { SessionsResponse } from "@lgtm/core";
import { StatusDot } from "./StatusDot";
import { formatStarted, plural, routeHref, statusCountItems } from "./viewmodel";

export function SessionList({ data }: { data: SessionsResponse }) {
  if (data.sessions.length === 0) {
    return <p className="empty">No sessions found for {data.dir}</p>;
  }
  return (
    <>
      <p className="muted">{plural(data.sessions.length, "session")} for {data.dir}</p>
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
          {data.sessions.map((s) => (
            <tr key={s.id}>
              <td className="title">
                <a href={routeHref({ kind: "session", id: s.id })}>{s.title || s.id}</a>
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
