# Play the change (S-07) Implementation Plan

## Overview

A reviewer opens a prompt's map and presses **▶ Play the change**. The change replays as a sequence of "beats" (`3 / 9`): each beat highlights the nodes/edges it is about, dims the rest, and shows one technical line built from a template (`views.py now imports models.py`, `Created tests/test_cart.py (+40)`, `pytest -> failed: 2 failed`, `Fix: edited cart.py (+3 -1)`). Controls: `‹ ›`, Pause/Play, Done; keys `←/→/Space/Escape`. Edges also get a "new" vs "existing" distinction on the map (PROPOSAL §5.4 legend: New import / Existing).

## Current State Analysis

- Per-prompt map exists: `GET /api/sessions/:id/map?prompt=N` (`packages/cli/src/map.ts` `planImportMap`, `packages/cli/src/api.ts` `mapRoute`), nodes `changed|neighbour`, edges `import|type`, no notion of which edges the prompt added.
- Per-prompt steps exist: `PromptDetail.steps[]` (`schema.ts` `Step`: `n`, `phase` Read/Write/Check/Fix, `title`, `check?`, `files[]` edited in the step).
- Per-prompt file diffs: `analyzer.diffFor(promptIndex, path): FileDiff` (`kind` A/M/D, hunks with `+`/`-` lines).
- Web: `MapView.tsx` renders SVG nodes/edges/layers; routes in `viewmodel.ts` (`#/session/<id>/prompt/<n>/map`).

## Desired End State

- `MapEdge` carries optional `new: true` when the import line was added by the prompt (per-prompt map) / by any non-inherited prompt (session map). Map legend: "New import N · Existing M"; new edges drawn solid and brighter, existing grey (type-only stays dashed).
- `GET /api/sessions/:id/prompts/:n/play` returns `PlayResponse { sessionId, prompt, beats: PlayBeat[], truncated }` built by a pure core function from the prompt's steps, file diffs and the per-prompt map.
- Web: "Play" button on the per-prompt map; route `#/session/<id>/prompt/<n>/play` (optional `?beat=k`, 1-based); the beat overlay drives the existing SVG (focus/dim), no new rendering engine.

## What We're NOT Doing

- No LLM captions/details (S-08); `caption` field not added now.
- No "removed import" beats or dotted removed edges (the target may not be on the working-tree map).
- No session-level play (prompt only). No new-package beats (manifest edits are ordinary file beats).
- No animation library, no canvas; CSS transitions on opacity only, disabled under `prefers-reduced-motion`.
- No change to how steps/statuses are computed.

## Design decisions (binding)

D1. New-edge detection (CLI, `map.ts`): for the prompt(s) of the map, take each changed file's `FileDiff` (`analyzer.diffFor`); join its `+` lines (in order, newline-separated) into a pseudo-source; run the language's extractor (`extractImports` / `extractPythonImports`) and resolver against the file's path; every resolved target forms a key `from\0to`. An edge whose key is in that set gets `new: true`. Session map: union over the non-inherited prompts that changed the file. Files with `kind: "A"` -> all their edges are new. Cheap: only changed files' diffs, already in memory. `planImportMap` gets the analyzer (or a `diffFor` callback) as an extra argument; fingerprint unchanged (diffs derive from the session stamp already in the key).
D2. Schema (core): `MapEdge.new: z.boolean().optional()`; `PlayBeat` and `PlayResponse`:
  ```ts
  PlayBeat = { n: int>=1, kind: "file-added"|"file-changed"|"file-deleted"|"import-added"|"check-passed"|"check-failed"|"check-unknown",
               fix: boolean,               // beat belongs to a Fix-phase step
               step: int>=1,               // Step.n it comes from
               text: string,               // template, <= 160 chars
               detail?: string,            // check excerpt (<= 200 chars) for failed checks
               path?: string,              // file beats: the file; import beats: the importer
               focus: { nodes: string[], edges: { from: string, to: string }[] } }
  PlayResponse = { sessionId, prompt: int, beats: PlayBeat[], truncated: boolean }
  ```
D3. Beat order (core, pure `buildBeats({ steps, diffs, map }): { beats, truncated }`): walk steps in order (`Step.n`).
  - For each path in `step.files` not yet seen in this prompt (first edit wins, PROPOSAL §9.8): a file beat (`kind` from `FileDiff.kind`: A -> added, D -> deleted, M -> changed), then one `import-added` beat per `new` edge whose `from` is that path, sorted by `to`.
  - A later edit of an already-seen file in a Fix step adds a file beat with `fix: true` (one per step per file); later non-Fix re-edits add nothing.
  - A step with `check`: one check beat (`passed === true` -> passed, `false` -> failed with `detail` = excerpt, `null` -> unknown).
  - Cap: 60 beats; `truncated: true` when more would follow.
