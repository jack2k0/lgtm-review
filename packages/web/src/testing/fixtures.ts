import type { ImportMapResponse, MapNode, PlayBeat, PlayResponse, PromptAnalysis, PromptDetail, SessionAnalysis, SessionSummary } from "@lgtm/core";

export const makePrompt = (index: number, over: Partial<PromptAnalysis> = {}): PromptAnalysis => ({
  index,
  uuid: `u${index}`,
  text: `Prompt ${index}`,
  status: "checked",
  reason: "ok",
  files: [],
  partial: false,
  timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
  activeMs: 0,
  headline: "No timing data",
  hints: [],
  recommendation: "skim",
  ...over,
});

export const makeSession = (prompts: PromptAnalysis[] = [], over: Partial<SessionAnalysis> = {}): SessionAnalysis => ({
  sessionId: "sess-own",
  title: "Own session",
  branch: "main",
  startedAt: null,
  prompts,
  warnings: [],
  ...over,
});

export const makeSummary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  title: "Session one",
  branch: "main",
  startedAt: null,
  promptCount: 2,
  statusCounts: { checked: 2, unchecked: 0, failing: 0, "no-changes": 0 },
  warningCount: 0,
  inheritedCount: 0,
  ...over,
});

export const makeDetail = (over: Partial<PromptDetail> = {}): PromptDetail => ({
  index: 0,
  text: "Do it",
  status: "checked",
  reason: "ok",
  headline: "No timing data",
  startedAt: null,
  activeMs: 0,
  truncated: false,
  hints: [],
  recommendation: "skim",
  steps: [],
  ...over,
});

export function makeNode(over: Partial<MapNode> & { id: string }): MapNode {
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

export function makeMap(over: Partial<ImportMapResponse> = {}): ImportMapResponse {
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

export function makePlay(beats: Partial<PlayBeat>[] = []): PlayResponse {
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
