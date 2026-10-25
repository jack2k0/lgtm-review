import { useEffect, useMemo, useState } from "react";
import type { FileDiff, ImportMapResponse, PlayResponse, PromptDetail, SessionAnalysis, SessionsResponse } from "@lgtm/core";
import { errorMessage, fetchFileDiff, fetchImportMap, fetchPlay, fetchPromptDetail, fetchSession, fetchSessions } from "./api";
import { DiffView } from "./DiffView";
import { LiveContext, LiveIndicator, useLive, useLiveStatus, type Load } from "./LiveView";
import { readPaused, writePaused } from "./live";
import { MapView } from "./MapView";
import { PlayView } from "./PlayView";
import { PromptTable } from "./PromptTable";
import { SessionList } from "./SessionList";
import { StepsView } from "./StepsView";
import { sessionStore } from "./token";
import type { Show } from "./triage";
import { parseRoute, routeHref, type Route } from "./viewmodel";

function Status<T>({ res, back, backLabel = "← Back to steps", children }: { res: Load<T>; back?: string; backLabel?: string; children: (data: T) => React.ReactNode }) {
  const link = back ? <p><a href={back}>{backLabel}</a></p> : null;
  if (res.state === "loading") return <>{link}<p className="muted" role="status">Loading…</p></>;
  if (res.state === "error") return <>{link}<p className="error" role="alert">{res.message}</p></>;
  return <>{children(res.data)}</>;
}

function ListView({ token }: { token: string | null }) {
  const res = useLive<SessionsResponse>((e, s) => fetchSessions(token, e, s), "list");
  return <Status res={res}>{(d) => <SessionList data={d} />}</Status>;
}

function SessionView({ token, id, show }: { token: string | null; id: string; show: Show }) {
  const res = useLive<SessionAnalysis>((e, s) => fetchSession(token, id, e, s), `s:${id}`);
  return (
    <>
      <p>
        <a href={routeHref({ kind: "list" })}>&larr; All sessions</a>{" · "}
        <a href={routeHref({ kind: "map", id, index: null })}>Map</a>
      </p>
      <Status res={res}>{(d) => <PromptTable key={d.sessionId} session={d} show={show} />}</Status>
    </>
  );
}

function StepsRoute({ token, id, index }: { token: string | null; id: string; index: number }) {
  const res = useLive<PromptDetail>((e, s) => fetchPromptDetail(token, id, index, e, s), `p:${id}:${index}`);
  return (
    <Status res={res}>
      {(d) => <StepsView sessionId={id} detail={d} onOpenFile={(path) => { window.location.hash = routeHref({ kind: "diff", id, index, path }); }} />}
    </Status>
  );
}

function DiffRoute({ token, id, index, path }: { token: string | null; id: string; index: number; path: string }) {
  const res = useLive<FileDiff>((e, s) => fetchFileDiff(token, id, index, path, e, s), `d:${id}:${index}:${path}`);
  // Escape goes back to the steps of this prompt.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      window.location.hash = routeHref({ kind: "steps", id, index });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [id, index]);
  return (
    <Status res={res} back={routeHref({ kind: "steps", id, index })}>
      {(d) => <DiffView sessionId={id} index={index} diff={d} />}
    </Status>
  );
}

function MapRoute({ token, id, index }: { token: string | null; id: string; index: number | null }) {
  const res = useLive<ImportMapResponse>((e, s) => fetchImportMap(token, id, index, e, s), `m:${id}:${index ?? "all"}`);
  return <Status res={res}>{(d) => <MapView sessionId={id} map={d} />}</Status>;
}

function PlayRoute({ token, id, index, beat }: { token: string | null; id: string; index: number; beat: number }) {
  const mapRes = useLive<ImportMapResponse>((e, s) => fetchImportMap(token, id, index, e, s), `m:${id}:${index}`);
  const playRes = useLive<PlayResponse>((e, s) => fetchPlay(token, id, index, e, s), `p:${id}:${index}`);
  return (
    <Status res={mapRes} back={routeHref({ kind: "map", id, index })} backLabel="← Back to map">
      {(mapData) => (
        <Status res={playRes} back={routeHref({ kind: "map", id, index })} backLabel="← Back to map">
          {(playData) => (
            <PlayView sessionId={id} map={mapData} play={playData} initialBeat={beat} />
          )}
        </Status>
      )}
    </Status>
  );
}

function Routed({ token, route }: { token: string | null; route: Route }) {
  switch (route.kind) {
    case "session":
      return <SessionView token={token} id={route.id} show={route.show ?? "all"} />;
    case "steps":
      return <StepsRoute token={token} id={route.id} index={route.index} />;
    case "diff":
      return <DiffRoute token={token} id={route.id} index={route.index} path={route.path} />;
    case "map":
      return <MapRoute token={token} id={route.id} index={route.index} />;
    case "play":
      return <PlayRoute token={token} id={route.id} index={route.index} beat={route.beat} />;
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
  const [paused, setPaused] = useState<boolean>(() => readPaused(sessionStore()));
  const [status, report] = useLiveStatus();
  const ctx = useMemo(() => ({ paused, report }), [paused, report]);
  const toggle = () => {
    writePaused(sessionStore(), !paused);
    setPaused(!paused);
  };
  return (
    <LiveContext.Provider value={ctx}>
      <header className="top">
        <h1><a href={routeHref({ kind: "list" })}>lgtm-review</a></h1>
        <LiveIndicator paused={paused} status={status} onToggle={toggle} />
      </header>
      <main><Routed token={token} route={route} /></main>
    </LiveContext.Provider>
  );
}
