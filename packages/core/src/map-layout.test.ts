import { describe, expect, test } from "vitest";
import {
  layerOf,
  layoutImportMap,
  selectMapNodes,
  MAP_COLUMNS,
  MAP_GAP_X,
  MAP_LAYER_GAP,
  MAP_NODE_HEIGHT,
  MAP_NODE_MAX,
  MAP_NODE_WIDTH,
  MAP_PAD,
  type MapEdgeInput,
  type MapNodeInput,
} from "./map-layout.js";

describe("layerOf", () => {
  test("top-level folders and monorepo packages/apps", () => {
    expect(layerOf("src/a.ts")).toBe("src");
    expect(layerOf("packages/core/src/a.ts")).toBe("packages/core");
    expect(layerOf("apps/web/a.tsx")).toBe("apps/web");
    expect(layerOf("packages/a/b/c.ts")).toBe("packages/a");
    expect(layerOf("index.ts")).toBe("index.ts");
    expect(layerOf("packages")).toBe("packages");
  });

  test("layerRoots groups by subpackages/apps under specified roots (D5)", () => {
    const opts = { layerRoots: ["backend"] };
    expect(layerOf("backend/orders/models.py", opts)).toBe("backend/orders");
    expect(layerOf("backend/orders/views/crud.py", opts)).toBe("backend/orders");
    expect(layerOf("backend/manage.py", opts)).toBe("backend");
    expect(layerOf("backend/core/utils.py", opts)).toBe("backend/core");
    // Non-root paths fall back to default logic
    expect(layerOf("packages/core/src/a.ts", opts)).toBe("packages/core");
    expect(layerOf("frontend/index.ts", opts)).toBe("frontend");
  });

  test("layerRoots longest root wins", () => {
    const opts = { layerRoots: ["services/backend", "services"] };
    expect(layerOf("services/backend/orders/models.py", opts)).toBe("services/backend/orders");
    expect(layerOf("services/backend/manage.py", opts)).toBe("services/backend");
    expect(layerOf("services/other/file.py", opts)).toBe("services/other");
    expect(layerOf("services/root.py", opts)).toBe("services");
  });
});

describe("selectMapNodes", () => {
  test("changed files always survive the cap", () => {
    const changed = ["c.ts", "b.ts", "a.ts"];
    const sel = selectMapNodes(changed, [{ path: "n.ts", edges: 9 }], 2);
    expect(sel.changed).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(sel.neighbours).toEqual([]);
    expect(sel.hiddenNeighbours).toBe(1);
    expect(sel.truncated).toBe(true);
  });

  test("neighbours rank by edge count then path and are capped", () => {
    const neighbours = [
      { path: "z.ts", edges: 2 },
      { path: "a.ts", edges: 2 },
      { path: "b.ts", edges: 5 },
      { path: "c.ts", edges: 1 },
    ];
    const sel = selectMapNodes(["main.ts"], neighbours, 4);
    expect(sel.neighbours).toEqual(["b.ts", "a.ts", "z.ts"]);
    expect(sel.hiddenNeighbours).toBe(1);
    expect(sel.truncated).toBe(true);
  });

  test("no cap hit: hiddenNeighbours is 0 and truncated false", () => {
    const sel = selectMapNodes(["main.ts"], [{ path: "a.ts", edges: 1 }]);
    expect(sel).toEqual({ changed: ["main.ts"], neighbours: ["a.ts"], hiddenNeighbours: 0, truncated: false });
    expect(MAP_NODE_MAX).toBe(150);
  });

  test("duplicate paths collapse, changed wins and neighbour edges sum", () => {
    const sel = selectMapNodes(
      ["main.ts", "main.ts", "a.ts"],
      [
        { path: "a.ts", edges: 100 },
        { path: "n.ts", edges: 2 },
        { path: "n.ts", edges: 3 },
      ],
    );
    expect(sel.changed).toEqual(["a.ts", "main.ts"]);
    expect(sel.neighbours).toEqual(["n.ts"]);
    expect(sel.hiddenNeighbours).toBe(0);
  });
});

