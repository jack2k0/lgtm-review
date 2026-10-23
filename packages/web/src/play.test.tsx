import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { ImportMapResponse, MapNode, PlayBeat, PlayResponse } from "@lgtm/core";
import {
  focusForBeat,
  handlePlayKey,
  playReducer,
  PlayView,
  type PlayAction,
  type PlayState,
} from "./PlayView";

function makeNode(over: Partial<MapNode> & { id: string }): MapNode {
  const { id, ...rest } = over;
  return {
    id,
    path: id,
    label: id.split("/").pop() ?? id,
    layer: "src",
    kind: "changed",
    status: "checked",
    promptIndex: 0,
    deleted: false,
    x: 24,
    y: 24,
    width: 200,
    height: 34,
    ...rest,
  };
}

function makeMap(over: Partial<ImportMapResponse> = {}): ImportMapResponse {
  return {
    sessionId: "s",
    prompt: 0,
    snapshot: "working-tree",
    truncated: false,
    hiddenNeighbours: 0,
    layers: [{ name: "src", y: 24, height: 34, nodeCount: 2 }],
    nodes: [makeNode({ id: "src/a.ts" }), makeNode({ id: "src/b.ts", kind: "neighbour", status: null })],
    edges: [{ from: "src/a.ts", to: "src/b.ts", kind: "import", new: true, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
    width: 400,
    height: 100,
    ...over,
  };
}

function makePlay(beats: Partial<PlayBeat>[] = []): PlayResponse {
  return {
    sessionId: "s",
    prompt: 0,
    truncated: false,
    beats: beats.map((b, i) => ({
      n: i + 1,
      kind: "file-changed",
      fix: false,
      step: 1,
      text: `Beat ${i + 1}`,
      focus: { nodes: ["src/a.ts"], edges: [] },
      ...b,
    })),
  };
}

describe("playReducer pure state transitions", () => {
  test("prev and next clamped to boundaries", () => {
    const s0: PlayState = { beatIndex: 1, playing: false };
    expect(playReducer(s0, { type: "prev" }, 3)).toEqual({ beatIndex: 1, playing: false });
    const s1 = playReducer(s0, { type: "next" }, 3);
    expect(s1).toEqual({ beatIndex: 2, playing: false });
    const s2 = playReducer(s1, { type: "next" }, 3);
    expect(s2).toEqual({ beatIndex: 3, playing: false });
    // clamped at totalBeats
    expect(playReducer(s2, { type: "next" }, 3)).toEqual({ beatIndex: 3, playing: false });
    // back
    expect(playReducer(s2, { type: "prev" }, 3)).toEqual({ beatIndex: 2, playing: false });
  });

  test("toggle_play flips playing; restarts from 1 if paused at end", () => {
    const s0: PlayState = { beatIndex: 1, playing: false };
    const s1 = playReducer(s0, { type: "toggle_play" }, 3);
    expect(s1).toEqual({ beatIndex: 1, playing: true });
    const s2 = playReducer(s1, { type: "toggle_play" }, 3);
    expect(s2).toEqual({ beatIndex: 1, playing: false });

    // paused at last beat: restarts from 1 and plays
    const atEnd: PlayState = { beatIndex: 3, playing: false };
    expect(playReducer(atEnd, { type: "toggle_play" }, 3)).toEqual({ beatIndex: 1, playing: true });
  });

  test("tick advances when playing, stops at last beat", () => {
    const s0: PlayState = { beatIndex: 1, playing: true };
    const s1 = playReducer(s0, { type: "tick" }, 3);
    expect(s1).toEqual({ beatIndex: 2, playing: true });
    const s2 = playReducer(s1, { type: "tick" }, 3);
    expect(s2).toEqual({ beatIndex: 3, playing: true });
    // at last beat: stops playing
    const s3 = playReducer(s2, { type: "tick" }, 3);
    expect(s3).toEqual({ beatIndex: 3, playing: false });

    // tick when not playing does nothing
    expect(playReducer({ beatIndex: 2, playing: false }, { type: "tick" }, 3)).toEqual({ beatIndex: 2, playing: false });
  });

  test("set_beat clamps to 1..totalBeats", () => {
    const s: PlayState = { beatIndex: 1, playing: false };
    expect(playReducer(s, { type: "set_beat", beat: 0 }, 5).beatIndex).toBe(1);
    expect(playReducer(s, { type: "set_beat", beat: -10 }, 5).beatIndex).toBe(1);
    expect(playReducer(s, { type: "set_beat", beat: 3 }, 5).beatIndex).toBe(3);
    expect(playReducer(s, { type: "set_beat", beat: 100 }, 5).beatIndex).toBe(5);
  });

  test("empty beats returns index 1 and not playing", () => {
    expect(playReducer({ beatIndex: 5, playing: true }, { type: "next" }, 0)).toEqual({ beatIndex: 1, playing: false });
  });
});

describe("handlePlayKey keyboard handler", () => {
  test("arrow keys dispatch prev and next", () => {
    const actions: PlayAction[] = [];
    const dispatch = (a: PlayAction) => actions.push(a);
    const onDone = vi.fn();

    expect(handlePlayKey({ key: "ArrowLeft" }, dispatch, onDone)).toBe(true);
    expect(actions).toEqual([{ type: "prev" }]);

    expect(handlePlayKey({ key: "ArrowRight" }, dispatch, onDone)).toBe(true);
    expect(actions).toEqual([{ type: "prev" }, { type: "next" }]);
  });

  test("Escape calls onDone", () => {
    const dispatch = vi.fn();
    const onDone = vi.fn();

    expect(handlePlayKey({ key: "Escape" }, dispatch, onDone)).toBe(true);
    expect(onDone).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("Space toggles play, but is ignored when focus is on a BUTTON (B6)", () => {
    const actions: PlayAction[] = [];
    const dispatch = (a: PlayAction) => actions.push(a);
    const onDone = vi.fn();

    // Normal space
    expect(handlePlayKey({ key: " " }, dispatch, onDone)).toBe(true);
    expect(actions).toEqual([{ type: "toggle_play" }]);

    // Space with target = BUTTON (native button click handles it)
    expect(handlePlayKey({ key: " ", target: { tagName: "BUTTON" } as any }, dispatch, onDone)).toBe(false);
    expect(actions).toHaveLength(1);
  });

  test("modifier keys and defaultPrevented are ignored", () => {
    const dispatch = vi.fn();
    const onDone = vi.fn();

    expect(handlePlayKey({ key: "ArrowRight", altKey: true }, dispatch, onDone)).toBe(false);
    expect(handlePlayKey({ key: "ArrowRight", ctrlKey: true }, dispatch, onDone)).toBe(false);
    expect(handlePlayKey({ key: "ArrowRight", metaKey: true }, dispatch, onDone)).toBe(false);
    expect(handlePlayKey({ key: "ArrowRight", shiftKey: true }, dispatch, onDone)).toBe(false);
    expect(handlePlayKey({ key: "ArrowRight", defaultPrevented: true }, dispatch, onDone)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("focusForBeat helper", () => {
  test("creates sets of node paths and from\\0to edge keys", () => {
    const focus = focusForBeat({
      n: 1,
      kind: "file-changed",
      fix: false,
      step: 1,
      text: "Edited a.ts",
      focus: { nodes: ["src/a.ts"], edges: [{ from: "src/a.ts", to: "src/b.ts" }] },
    });
    expect(focus).toBeDefined();
    expect(focus!.nodes.has("src/a.ts")).toBe(true);
    expect(focus!.nodes.has("src/b.ts")).toBe(false);
    expect(focus!.edges.has("src/a.ts\0src/b.ts")).toBe(true);
    expect(focus!.edges.has("src/b.ts\0src/a.ts")).toBe(false);
  });

  test("undefined beat returns undefined", () => {
    expect(focusForBeat(undefined)).toBeUndefined();
  });
});

describe("PlayView static rendering", () => {
  test("renders overlay with counter, text, detail and accessible buttons", () => {
    const map = makeMap();
    const play = makePlay([
      { n: 1, text: "Created src/a.ts (+10)", focus: { nodes: ["src/a.ts"], edges: [] } },
      { n: 2, text: "pytest -> failed: 1 failed", detail: "AssertionError: expected 1 to be 2", focus: { nodes: ["src/a.ts"], edges: [] } },
    ]);

    const html = renderToStaticMarkup(
      <PlayView sessionId="s" map={map} play={play} initialBeat={2} initialPlaying={false} />,
    );

    // Counter and status
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain("2 / 2");
    expect(html).toContain("pytest -&gt; failed: 1 failed");
    expect(html).toContain("AssertionError: expected 1 to be 2");

    // Buttons
    expect(html).toContain('aria-label="Previous beat"');
    expect(html).toContain('aria-label="Play"');
    expect(html).toContain('aria-label="Next beat"');
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain(">‹</button>");
    expect(html).toContain(">›</button>");
    expect(html).toContain(">Play</button>");
    expect(html).toContain(">Done</button>");
  });

  test("beat 1 focuses src/a.ts and dims non-focused elements", () => {
    const map = makeMap({
      nodes: [
        makeNode({ id: "src/a.ts", path: "src/a.ts" }),
        makeNode({ id: "src/b.ts", path: "src/b.ts" }),
      ],
      edges: [
        { from: "src/a.ts", to: "src/b.ts", kind: "import", new: true, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      ],
    });
    const play = makePlay([
      {
        n: 1,
        text: "Edited src/a.ts (+2 -1)",
        focus: { nodes: ["src/a.ts"], edges: [{ from: "src/a.ts", to: "src/b.ts" }] },
      },
    ]);

    const html = renderToStaticMarkup(
      <PlayView sessionId="s" map={map} play={play} initialBeat={1} initialPlaying={false} />,
    );

    expect(html).toContain("1 / 1");
    expect(html).toContain("Edited src/a.ts (+2 -1)");

    // a.ts is focused -> not dimmed
    expect(html).not.toMatch(/map-node[^"]*dim[^"]*"><title>src\/a\.ts/);
    // b.ts is not focused -> dimmed
    expect(html).toMatch(/map-node[^"]*dim[^"]*"><title>src\/b\.ts/);
    // edge a->b is focused -> not dimmed
    expect(html).not.toMatch(/map-edge[^"]*dim/);
  });
});
