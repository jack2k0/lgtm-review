# Import map (S-04) Implementation Plan

## Overview

Provide a 2D layered architectural map for a session (and per prompt) displaying changed TS/JS files alongside their direct in-repo import neighbours (1 hop). Replaces the complex 3D isometric view from PROPOSAL §5.4/§9.9 with a clean 2D SVG layout grouped into horizontal layer bands (top-level folders/packages). Nodes are coloured by the prompt verification status that last modified them (`checked`, `unchecked`, `failing`, `no-changes`) or marked as linked unchanged neighbours. Clicking a changed node opens its unified diff.

## Current State Analysis

- `packages/core/src/schema.ts`: `FileChange` (L13-20) tracks modified paths per prompt (`PromptAnalysis`, L60-81), but no schemas exist for graph nodes, dependency edges, or layer groups.
- `packages/cli/src/api.ts`: API serves session summaries and details via `projectStamp` ETag hashing (L180-198, L263-298). Detail routes serve steps (L245-255) and file diffs (L256-261), but no endpoint exposes file dependency graphs.
- `packages/web/src/viewmodel.ts`: `Route` type (L124-128), `parseRoute` (L141-153), and `routeHref` (L155-166) only handle `list`, `session`, `steps`, and `diff` routes; no map navigation exists.
- `packages/web/src/App.tsx` (L62-73), `StepsView.tsx` (L1-45), `DiffView.tsx` (L1-50): UI provides linear step/diff navigation without architectural context or file relation visualization.

## Desired End State

- **Core (`@lgtm/core`)**: Pure, node-free extractor for TS/JS module imports (ESM `import`/`export ... from`, dynamic `import('literal')`, CJS `require('literal')`), resolver for relative specifiers and simple `tsconfig` paths, and deterministic 2D layer-band layout algorithm computing node `(x, y)` coordinates and edge paths. Schema defines `ImportMapResponse`, `MapNode`, `MapEdge`, `MapLayer`.
- **CLI (`@lgtm/cli`)**: `GET /api/sessions/:id/map` (and optional `?prompt=:index`) reads target files from `--dir` working tree, performs 1-hop neighbour extraction, computes map layout, and serves with strong ETags tied to session stamps and file mtimes.
- **Web (`@lgtm/web`)**: 'Map' view with pure SVG rendering (no external graphing libraries, text-only nodes, no `innerHTML`). Nodes reflect status colours and changed/linked styling. Clicking a changed file node navigates directly to `DiffView`.

## What We're NOT Doing

- No 3D isometric projection, matrix skewing, or billboard rotation (flat 2D layered SVG).
- No Python imports (deferred to S-09) or non-TS/JS source parsing.
- No whole-repo AST indexer or multi-hop transitive graph construction (strictly 1-hop in-repo neighbours).
- No heavy runtime visualization dependencies (e.g., D3, Cytoscape, Three.js); standard SVG elements only.
- No file modifications or disk mutations.

## Implementation Approach

### Phase 1: Core (extractor, resolver, 2D layout, schema)

**Files**: `packages/core/src/{schema.ts,map-extract.ts,map-layout.ts,index.ts}`, unit tests `packages/core/src/{map-extract.test.ts,map-layout.test.ts}`, synthetic fixtures.
- Define `MapNode`, `MapEdge`, `MapLayer`, `ImportMapResponse` in `schema.ts`.
- Pure regex-based extractor for static/dynamic ESM and CJS imports.
- Specifier resolver for relative paths (`./`, `../`, `.js` vs `.ts`, `index.*`) and basic tsconfig path aliases.
- Deterministic 2D layout engine partitioning nodes into horizontal layer bands by top-level package/folder.

#### Success Criteria
- `pnpm check` green; node-free grep rule for core empty; deterministic layout output across repeated runs.

### Phase 2: CLI / API (extraction over working tree, routes, ETag)

**Files**: `packages/cli/src/{api.ts,map.ts}`, tests `packages/cli/src/{api.test.ts,api.conditional.test.ts}`.
- Scan changed files from session analysis against `--dir` filesystem, extracting imports and 1-hop neighbours.
- Implement `GET /api/sessions/:id/map` with optional `?prompt=:index` query filtering.
- ETag caching incorporating `projectStamp` and stat mtimes of analyzed map files; returns 304 on unmodified requests.

#### Success Criteria
- `pnpm check` green; 200 -> 304 conditional request test passes; 404 on invalid session or bad prompt index.

### Phase 3: Web UI (Map view, SVG rendering, click-to-diff)

**Files**: `packages/web/src/{App.tsx,MapView.tsx,viewmodel.ts,api.ts,styles.css}`, tests `packages/web/src/{MapView.test.tsx,viewmodel.test.ts}`.
- Add `map` route to `Route` union, `parseRoute`, and `routeHref` in `viewmodel.ts`.
- Add 'Map' tab/button to session and prompt views.
- Implement `MapView.tsx` rendering SVG layers, nodes, and directed edges; click on changed node dispatches to diff route.

