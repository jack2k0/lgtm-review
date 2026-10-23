import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { errorMessage, type ApiError, type Conditional } from "./api";
import { Poller, formatUpdated, type PollOutcome } from "./live";

export type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

/** What the header indicator shows about the current view. */
export interface LiveStatus {
  /** Epoch ms of the last time new data arrived; null before the first load. */
  updatedAt: number | null;
  /** Set while the last poll failed and the old data is kept. */
  lost: string | null;
}

export interface LiveContextValue {
  paused: boolean;
  report(status: LiveStatus): void;
}

export const LiveContext = createContext<LiveContextValue>({ paused: false, report: () => {} });

export const CONNECTION_LOST = "Connection lost, retrying";

/** Wording of the note that keeps the old data on screen. */
export function lostNote(e: unknown): string {
  const kind = (e as Partial<ApiError> | null)?.kind;
  return kind === "network" || kind === "server" ? CONNECTION_LOST : `${errorMessage(e)} (retrying)`;
}

const realTimers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
};

/**
 * Loads the view's data and keeps it fresh: polls every 5 s with `If-None-Match` (backoff on errors), pauses while
 * the tab is hidden or live is paused, refetches at once on return, aborts on key change / unmount.
 * Old data stays on screen when a poll fails. `key` identifies the resource; `fetcher` must be the one for that key.
 */
export function useLive<T>(fetcher: (etag: string | null, signal: AbortSignal) => Promise<Conditional<T>>, key: string): Load<T> {
  const live = useContext(LiveContext);
  const [res, setRes] = useState<{ key: string; value: Load<T> }>({ key, value: { state: "loading" } });
  const pollerRef = useRef<Poller<ReturnType<typeof setTimeout>> | null>(null);
  const pausedRef = useRef(live.paused);
  pausedRef.current = live.paused;
  const reportRef = useRef(live.report);
  reportRef.current = live.report;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let etag: string | null = null;
    let have = false;
    let updatedAt: number | null = null;
    const report = (lost: string | null) => reportRef.current({ updatedAt, lost });
    report(null);
    const poller = new Poller<ReturnType<typeof setTimeout>>({
      timers: realTimers,
      paused: pausedRef.current,
      visible: document.visibilityState === "visible",
      run: async (signal): Promise<PollOutcome> => {
        const r = await fetcherRef.current(etag, signal);
        if (signal.aborted || r.kind === "not-modified") return "same";
        etag = r.etag;
        have = true;
        updatedAt = Date.now();
        setRes({ key, value: { state: "ok", data: r.data } });
        return "changed";
      },
      onSuccess: () => report(null),
      onFailure: (e) => {
        if (have) report(lostNote(e));
        else setRes({ key, value: { state: "error", message: errorMessage(e) } });
      },
      // Without data only transient failures are worth retrying; 403/404/invalid will not fix themselves.
      retryable: (e) => have || (e as Partial<ApiError>).kind === "network" || (e as Partial<ApiError>).kind === "server",
    });
    pollerRef.current = poller;
    const onVisibility = () => poller.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
      reportRef.current({ updatedAt: null, lost: null });
    };
  }, [key]);

  useEffect(() => {
    pollerRef.current?.setPaused(live.paused);
  }, [live.paused]);

  return res.key === key ? res.value : { state: "loading" };
}

/** Header indicator: "Live · updated HH:MM:SS", a pause/resume button and, when a poll failed, a short note. */
export function LiveIndicator({ paused, status, onToggle }: { paused: boolean; status: LiveStatus; onToggle: () => void }) {
  const updated = status.updatedAt === null ? "" : ` · updated ${formatUpdated(status.updatedAt)}`;
  return (
    <div className="live">
      <span className="live-status" role="status" aria-live="polite" aria-atomic="true">
        <span className={paused ? "live-dot live-dot-paused" : "live-dot"} aria-hidden="true" />
        <span>{paused ? "Paused" : "Live"}{updated}</span>
        {status.lost ? <span className="live-lost">{status.lost}</span> : null}
      </span>
      <button type="button" className="live-btn" onClick={onToggle} aria-label={paused ? "Resume live updates" : "Pause live updates"}>
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}

/** App-level state behind the indicator; the routed view reports into it through `LiveContext`. */
export function useLiveStatus(): [LiveStatus, (s: LiveStatus) => void] {
  const [status, setStatus] = useState<LiveStatus>({ updatedAt: null, lost: null });
  const report = useCallback((s: LiveStatus) => setStatus((prev) => (prev.updatedAt === s.updatedAt && prev.lost === s.lost ? prev : s)), []);
  return [status, report];
}
