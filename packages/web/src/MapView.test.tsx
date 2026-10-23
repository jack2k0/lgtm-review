import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ImportMapResponse, MapNode } from "@lgtm/core";
import { MapView, truncationNote } from "./MapView";

function node(over: Partial<MapNode> & { id: string }): MapNode {
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

function map(over: Partial<ImportMapResponse> = {}): ImportMapResponse {
  return {
    sessionId: "s",
    prompt: null,
    snapshot: "working-tree",
    truncated: false,
    hiddenNeighbours: 0,
    layers: [{ name: "src", y: 24, height: 34, nodeCount: 2 }],
    nodes: [node({ id: "src/a.ts", promptIndex: 2 }), node({ id: "src/util.ts", kind: "neighbour", status: null, promptIndex: null, x: 248 })],
    edges: [{ from: "src/a.ts", to: "src/util.ts", kind: "import", points: [{ x: 224, y: 41 }, { x: 236, y: 41 }, { x: 236, y: 41 }, { x: 248, y: 41 }] }],
    width: 472,
    height: 82,
    ...over,
  };
}

const render = (over: Partial<ImportMapResponse> = {}): string => renderToStaticMarkup(<MapView sessionId="s" map={map(over)} />);

describe("MapView markup", () => {
  test("draws bands, rects, labels and polylines from the precomputed layout", () => {
    const html = render();
    expect(html).toContain("Imports as of now (working tree)");
    expect(html).toContain("map-layer");
    expect(html).toContain(">src</text>");
    expect(html).toContain(">a.ts</text>");
    expect(html).toContain(">util.ts</text>");
    expect(html).toContain('viewBox="0 0 472 82"');
    expect(html).toContain("<rect");
    expect(html).toContain("<polyline");
    expect(html).toContain('points="224,41 236,41 236,41 248,41"');
    expect(html).toContain("← Back to session");
  });

  test("changed existing nodes link to the prompt that last changed them", () => {
    const html = render();
    expect(html).toContain('href="#/session/s/prompt/2/diff?path=src%2Fa.ts"');
    expect(html).not.toContain("diff?path=src%2Futil.ts");
    expect(html).toContain("linked, unchanged");
  });

  test("a per-prompt map falls back to its own prompt and links back to steps", () => {
    const html = render({ prompt: 4, nodes: [node({ id: "src/a.ts", promptIndex: undefined })] });
    expect(html).toContain('href="#/session/s/prompt/4/diff?path=src%2Fa.ts"');
    expect(html).toContain('href="#/session/s/prompt/4"');
    expect(html).toContain("← Back to steps");
  });

  test("a session node without promptIndex is not a link", () => {
    const html = render({ nodes: [node({ id: "src/a.ts", promptIndex: null })] });
    expect(html).not.toContain("diff?path=");
    expect(html).toContain("map-node-changed");
  });

  test("deleted nodes are styled, unlinked and have no edges", () => {
    const html = render({
      nodes: [node({ id: "src/gone.ts", deleted: true, status: "no-changes" })],
      edges: [],
    });
    expect(html).toContain("map-node-deleted");
    expect(html).toContain("deleted, missing on disk");
    expect(html).not.toContain("diff?path=");
  });

  test("type edges get the dashed class, imports do not", () => {
    const typed = render({ edges: [{ from: "src/a.ts", to: "src/util.ts", kind: "type", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] });
    expect(typed).toContain("map-edge-type");
    expect(render()).toContain('class="map-edge"');
  });

  test("notes, truncation and hidden neighbours are shown as text", () => {
    expect(render({ notes: ["git ls-files failed", "5000 file cap hit"], hiddenNeighbours: 3, truncated: true })).toContain(
      "3 neighbours hidden by the node cap.",
    );
    const html = render({ notes: ["git ls-files failed", "5000 file cap hit"], truncated: true });
    expect(html).toContain("git ls-files failed");
    expect(html).toContain("5000 file cap hit");
    expect(html).toContain("Some files or imports were skipped while building the map.");
    expect(truncationNote({ truncated: false, hiddenNeighbours: 0 })).toBeNull();
  });

  test("legend names every status plus linked, deleted and type-only edges", () => {
    const html = render();
    for (const label of ["Checked", "Unchecked", "Failing", "No changes", "Linked (unchanged)", "Deleted (missing on disk)", "Type-only import"]) {
      expect(html).toContain(label);
    }
  });

  test("the empty state replaces the SVG", () => {
    const html = render({ nodes: [], edges: [], layers: [], width: 0, height: 0 });
    expect(html).toContain("No TS/JS files changed");
    expect(html).not.toContain("<svg");
  });

  test("server strings are escaped, never parsed as markup", () => {
    const evil = `<img src=x onerror=alert(1)> & "quoted" <script>boom()</script>`;
    const html = render({
      notes: [evil],
      layers: [{ name: evil, y: 24, height: 34, nodeCount: 1 }],
      nodes: [node({ id: `src/${evil}.ts`, path: `src/${evil}.ts`, label: evil })],
      edges: [],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });
});