#### Success Criteria
- `pnpm check` green; innerHTML security scan passes; node click transitions to diff view.

## Progress

### Phase 1: Core
- [x] 1.1 Pure extractor, resolver, 2D layout engine, schemas and unit tests

### Phase 2: CLI / API
- [x] 2.1 Working tree traversal, `/api/sessions/:id/map` route, ETag caching and tests

### Phase 3: Web UI
- [ ] 3.1 MapView SVG component, route handling, click-to-diff navigation and tests

## Proposed PRD addition

### FR-012: 2D layered import map for changed files (v0.2)

- **Description**: Developer can open a 2D layered architectural map for a session or individual prompt showing all modified TS/JS files and their direct (1-hop) in-repo import neighbours, grouped into visual layers by top-level directory or package.
- **Priority**: should-have
- **Acceptance Criteria**:
  - Map nodes are partitioned into distinct horizontal layers based on repository structure (e.g., UI, Server, Core, Config).
  - Modified nodes are visually styled by verification status (`checked`, `unchecked`, `failing`, `no-changes`); 1-hop unchanged neighbours are visually distinguished as linked.
  - Clicking any modified file node navigates directly to its unified diff view.
  - The map is rendered via native SVG without external heavy graphing dependencies or innerHTML usage.
- > Socrates: Counter-argument considered: "An architectural import map without full repository indexing or isometric depth is incomplete and adds overhead." Resolution: kept with reduced scope; 1-hop dependency extraction from the working tree bounded to changed files provides immediate architectural context on what was affected, without indexing overhead or 3D complexity.

## Orchestrator review amendments (Opus, 2026-10-23) — override the sections above

- M1 Neighbours both ways: 1 hop = imports OF changed files (outgoing) AND in-repo files that import a changed file (incoming). Incoming needs a bounded scan: candidate files = `git ls-files` under `--dir` filtered to `\.(m|c)?[jt]sx?$`, excluding `node_modules`, `dist`, `build`, `coverage`, `*.d.ts`; hard cap 5000 files and 512 KB per file; when a cap is hit the response carries `truncated: true` and the UI shows a one-line note. If `git ls-files` fails, fall back to outgoing only + note.
- M2 Snapshot honesty: the map reflects the CURRENT working tree, not the tree at prompt time; response field `snapshot: "working-tree"`, UI caption "imports as of now". Changed files that no longer exist on disk are nodes with `deleted: true` and no edges.
- M3 Node cap: max 150 nodes; changed files always kept; neighbours ranked by edge count then path, rest dropped with `hiddenNeighbours: N`.
- M4 Path safety: every read path is resolved with realpath and must stay inside realpath(`--dir`); symlinks escaping it are skipped; only files from `git ls-files` or changed-file lists that pass this check are read. Never read outside `--dir`.
- M5 Status colour: for a session map, a changed node's status = status of the LAST prompt (by index, non-inherited, see S-13) that changed it, and its click target = that prompt's diff route for the file; per-prompt map (`?prompt=N`) uses that prompt only. Reuse existing status colour tokens/StatusDot (contrast tests already cover them).
- M6 ETag: `etagFor("map\0" + id + "\0" + projectStamp + "\0" + prompt + "\0" + sha1(response body))` is NOT acceptable (body computed anyway); instead compute the map, cache it in memory keyed by `projectStamp + prompt + max mtime/size of the files read`, and use that key as the ETag; a test shows a neighbour file edit flips the ETag.
- M7 Extractor tolerance: strip comments and string-literal-only lines are NOT required; regex over source with tests for: `import type` (edge kind `type`, still drawn dashed), side-effect `import "x"`, `export * from`, multi-line import lists, `require` inside code, template-literal dynamic imports (ignored), specifiers with query/`?raw` (strip). Resolution order: exact, `.ts .tsx .mts .cts .js .jsx .mjs .cjs`, `/index.*`, and `.js`->`.ts` rewrite (NodeNext style). tsconfig `paths`: only from `--dir/tsconfig.json` and `tsconfig.base.json` with `extends` one level, literal and single `*` patterns; JSON-with-comments tolerated; failure => ignore aliases.
- M8 Layout: layers = first path segment, or for `packages/<x>/...` / `apps/<x>/...` the `packages/<x>`; layers ordered by (number of changed nodes desc, name); within a layer nodes sorted by path; fixed grid widths; long labels shortened to file name with full path in `<title>`; edges as straight/elbow lines. Deterministic: same input set in any order => identical output (test).
- M9 Accessibility/web: changed nodes are `<a href>` (keyboard focusable) using `routeHref`; neighbours are plain `<g>` with `<title>`; legend for statuses + "linked" + "deleted"; text only, no innerHTML; viewBox scroll on overflow; empty state "No TS/JS files changed".
- M10 Phase split for delegation: Phase 1 core pure functions (extractor, resolver taking an injected `exists(path)`/`readJson` interface, layout) — no fs; Phase 2 cli fs adapter + route + cache; Phase 3 web. Each phase commits separately with `pnpm check` green.