describe("layoutImportMap", () => {
  const nodes: MapNodeInput[] = [
    { path: "packages/core/src/x.ts", changed: true, status: "unchecked" },
    { path: "packages/core/src/y.ts", changed: false },
    { path: "src/b.ts", changed: true, status: "failing" },
    { path: "src/a.ts", changed: true, status: "checked" },
    { path: "src/util.ts", changed: false },
    { path: "src/gone.ts", changed: true, status: "no-changes", deleted: true },
  ];
  const edges: MapEdgeInput[] = [
    { from: "src/a.ts", to: "src/util.ts", kind: "import" },
    { from: "src/a.ts", to: "packages/core/src/x.ts", kind: "type" },
    { from: "src/a.ts", to: "src/gone.ts", kind: "import" },
    { from: "src/b.ts", to: "src/a.ts", kind: "import" },
    { from: "src/a.ts", to: "src/a.ts", kind: "import" },
  ];

  test("layers are ordered by changed count then name and nodes by path", () => {
    const layout = layoutImportMap(nodes, edges);
    expect(layout.layers.map((l) => [l.name, l.nodeCount])).toEqual([
      ["src", 4],
      ["packages/core", 2],
    ]);
    expect(layout.nodes.map((n) => n.id)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/gone.ts",
      "src/util.ts",
      "packages/core/src/x.ts",
      "packages/core/src/y.ts",
    ]);
    expect(layout.nodes.find((n) => n.id === "src/a.ts")).toMatchObject({
      label: "a.ts",
      layer: "src",
      kind: "changed",
      status: "checked",
      deleted: false,
      x: MAP_PAD,
      y: MAP_PAD,
      width: MAP_NODE_WIDTH,
      height: MAP_NODE_HEIGHT,
    });
    expect(layout.nodes.find((n) => n.id === "src/util.ts")).toMatchObject({ kind: "neighbour", status: null });
  });

  test("fixed grid geometry and layer bands", () => {
    const layout = layoutImportMap(nodes, edges);
    const layer = layout.layers[0]!;
    expect(layer.y).toBe(MAP_PAD);
    expect(layer.height).toBe(MAP_NODE_HEIGHT);
    expect(layout.layers[1]!.y).toBe(MAP_PAD + MAP_NODE_HEIGHT + MAP_LAYER_GAP);
    expect(layout.nodes[1]!.x).toBe(MAP_PAD + MAP_NODE_WIDTH + MAP_GAP_X);
    const cols = Math.min(4, MAP_COLUMNS);
    expect(layout.width).toBe(cols * MAP_NODE_WIDTH + (cols - 1) * MAP_GAP_X + 2 * MAP_PAD);
    expect(layout.height).toBe(2 * MAP_PAD + 2 * MAP_NODE_HEIGHT + MAP_LAYER_GAP);
  });

  test("edges are deduped, sorted, typed and skip deleted or self edges", () => {
    const layout = layoutImportMap(nodes, [...edges, { from: "src/a.ts", to: "src/util.ts", kind: "type" }]);
    expect(layout.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ["src/a.ts", "packages/core/src/x.ts", "type"],
      ["src/a.ts", "src/util.ts", "import"],
      ["src/b.ts", "src/a.ts", "import"],
    ]);
    for (const e of layout.edges) expect(e.points).toHaveLength(4);
  });

  test("a type-only pair stays dashed, a mixed pair becomes a normal import", () => {
    const layout = layoutImportMap([{ path: "a.ts", changed: true }, { path: "b.ts", changed: false }], [
      { from: "a.ts", to: "b.ts", kind: "type" },
      { from: "a.ts", to: "b.ts", kind: "import" },
    ]);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]!.kind).toBe("import");
  });

  test("empty input produces an empty canvas", () => {
    expect(layoutImportMap([], [])).toEqual({ nodes: [], edges: [], layers: [], width: 0, height: 0 });
  });

  test("deterministic: any input order gives identical output", () => {
    const base = layoutImportMap(nodes, edges);
    const orders = [
      [...nodes].reverse(),
      [nodes[2]!, nodes[4]!, nodes[0]!, nodes[5]!, nodes[1]!, nodes[3]!],
      [nodes[3]!, nodes[1]!, nodes[5]!, nodes[2]!, nodes[4]!, nodes[0]!],
    ];
    for (const order of orders) {
      expect(layoutImportMap(order, [...edges].reverse())).toEqual(base);
      expect(JSON.stringify(layoutImportMap(order, edges))).toBe(JSON.stringify(base));
    }
  });

  test("duplicate node entries merge deterministically", () => {
    const a: MapNodeInput = { path: "src/a.ts", changed: true, status: "failing" };
    const b: MapNodeInput = { path: "src/a.ts", changed: true, status: "checked" };
    const c: MapNodeInput = { path: "src/a.ts", changed: false };
    expect(layoutImportMap([a, c], [])).toEqual(layoutImportMap([c, a], []));
    expect(layoutImportMap([a, b], []).nodes[0]!.status).toBe("checked");
    expect(layoutImportMap([b, a], []).nodes[0]!.status).toBe("checked");
  });

  test("layoutImportMap respects layerRoots and remains deterministic", () => {
    const pyNodes: MapNodeInput[] = [
      { path: "backend/orders/models.py", changed: true, status: "checked" },
      { path: "backend/orders/views.py", changed: true, status: "checked" },
      { path: "backend/core/utils.py", changed: false },
      { path: "backend/manage.py", changed: false },
    ];
    const pyEdges: MapEdgeInput[] = [
      { from: "backend/orders/views.py", to: "backend/orders/models.py", kind: "import" },
      { from: "backend/orders/views.py", to: "backend/core/utils.py", kind: "import" },
    ];
    const opts = { layerRoots: ["backend"] };
    const layout = layoutImportMap(pyNodes, pyEdges, opts);
    expect(layout.layers.map((l) => l.name)).toEqual(["backend/orders", "backend", "backend/core"]);
    expect(layout.nodes.find((n) => n.path === "backend/orders/models.py")?.layer).toBe("backend/orders");
    expect(layout.nodes.find((n) => n.path === "backend/manage.py")?.layer).toBe("backend");
    expect(layout.nodes.find((n) => n.path === "backend/core/utils.py")?.layer).toBe("backend/core");

    // Deterministic under shuffle
    const shuffled = [...pyNodes].reverse();
    expect(layoutImportMap(shuffled, pyEdges, opts)).toEqual(layout);
  });
});
