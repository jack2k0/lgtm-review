import { describe, expect, test } from "vitest";
import {
  buildBeats,
  BEATS_MAX,
  type BuildBeatsInput,
  type DiffsInput,
} from "./play.js";
import {
  FileDiff,
  ImportMapResponse,
  MapEdge,
  MapNode,
  PlayResponse,
  Step,
} from "./schema.js";

function makeDiff(path: string, kind: "A" | "M" | "D", added = 0, removed = 0): FileDiff {
  const lines: { t: "+" | "-" | " "; s: string }[] = [];
  for (let i = 0; i < added; i++) lines.push({ t: "+", s: `+line ${i}` });
  for (let i = 0; i < removed; i++) lines.push({ t: "-", s: `-line ${i}` });
  return {
    path,
    kind,
    truncated: false,
    maybeIncomplete: false,
    hunks: lines.length > 0 ? [{ header: "@@ -1,1 +1,1 @@", lines }] : [],
  };
}

function makeStep(over: Partial<Step> & { n: number }): Step {
  return {
    phase: "write",
    title: "Edit files",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1000,
    quotes: [],
    actions: [],
    files: [],
    ...over,
  };
}

function makeMap(nodes: { path: string; changed?: boolean }[] = [], edges: { from: string; to: string; new?: boolean }[] = []) {
  return {
    sessionId: "sess-1",
    prompt: 0,
    snapshot: "working-tree" as const,
    truncated: false,
    hiddenNeighbours: 0,
    layers: [{ name: "src", y: 0, height: 100, nodeCount: nodes.length }],
    nodes: nodes.map((n) => ({
      id: n.path,
      path: n.path,
      label: n.path.split("/").pop() ?? n.path,
      layer: "src",
      kind: n.changed ? ("changed" as const) : ("neighbour" as const),
      status: n.changed ? ("checked" as const) : null,
      deleted: false,
      x: 0,
      y: 0,
      width: 100,
      height: 30,
    })),
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: "import" as const,
      new: e.new,
      points: [],
    })),
    width: 200,
    height: 200,
  };
}

describe("schema validation", () => {
  test("MapEdge parses optional new field", () => {
    const e = MapEdge.parse({ from: "a.ts", to: "b.ts", kind: "import", new: true, points: [] });
    expect(e.new).toBe(true);

    const e2 = MapEdge.parse({ from: "a.ts", to: "b.ts", kind: "type", points: [] });
    expect(e2.new).toBeUndefined();
  });

  test("ImportMapResponse parses optional playable field", () => {
    const raw = makeMap([{ path: "src/a.ts", changed: true }]);
    const parsed = ImportMapResponse.parse({ ...raw, playable: true });
    expect(parsed.playable).toBe(true);
  });
});