D4. Templates (exact, English, file names = basename unless two focused files share a basename, then repo path):
  - added: `Created <file> (+<a>)`; changed: `Edited <file> (+<a> -<r>)`; deleted: `Deleted <file>`; prefix `Fix: ` when `fix`.
  - import-added: `<from> now imports <to>`.
  - check: `<command, oneLine 80> -> passed|failed|no result`.
  - `+a/-r` = counts of `+`/`-` lines in the file's prompt diff (whole prompt, not per step).
D5. Focus: file beat -> node of the file + its `new` edges; import beat -> both nodes + that edge; check beat -> every changed node of the prompt (no edges). Paths not on the map (non-source files, capped out) are allowed in `path`/text but omitted from `focus.nodes`; a beat whose focus ends empty is still shown (text only).
D6. API: `GET /api/sessions/:id/prompts/:n/play` (token as other routes), 404 on unknown session/prompt, ETag = same key as the per-prompt map + `"play"`, 304 support. Body reuses the cached per-prompt map build.
D7. Web:
  - `Route` gets `{ kind: "play"; id; index; beat }` (`beat` 1-based, default 1, clamped), `parseRoute`/`routeHref` round-trip tests.
  - `PlayView` = `MapView` with props `focus` (nodes/edges set) + an overlay panel: `k / N`, text, detail, buttons `‹` `Pause|Play` `›` `Done` (Done -> back to the prompt map). Keyboard: ←/→ prev/next, Space play/pause, Escape done; buttons are real `<button>`s.
  - Autoplay every 2.5 s, starts paused when `prefers-reduced-motion: reduce`; stops at the last beat. Beat index is reflected in the URL (`replaceState`, no history spam).
  - Non-focused nodes/edges get a `dim` class (opacity); text only, no innerHTML.
  - Map legend shows `New import N · Existing M` counts; new edges class `edge-new`.
  - Per-prompt map shows "▶ Play the change" link to the play route; hidden when the prompt has no steps with files or checks.

## Implementation Approach

### Phase 1: Core (schema + buildBeats)
**Files**: `packages/core/src/schema.ts`, `packages/core/src/play.ts` (new), `packages/core/src/play.test.ts` (new), `packages/core/src/index.ts`.
- D2, D3, D4, D5. Pure, node-free. Tests: order by first edit, Fix re-edit beat, check beats (3 kinds + excerpt), import beats sorted, basename collision, 60 cap, focus filtering for off-map paths, empty prompt -> 0 beats.
#### Success Criteria
- `pnpm check` green; no `node:` imports in new core files.

### Phase 2: CLI (new edges + play route)
**Files**: `packages/cli/src/map.ts`, `packages/cli/src/api.ts`, `packages/cli/src/api.map.test.ts`, `packages/cli/src/api.play.test.ts` (new).
- D1, D6. Tests: a prompt that adds `import "./b"` to `a.ts` and a prompt that edits an unrelated line -> `new` only in the first; created file -> all edges new; Python `from .models import X` added -> new; play route beats order + 304 + 404 + token.
#### Success Criteria
- `pnpm check` green; existing map tests unchanged and green.

### Phase 3: Web (play route, overlay, legend)
**Files**: `packages/web/src/{viewmodel.ts,viewmodel.test.ts,App.tsx,MapView.tsx,MapView.test.tsx,PlayView.tsx,play.test.tsx,api.ts,styles.css}`.
- D7. Tests: route round-trip and clamping; rendering of beat k (text, `k / N`, dim classes, focused node not dimmed); legend counts; play link visibility; no innerHTML (existing security test covers new files).
#### Success Criteria
- `pnpm check` green.

### Phase 4: Docs (orchestrator)
- README section "Play the change", PRD FR-014, roadmap S-07 -> Done.

## Progress

### Phase 1: Core
- [ ] 1.1 Schema `MapEdge.new`, `PlayBeat`, `PlayResponse`
- [ ] 1.2 `buildBeats` + tests

### Phase 2: CLI
- [ ] 2.1 New-edge detection in map build + tests
- [ ] 2.2 `/prompts/:n/play` route + tests

### Phase 3: Web
- [ ] 3.1 Route + PlayView + keyboard/autoplay
- [ ] 3.2 Legend counts, new-edge style, play link + tests

### Phase 4: Docs
- [ ] 4.1 README, PRD, roadmap

## Proposed PRD addition

### FR-014: Play the change (v0.2)
- **Description**: For a prompt, the developer can replay its change as a sequence of beats on the import map: files created/edited/deleted in first-edit order, imports the prompt added, and check results, each with a template caption and the related nodes highlighted.
- **Priority**: nice-to-have
- **Acceptance Criteria**: beats follow first-edit order with Fix re-edits and check results; added imports are distinguished from existing ones on the map; keyboard ←/→/Space/Escape; no autoplay under reduced motion; captions come from templates (no LLM).
