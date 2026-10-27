import { useEffect, useReducer, useMemo } from "react";
import type { ImportMapResponse, PlayBeat, PlayResponse } from "@lgtm/core";
import { MapView, type MapFocus } from "./MapView";
import { routeHref } from "./viewmodel";

export interface PlayState {
  beatIndex: number;
  playing: boolean;
}

export type PlayAction =
  | { type: "prev" }
  | { type: "next" }
  | { type: "toggle_play" }
  | { type: "set_playing"; playing: boolean }
  | { type: "set_beat"; beat: number }
  | { type: "tick" };

export function playReducer(state: PlayState, action: PlayAction, totalBeats: number): PlayState {
  if (totalBeats <= 0) return { beatIndex: 1, playing: false };

  switch (action.type) {
    case "prev":
      return {
        ...state,
        beatIndex: Math.max(1, state.beatIndex - 1),
      };
    case "next":
      return {
        ...state,
        beatIndex: Math.min(totalBeats, state.beatIndex + 1),
      };
    case "toggle_play":
      if (!state.playing && state.beatIndex >= totalBeats) {
        return { beatIndex: 1, playing: true };
      }
      return { ...state, playing: !state.playing };
    case "set_playing":
      return { ...state, playing: action.playing };
    case "set_beat":
      return {
        ...state,
        beatIndex: Math.max(1, Math.min(totalBeats, action.beat)),
      };
    case "tick":
      if (!state.playing) return state;
      if (state.beatIndex >= totalBeats) {
        return { ...state, playing: false };
      }
      return { ...state, beatIndex: state.beatIndex + 1 };
  }
}

export function isReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function handlePlayKey(
  e: { key: string; target?: EventTarget | null; defaultPrevented?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  dispatch: (action: PlayAction) => void,
  onDone: () => void,
): boolean {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (e.key === "Escape") {
    onDone();
    return true;
  }
  if (e.key === "ArrowLeft") {
    dispatch({ type: "prev" });
    return true;
  }
  if (e.key === "ArrowRight") {
    dispatch({ type: "next" });
    return true;
  }
  if (e.key === " " || e.key === "Spacebar") {
    // B6: Global Space handler ignores events whose target is a BUTTON (native click handles it).
    const target = e.target as { tagName?: string } | null;
    if (target?.tagName === "BUTTON") return false;
    dispatch({ type: "toggle_play" });
    return true;
  }
  return false;
}

export function focusForBeat(beat: PlayBeat | undefined): MapFocus | undefined {
  if (!beat) return undefined;
  return {
    nodes: new Set(beat.focus.nodes),
    edges: new Set(beat.focus.edges.map((e) => `${e.from}\0${e.to}`)),
  };
}

export interface PlayViewProps {
  sessionId: string;
  map: ImportMapResponse;
  play: PlayResponse;
  initialBeat?: number;
  initialPlaying?: boolean;
}

export function PlayView({ sessionId, map, play, initialBeat = 1, initialPlaying }: PlayViewProps) {
  const totalBeats = play.beats.length;
  const clampedInitial = Math.max(1, Math.min(totalBeats || 1, initialBeat));

  const [state, dispatch] = useReducer(
    (s: PlayState, a: PlayAction) => playReducer(s, a, totalBeats),
    undefined,
    (): PlayState => ({
      beatIndex: clampedInitial,
      playing: initialPlaying ?? (totalBeats > 1 && clampedInitial < totalBeats && !isReducedMotion()),
    }),
  );

  const onDone = () => {
    if (typeof window !== "undefined") {
      window.location.hash = routeHref({ kind: "map", id: sessionId, index: play.prompt });
    }
  };

  // Keyboard navigation: ←/→ prev/next, Space play/pause, Escape done
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (handlePlayKey(e, dispatch, onDone)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionId, play.prompt]);

  // Autoplay timer: 2.5s tick
  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(() => {
      dispatch({ type: "tick" });
    }, 2500);
    return () => clearInterval(timer);
  }, [state.playing]);

  // Reflect beat index in URL with replaceState
  useEffect(() => {
    if (typeof window !== "undefined" && window.history?.replaceState) {
      const nextHref = routeHref({ kind: "play", id: sessionId, index: play.prompt, beat: state.beatIndex });
      if (window.location.hash !== nextHref) {
        window.history.replaceState(null, "", nextHref);
      }
    }
  }, [sessionId, play.prompt, state.beatIndex]);

  const currentBeat: PlayBeat | undefined = play.beats[state.beatIndex - 1];
  const focus = useMemo(() => focusForBeat(currentBeat), [currentBeat]);

  return (
    <div className="play-view">
      <div className="play-overlay">
        <div className="play-controls">
          <button
            type="button"
            className="btn play-btn"
            aria-label="Previous beat"
            onClick={() => dispatch({ type: "prev" })}
            disabled={state.beatIndex <= 1}
          >
            ‹
          </button>
          <button
            type="button"
            className="btn play-btn"
            aria-label={state.playing ? "Pause" : "Play"}
            onClick={() => dispatch({ type: "toggle_play" })}
          >
            {state.playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className="btn play-btn"
            aria-label="Next beat"
            onClick={() => dispatch({ type: "next" })}
            disabled={state.beatIndex >= totalBeats}
          >
            ›
          </button>
          <button
            type="button"
            className="btn play-btn play-btn-done"
            aria-label="Done"
            onClick={onDone}
          >
            Done
          </button>
        </div>
        <div className="play-caption" role="status" aria-live="polite">
          <span className="play-counter">
            {totalBeats > 0 ? `${state.beatIndex} / ${totalBeats}` : "0 / 0"}
          </span>
          <span className="play-text">{currentBeat?.text ?? "No beats"}</span>
          {currentBeat?.detail ? <p className="play-detail">{currentBeat.detail}</p> : null}
          {play.truncated ? <p className="muted">Only the first {totalBeats} beats are shown.</p> : null}
        </div>
      </div>
      <MapView sessionId={sessionId} map={map} focus={focus} />
    </div>
  );
}
