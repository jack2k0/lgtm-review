import { useEffect, useState } from "react";
import type { PromptDetail, SessionAnalysis, SessionsResponse } from "@lgtm/core";
import { errorMessage, fetchPromptDetail, fetchSession, fetchSessions } from "./api";
import { PromptTable } from "./PromptTable";
import { SessionList } from "./SessionList";
import { StepsView } from "./StepsView";
import { parseRoute, routeHref, type Route } from "./viewmodel";

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, key: string): Load<T> {
  const [res, setRes] = useState<{ key: string; value: Load<T> }>({ key, value: { state: "loading" } });
  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal).then(
      (data) => setRes({ key, value: { state: "ok", data } }),
      (e: unknown) => {
        if (!ac.signal.aborted) setRes({ key, value: { state: "error", message: errorMessage(e) } });
      },
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return res.key === key ? res.value : { state: "loading" };
}

function Status<T>({ res, children }: { res: Load<T>; children: (data: T) => React.ReactNode }) {
  if (res.state === "loading") return <p className="muted" role="status">Loading…</p>;
  if (res.state === "error") return <p className="error" role="alert">{res.message}</p>;
  return <>{children(res.data)}</>;
}

function ListView({ token }: { token: string | null }) {
  const res = useLoad<SessionsResponse>((s) => fetchSessions(token, s), "list");
  return <Status res={res}>{(d) => <SessionList data={d} />}</Status>;
}

function SessionView({ token, id }: { token: string | null; id: string }) {
  const res = useLoad<SessionAnalysis>((s) => fetchSession(token, id, s), `s:${id}`);
  return (
    <>
      <p><a href={routeHref({ kind: "list" })}>&larr; All sessions</a></p>
      <Status res={res}>{(d) => <PromptTable key={d.sessionId} session={d} />}</Status>
    </>
  );
}

function StepsRoute({ token, id, index }: { token: string | null; id: string; index: number }) {
  const res = useLoad<PromptDetail>((s) => fetchPromptDetail(token, id, index, s), `p:${id}:${index}`);
  return (
    <Status res={res}>
      {(d) => <StepsView sessionId={id} detail={d} />}
    </Status>
  );
}

/** Reserved for the diff view; `#/session/<id>/prompt/<n>/diff?path=` already parses. */
function DiffRoute({ id, index }: { id: string; index: number }) {
  return (
    <>
      <p><a href={routeHref({ kind: "steps", id, index })}>&larr; Back to steps</a></p>
      <p className="empty">The diff view is not available yet.</p>
    </>
  );
}

function Routed({ token, route }: { token: string | null; route: Route }) {
  switch (route.kind) {
    case "session":
      return <SessionView token={token} id={route.id} />;
    case "steps":
      return <StepsRoute token={token} id={route.id} index={route.index} />;
    case "diff":
      return <DiffRoute id={route.id} index={route.index} />;
    case "list":
      return <ListView token={token} />;
  }
}

export function App({ token }: { token: string | null }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <>
      <header className="top">
        <h1><a href={routeHref({ kind: "list" })}>lgtm-review</a></h1>
      </header>
      <main><Routed token={token} route={route} /></main>
    </>
  );
}