describe("buildBeats", () => {
  test("empty prompt produces empty beats and truncated false", () => {
    const res = buildBeats({
      steps: [],
      diffs: new Map(),
      map: makeMap(),
    });
    expect(res).toEqual({ beats: [], truncated: false });
    expect(PlayResponse.parse({ sessionId: "s", prompt: 0, ...res }).beats).toEqual([]);
  });

  test("emits file beats in first-edit order and ignores non-fix re-edits", () => {
    const diffs = new Map<string, FileDiff>([
      ["src/a.ts", makeDiff("src/a.ts", "A", 40, 0)],
      ["src/b.ts", makeDiff("src/b.ts", "M", 5, 2)],
      ["src/c.ts", makeDiff("src/c.ts", "D", 0, 10)],
    ]);
    const steps: Step[] = [
      makeStep({ n: 1, phase: "write", files: ["src/a.ts", "src/b.ts"] }),
      makeStep({ n: 2, phase: "write", files: ["src/b.ts", "src/c.ts"] }),
    ];
    const map = makeMap([
      { path: "src/a.ts", changed: true },
      { path: "src/b.ts", changed: true },
      { path: "src/c.ts", changed: true },
    ]);

    const { beats, truncated } = buildBeats({ steps, diffs, map });
    expect(truncated).toBe(false);
    expect(beats).toHaveLength(3);
    expect(beats.map((b) => ({ n: b.n, kind: b.kind, text: b.text, step: b.step, fix: b.fix }))).toEqual([
      { n: 1, kind: "file-added", text: "Created a.ts (+40)", step: 1, fix: false },
      { n: 2, kind: "file-changed", text: "Edited b.ts (+5 -2)", step: 1, fix: false },
      { n: 3, kind: "file-deleted", text: "Deleted c.ts", step: 2, fix: false },
    ]);
  });

  test("Fix step re-editing an already-seen file emits a file beat with fix: true (B8)", () => {
    const diffs = new Map<string, FileDiff>([
      ["src/a.ts", makeDiff("src/a.ts", "M", 3, 1)],
      ["src/fix-new.ts", makeDiff("src/fix-new.ts", "A", 15, 0)],
    ]);
    const steps: Step[] = [
      makeStep({ n: 1, phase: "write", files: ["src/a.ts"] }),
      makeStep({
        n: 2,
        phase: "check",
        check: { command: "pnpm test", exitCode: 1, passed: false, excerpt: "2 tests failed" },
      }),
      makeStep({ n: 3, phase: "fix", files: ["src/a.ts", "src/a.ts", "src/fix-new.ts"] }),
    ];
    const map = makeMap([
      { path: "src/a.ts", changed: true },
      { path: "src/fix-new.ts", changed: true },
    ]);

    const { beats } = buildBeats({ steps, diffs, map });
    expect(beats).toHaveLength(4);
    expect(beats[0]).toMatchObject({ n: 1, kind: "file-changed", text: "Edited a.ts (+3 -1)", fix: false, step: 1 });
    expect(beats[1]).toMatchObject({
      n: 2,
      kind: "check-failed",
      text: "pnpm test -> failed",
      detail: "2 tests failed",
      fix: false,
      step: 2,
    });
    // Fix re-edit: prefix "Fix: edited ..." and deduplicated within step 3
    expect(beats[2]).toMatchObject({ n: 3, kind: "file-changed", text: "Fix: edited a.ts (+3 -1)", fix: true, step: 3 });
    // First edit in Fix phase: prefix "Fix: created ..."
    expect(beats[3]).toMatchObject({ n: 4, kind: "file-added", text: "Fix: created fix-new.ts (+15)", fix: true, step: 3 });
  });

  test("omits (+a -r) suffix when file diff has no +/- lines (B8)", () => {
    const diffs: Record<string, FileDiff> = {
      "src/shell-edit.ts": {
        path: "src/shell-edit.ts",
        kind: "M",
        truncated: false,
        maybeIncomplete: true,
        hunks: [],
      },
      "src/shell-add.ts": {
        path: "src/shell-add.ts",
        kind: "A",
        truncated: false,
        maybeIncomplete: true,
        hunks: [],
      },
    };
    const steps: Step[] = [
      makeStep({ n: 1, phase: "write", files: ["src/shell-edit.ts", "src/shell-add.ts"] }),
      makeStep({ n: 2, phase: "fix", files: ["src/shell-edit.ts"] }),
    ];
    const map = makeMap([
      { path: "src/shell-edit.ts", changed: true },
      { path: "src/shell-add.ts", changed: true },
    ]);

    const { beats } = buildBeats({ steps, diffs, map });
    expect(beats[0]!.text).toBe("Edited shell-edit.ts");
    expect(beats[1]!.text).toBe("Created shell-add.ts");
    expect(beats[2]!.text).toBe("Fix: edited shell-edit.ts");
  });

  test("check beats handle passed, failed with excerpt, and unknown/no-result", () => {
    const steps: Step[] = [
      makeStep({
        n: 1,
        phase: "check",
        check: { command: "vitest run", exitCode: 0, passed: true, excerpt: "" },
      }),
      makeStep({
        n: 2,
        phase: "check",
        check: {
          command: "pnpm typecheck --project tsconfig.json",
          exitCode: 2,
          passed: false,
          excerpt: "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
        },
      }),
      makeStep({
        n: 3,
        phase: "check",
        check: { command: "python -m unittest", exitCode: null, passed: null, excerpt: "" },
      }),
    ];
    const map = makeMap([{ path: "src/a.ts", changed: true }]);

    const { beats } = buildBeats({ steps, diffs: new Map(), map });
    expect(beats).toHaveLength(3);
    expect(beats[0]).toMatchObject({
      n: 1,
      kind: "check-passed",
      text: "vitest run -> passed",
      focus: { nodes: ["src/a.ts"], edges: [] },
    });
    expect(beats[0]!.detail).toBeUndefined();
    expect(beats[1]).toMatchObject({
      n: 2,
      kind: "check-failed",
      text: "pnpm typecheck --project tsconfig.json -> failed",
      detail: "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
      focus: { nodes: ["src/a.ts"], edges: [] },
    });
    expect(beats[2]).toMatchObject({
      n: 3,
      kind: "check-unknown",
      text: "python -m unittest -> no result",
      focus: { nodes: ["src/a.ts"], edges: [] },
    });
    expect(beats[2]!.detail).toBeUndefined();
  });

  test("emits import-added beats sorted by target immediately after importer file beat", () => {
    const diffs = (path: string) => makeDiff(path, "M", 2, 0);
    const steps: Step[] = [
      makeStep({ n: 1, phase: "write", files: ["src/a.ts"] }),
    ];
    const map = makeMap(
      [
        { path: "src/a.ts", changed: true },
        { path: "src/z.ts" },
        { path: "src/b.ts" },
        { path: "src/old.ts" },
      ],
      [
        { from: "src/a.ts", to: "src/z.ts", new: true },
        { from: "src/a.ts", to: "src/b.ts", new: true },
        // existing edge (new is false/undefined) -> does NOT produce an import-added beat
        { from: "src/a.ts", to: "src/old.ts", new: false },
      ],
    );

    const { beats } = buildBeats({ steps, diffs, map });
    expect(beats).toHaveLength(3);
    expect(beats[0]).toMatchObject({ n: 1, kind: "file-changed", text: "Edited a.ts (+2 -0)" });
    expect(beats[1]).toMatchObject({
      n: 2,
      kind: "import-added",
      text: "a.ts now imports b.ts",
      path: "src/a.ts",
      focus: { nodes: ["src/a.ts", "src/b.ts"], edges: [{ from: "src/a.ts", to: "src/b.ts" }] },
    });
    expect(beats[2]).toMatchObject({
      n: 3,
      kind: "import-added",
      text: "a.ts now imports z.ts",
      path: "src/a.ts",
      focus: { nodes: ["src/a.ts", "src/z.ts"], edges: [{ from: "src/a.ts", to: "src/z.ts" }] },
    });
  });

  test("basename collision: uses repo path when from and to share basename (D4)", () => {
    const diffs = new Map([["packages/core/src/index.ts", makeDiff("packages/core/src/index.ts", "M", 1, 0)]]);
    const steps: Step[] = [
      makeStep({ n: 1, phase: "write", files: ["packages/core/src/index.ts"] }),
    ];
    const map = makeMap(
      [
        { path: "packages/core/src/index.ts", changed: true },
        { path: "packages/cli/src/index.ts" },
      ],
      [
        { from: "packages/core/src/index.ts", to: "packages/cli/src/index.ts", new: true },
      ],
    );

    const { beats } = buildBeats({ steps, diffs, map });
    expect(beats).toHaveLength(2);
    expect(beats[1]!.text).toBe("packages/core/src/index.ts now imports packages/cli/src/index.ts");
  });

  test("play beat names with two index.ts use repo paths (D4)", () => {
    const diffs = new Map([
      ["packages/core/src/index.ts", makeDiff("packages/core/src/index.ts", "M", 2, 1)],
      ["packages/cli/src/index.ts", makeDiff("packages/cli/src/index.ts", "M", 3, 0)],
      ["src/util.ts", makeDiff("src/util.ts", "M", 1, 0)],
    ]);
    const steps: Step[] = [
      makeStep({ n: 1, phase: "write", files: ["packages/core/src/index.ts", "src/util.ts"] }),
      makeStep({ n: 2, phase: "write", files: ["packages/cli/src/index.ts"] }),
    ];
    const map = makeMap([
      { path: "packages/core/src/index.ts", changed: true },
      { path: "packages/cli/src/index.ts", changed: true },
      { path: "src/util.ts", changed: true },
    ]);

    const { beats } = buildBeats({ steps, diffs, map });
    expect(beats).toHaveLength(3);
    expect(beats[0]!.text).toBe("Edited packages/core/src/index.ts (+2 -1)");
    expect(beats[1]!.text).toBe("Edited util.ts (+1 -0)");
    expect(beats[2]!.text).toBe("Edited packages/cli/src/index.ts (+3 -0)");

    // Fix re-edit with same-basename file also uses repo path
    const fixSteps: Step[] = [
      makeStep({ n: 1, phase: "write", files: ["packages/core/src/index.ts", "packages/cli/src/index.ts"] }),
      makeStep({ n: 2, phase: "fix", files: ["packages/core/src/index.ts"] }),
    ];
    const { beats: fixBeats } = buildBeats({ steps: fixSteps, diffs, map });
    expect(fixBeats[2]!.text).toBe("Fix: edited packages/core/src/index.ts (+2 -1)");
  });

  test("focus filtering for off-map paths: off-map paths excluded from focus.nodes", () => {
    const diffs = new Map([
      ["README.md", makeDiff("README.md", "M", 10, 0)],
      ["src/a.ts", makeDiff("src/a.ts", "A", 5, 0)],
    ]);
    const steps: Step[] = [
      makeStep({ n: 1, phase: "write", files: ["README.md", "src/a.ts"] }),
    ];
    // README.md is not on the map; src/a.ts is
    const map = makeMap([{ path: "src/a.ts", changed: true }]);

    const { beats } = buildBeats({ steps, diffs, map });
    expect(beats[0]!.path).toBe("README.md");
    expect(beats[0]!.focus.nodes).toEqual([]);
    expect(beats[1]!.path).toBe("src/a.ts");
    expect(beats[1]!.focus.nodes).toEqual(["src/a.ts"]);
  });

  test("caps output at BEATS_MAX (60) and marks truncated", () => {
    expect(BEATS_MAX).toBe(60);
    const steps: Step[] = [];
    const diffs = new Map<string, FileDiff>();
    for (let i = 0; i < 70; i++) {
      const p = `src/file_${i}.ts`;
      diffs.set(p, makeDiff(p, "A", 1, 0));
      steps.push(makeStep({ n: i + 1, phase: "write", files: [p] }));
    }
    const map = makeMap(Array.from({ length: 70 }, (_, i) => ({ path: `src/file_${i}.ts`, changed: true })));

    const { beats, truncated } = buildBeats({ steps, diffs, map });
    expect(beats).toHaveLength(60);
    expect(truncated).toBe(true);
    expect(beats[0]!.n).toBe(1);
    expect(beats[59]!.n).toBe(60);
  });
});
