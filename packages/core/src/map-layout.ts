/**
 * Deterministic 2D layered layout for the import map (plan M8) and the node cap (M3).
 *
 * Layers are horizontal bands named after the first path segment (`packages/<x>` / `apps/<x>` for
 * monorepo packages). Layers are ordered by (number of changed nodes desc, name), nodes within a
 * layer by path, and edges by (from, to). Shuffling the inputs therefore never changes the output.
 */

import type { MapEdge, MapLayer, MapNode, Status } from "./schema.js";

/** Hard cap of rendered nodes; changed files are always kept (plan M3). */
export const MAP_NODE_MAX = 150;
/** Fixed grid geometry (px). */
export const MAP_COLUMNS = 6;
export const MAP_NODE_WIDTH = 200;
export const MAP_NODE_HEIGHT = 34;
export const MAP_GAP_X = 24;
export const MAP_GAP_Y = 10;
export const MAP_LAYER_GAP = 22;
export const MAP_PAD = 24;

export interface MapNodeInput {
  path: string;
  changed: boolean;
  /** Verification status; ignored for unchanged neighbours. */
  status?: Status | null;
  /** The changed file no longer exists on disk (plan M2). */
  deleted?: boolean;
}

export interface MapEdgeInput {
  from: string;
  to: string;
  kind: "import" | "type";
}

export interface MapLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  layers: MapLayer[];
  width: number;
  height: number;
}

export interface NeighbourRank {
  path: string;
  /** Number of edges connecting the neighbour to the changed set. */
  edges: number;
}

export interface LayoutImportMapOptions {
  /** Source root directories where subpackages/apps form separate layers (e.g. Django roots). */
  layerRoots?: readonly string[];
}

