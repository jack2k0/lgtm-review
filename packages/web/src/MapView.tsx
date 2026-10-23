import type { ImportMapResponse, MapNode } from "@lgtm/core";
import { plural, routeHref, statusLabel, STATUS_ORDER } from "./viewmodel";

/** One-line note for the two different truncation causes (node cap vs scan caps); null when nothing was cut. */
export function truncationNote(map: Pick<ImportMapResponse, "truncated" | "hiddenNeighbours">): string | null {
  if (map.hiddenNeighbours > 0) return `${plural(map.hiddenNeighbours, "neighbour")} hidden by the node cap.`;
  if (map.truncated) return "Some files or imports were skipped while building the map.";
  return null;
}

function nodeTitle(n: MapNode): string {
  const parts = [n.path];
  if (n.kind === "neighbour") parts.push("linked, unchanged");
  else parts.push(n.status === null ? "changed" : statusLabel(n.status).toLowerCase());
  if (n.deleted) parts.push("deleted, missing on disk");
  return parts.join(" — ");
}

function nodeClass(n: MapNode): string {
  return [
    "map-node",
    n.kind === "changed" ? "map-node-changed" : "map-node-neighbour",
    `map-status-${n.status ?? "none"}`,
    n.deleted ? "map-node-deleted" : "",
  ]
    .filter((c) => c !== "")
    .join(" ");
}

/**
 * The map is drawn from the server's precomputed layout: layer bands, one rect per node, elbow polylines for
 * edges. Changed files that still exist link to their prompt's diff; neighbours and deleted files stay text
 * (plan M5/M9). Every server string is a React text node inside the SVG — never markup.
 */
export function MapView({ sessionId, map }: { sessionId: string; map: ImportMapResponse }) {
  const back =
    map.prompt === null
      ? { href: routeHref({ kind: "session", id: sessionId }), label: "← Back to session" }
      : { href: routeHref({ kind: "steps", id: sessionId, index: map.prompt }), label: "← Back to steps" };
  const note = truncationNote(map);

  return (
    <>
      <p><a href={back.href}>{back.label}</a></p>
      <div className="session-head">
        <h2>Import map</h2>
        <p className="muted">{map.prompt === null ? "Whole session" : `Prompt ${map.prompt + 1}`}</p>
      </div>
      <p className="muted map-caption">Imports as of now (working tree)</p>
      {map.notes?.map((n, i) => (
        <p key={i} className="muted map-note">{n}</p>
      ))}
      {note === null ? null : <p className="map-note" role="note">{note}</p>}
      <ul className="legend map-legend" aria-label="Map legend">
        {STATUS_ORDER.map((s) => (
          <li key={s} className="legend-item">
            <span className={`dot dot-${s}`} aria-hidden="true" />
            {statusLabel(s)}
          </li>
        ))}
        <li className="legend-item">
          <span className="swatch map-swatch-linked" aria-hidden="true" />
          Linked (unchanged)
        </li>
        <li className="legend-item">
          <span className="swatch map-swatch-deleted" aria-hidden="true" />
          Deleted (missing on disk)
        </li>
        <li className="legend-item">
          <span className="map-legend-dash" aria-hidden="true" />
          Type-only import
        </li>
      </ul>
      {map.nodes.length === 0 ? (
        <p className="empty">No TS/JS files changed</p>
      ) : (
        <div className="map-scroll">
          <svg
            className="import-map"
            viewBox={`0 0 ${map.width} ${map.height}`}
            width={map.width}
            height={map.height}
            role="group"
            aria-label="Layered map of changed files and their direct in-repo imports"
          >
            <g className="map-layers">
              {map.layers.map((l) => (
                <g key={l.name} className="map-layer">
                  <rect className="map-band map-band-label" x={0} y={l.y - 18} width={map.width} height={18} rx={2} />
                  <text className="map-layer-name" x={8} y={l.y - 5}>{l.name}</text>
                  <rect className="map-band" x={0} y={l.y} width={map.width} height={l.height} rx={2} />
                </g>
              ))}
            </g>
            <g className="map-edges">
              {map.edges.map((e) => (
                <polyline
                  key={`${e.from}\u0000${e.to}\u0000${e.kind}`}
                  className={`map-edge${e.kind === "type" ? " map-edge-type" : ""}`}
                  points={e.points.map((p) => `${p.x},${p.y}`).join(" ")}
                />
              ))}
            </g>
            <g className="map-nodes">
              {map.nodes.map((n) => {
                const index = n.promptIndex ?? map.prompt;
                const href = n.kind === "changed" && !n.deleted && index !== null && index !== undefined
                  ? routeHref({ kind: "diff", id: sessionId, index, path: n.path })
                  : null;
                const shape = (
                  <g className={nodeClass(n)}>
                    <title>{nodeTitle(n)}</title>
                    <rect className="map-rect" x={n.x} y={n.y} width={n.width} height={n.height} rx={4} />
                    <text className="map-label" x={n.x + 10} y={n.y + n.height / 2 + 4}>{n.label}</text>
                  </g>
                );
                return href === null ? (
                  <g key={n.id}>{shape}</g>
                ) : (
                  <a key={n.id} className="map-node-link" href={href} aria-label={`Open diff of ${n.path}`}>{shape}</a>
                );
              })}
            </g>
          </svg>
        </div>
      )}
    </>
  );
}
