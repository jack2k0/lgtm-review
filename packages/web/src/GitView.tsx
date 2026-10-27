import type { GitCrosscheckResponse } from "@lgtm/core";
import { formatStarted, routeHref } from "./viewmodel";

export function GitView({
  data,
  onRefresh,
}: {
  data: GitCrosscheckResponse;
  onRefresh?: () => void;
}) {
  const backLink = (
    <p>
      <a href={routeHref({ kind: "session", id: data.sessionId })}>← Back to session</a>
    </p>
  );

  const header = (
    <>
      {backLink}
      <h2>Git cross-check</h2>
      <button type="button" className="more" onClick={onRefresh}>
        Refresh
      </button>
      <p>
        What git shows for this session's directory, next to the files its prompts edited. A
        snapshot: Refresh runs git again.
      </p>
    </>
  );

  if (!data.available) {
    return (
      <>
        {header}
        {data.notes.map((note, i) => (
          <p key={i} className="empty">
            {note}
          </p>
        ))}
      </>
    );
  }

  const notInLogEntries = [
    ...data.uncommitted
      .filter((e) => !e.inLog)
      .map((e) => ({ ...e, where: "uncommitted" })),
    ...data.committed
      .filter((e) => !e.inLog)
      .map((e) => ({ ...e, where: "committed in the window" })),
  ];

  const inBoth = new Set<string>();
  for (const e of data.uncommitted) {
    if (e.inLog) inBoth.add(e.path);
  }
  for (const e of data.committed) {
    if (e.inLog) inBoth.add(e.path);
  }

  return (
    <>
      {header}
      <p className="muted">
        {data.ref === null
          ? "Commits were not read."
          : `Commits of ${data.ref} between ${formatStarted(data.since)} and ${formatStarted(
              data.until,
            )} (${data.commitCount} commits, merges excluded).`}
      </p>

      <h3>Changed in git but not in the log ({notInLogEntries.length})</h3>
      {notInLogEntries.length === 0 ? (
        <p className="muted">Nothing: every file git shows was edited by this session.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Where</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {notInLogEntries.map((e, i) => (
              <tr key={i}>
                <td>{e.path}</td>
                <td>{e.where}</td>
                <td>{e.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Edited in the log but not changed in git ({data.notInGit.length})</h3>
      {data.notInGit.length === 0 ? (
        <p className="muted">Nothing.</p>
      ) : (
        <ul>
          {data.notInGit.map((path, i) => (
            <li key={i}>{path}</li>
          ))}
        </ul>
      )}

      <p>{inBoth.size} files appear in both.</p>

      {data.outsideRepo > 0 && (
        <p className="muted">
          {data.outsideRepo} edited files outside the repository were not compared.
        </p>
      )}

      {data.truncated && (
        <p className="muted">Lists were cut at 2000 files or 500 commits.</p>
      )}

      {data.notes.map((note, i) => (
        <p key={i} className="muted">
          {note}
        </p>
      ))}

      <p className="muted">
        Not in the log can be your own change, a formatter or generator, or a shell edit
        the log does not show. Commits are matched by committer date; rebased or amended
        commits can fall outside the window. This view never changes a status.
      </p>
    </>
  );
}