export interface SelectedMapNodes {
  changed: string[];
  neighbours: string[];
  hiddenNeighbours: number;
  truncated: boolean;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Layer name: `packages/<x>` / `apps/<x>` for those trees, else the first path segment. */
export function layerOf(path: string, opts?: LayoutImportMapOptions): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (opts?.layerRoots && opts.layerRoots.length > 0) {
    const roots = opts.layerRoots
      .map((r) => r.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
      .filter((r) => r !== "" && r !== ".");
    roots.sort((a, b) => b.length - a.length);
    for (const root of roots) {
      if (clean === root || clean.startsWith(root + "/")) {
        const remainder = clean === root ? "" : clean.slice(root.length + 1);
        const parts = remainder.split("/").filter((p) => p !== "");
        if (parts.length > 1) {
          return `${root}/${parts[0]}`;
        }
        return root;
      }
    }
  }
  const parts = clean.split("/").filter((p) => p !== "");
  const first = parts[0] ?? "";
  if ((first === "packages" || first === "apps") && parts.length > 1 && parts[1] !== undefined) return `${first}/${parts[1]}`;
  return first;
}

/**
 * Keeps all changed files and the best-ranked neighbours up to `max` (M3): edge count desc, then
 * path. Duplicate paths are collapsed and changed files win over neighbours.
 */
export function selectMapNodes(
  changed: readonly string[],
  neighbours: readonly NeighbourRank[],
  max: number = MAP_NODE_MAX,
): SelectedMapNodes {
  const changedSet = new Set(changed.filter((p) => p !== ""));
  const changedSorted = [...changedSet].sort(cmp);

  const ranks = new Map<string, number>();
  for (const n of neighbours) {
    if (n.path === "" || changedSet.has(n.path)) continue;
    ranks.set(n.path, (ranks.get(n.path) ?? 0) + (Number.isFinite(n.edges) ? n.edges : 0));
  }
  const ranked = [...ranks.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .map(([path]) => path);

  const room = Math.max(0, Math.floor(max) - changedSorted.length);
  const kept = ranked.slice(0, room);
  return {
    changed: changedSorted,
    neighbours: kept,
    hiddenNeighbours: ranked.length - kept.length,
    truncated: ranked.length > kept.length,
  };
}

interface Placed {
  input: MapNodeInput;
  layer: string;
  changed: boolean;
  deleted: boolean;
  status: Status | null;
}

function mergeDuplicate(path: string, inputs: readonly MapNodeInput[], opts?: LayoutImportMapOptions): Placed {
  const changed = inputs.some((n) => n.changed);
  const deleted = inputs.every((n) => n.deleted === true);
  const statuses = inputs
    .filter((n) => n.changed && n.status !== undefined && n.status !== null)
    .map((n) => n.status as Status)
    .sort(cmp);
  return {
    input: { path, changed, ...(statuses.length > 0 ? { status: statuses[0] } : {}) },
    layer: layerOf(path, opts),
    changed,
    deleted,
    status: changed ? (statuses[0] ?? null) : null,
  };
}

/** Computes node positions, layer bands and elbow edge paths. Pure and input-order independent. */
export function layoutImportMap(
  nodes: readonly MapNodeInput[],
  edges: readonly MapEdgeInput[],
  opts?: LayoutImportMapOptions,
): MapLayout {
  const byPath = new Map<string, MapNodeInput[]>();
  for (const n of nodes) {
    if (n.path === "") continue;
    const list = byPath.get(n.path);
    if (list === undefined) byPath.set(n.path, [n]);
    else list.push(n);
  }
  const placed = [...byPath.entries()]
    .map(([path, list]) => mergeDuplicate(path, list, opts))
    .sort((a, b) => cmp(a.layer, b.layer) || cmp(a.input.path, b.input.path));

  const layerMap = new Map<string, Placed[]>();
  for (const p of placed) {
    const list = layerMap.get(p.layer);
    if (list === undefined) layerMap.set(p.layer, [p]);
    else list.push(p);
  }
  const layerNames = [...layerMap.keys()].sort((a, b) => {
    const changedA = layerMap.get(a)!.filter((p) => p.changed).length;
    const changedB = layerMap.get(b)!.filter((p) => p.changed).length;
    return changedB - changedA || cmp(a, b);
  });

  const outNodes: MapNode[] = [];
  const layers: MapLayer[] = [];
  let y = MAP_PAD;
  let width = 0;
  for (const name of layerNames) {
    const members = layerMap.get(name)!.slice().sort((a, b) => cmp(a.input.path, b.input.path));
    const rows = Math.ceil(members.length / MAP_COLUMNS);
    const height = rows * MAP_NODE_HEIGHT + Math.max(0, rows - 1) * MAP_GAP_Y;
    layers.push({ name, y, height, nodeCount: members.length });
    members.forEach((p, i) => {
      const row = Math.floor(i / MAP_COLUMNS);
      const col = i % MAP_COLUMNS;
      outNodes.push({
        id: p.input.path,
        path: p.input.path,
        label: basename(p.input.path),
        layer: name,
        kind: p.changed ? "changed" : "neighbour",
        status: p.changed ? p.status : null,
        deleted: p.deleted,
        x: MAP_PAD + col * (MAP_NODE_WIDTH + MAP_GAP_X),
        y: y + row * (MAP_NODE_HEIGHT + MAP_GAP_Y),
        width: MAP_NODE_WIDTH,
        height: MAP_NODE_HEIGHT,
      });
    });
    const usedCols = Math.min(members.length, MAP_COLUMNS);
    width = Math.max(width, usedCols * MAP_NODE_WIDTH + Math.max(0, usedCols - 1) * MAP_GAP_X);
    y += height + MAP_LAYER_GAP;
  }

  const index = new Map(outNodes.map((n) => [n.id, n]));
  const edgeMap = new Map<string, { from: string; to: string; kind: "import" | "type" }>();
  for (const e of edges) {
    if (e.from === "" || e.to === "" || e.from === e.to) continue;
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a.deleted || b.deleted) continue;
    const key = `${e.from}\u0000${e.to}`;
    const cur = edgeMap.get(key);
    if (cur === undefined) edgeMap.set(key, { from: e.from, to: e.to, kind: e.kind });
    // A pair imported both ways is not type-only: keep the normal import edge.
    else if (cur.kind === "type" && e.kind === "import") cur.kind = "import";
  }

  const outEdges: MapEdge[] = [...edgeMap.values()]
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to))
    .map((e) => {
      const a = index.get(e.from)!;
      const b = index.get(e.to)!;
      const right = b.x >= a.x;
      const x1 = right ? a.x + a.width : a.x;
      const y1 = a.y + a.height / 2;
      const x2 = right ? b.x : b.x + b.width;
      const y2 = b.y + b.height / 2;
      const mid = (x1 + x2) / 2;
      return { from: e.from, to: e.to, kind: e.kind, points: [{ x: x1, y: y1 }, { x: mid, y: y1 }, { x: mid, y: y2 }, { x: x2, y: y2 }] };
    });

  const height = layers.length === 0 ? 0 : y - MAP_LAYER_GAP + MAP_PAD;
  return { nodes: outNodes, edges: outEdges, layers, width: width === 0 ? 0 : width + MAP_PAD * 2, height };
}
