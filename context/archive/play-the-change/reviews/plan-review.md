# Plan Review: Play the change (S-07)

**Review date:** 2026-10-23  
**Reviewer:** Antigravity (plan-review)  
**Target:** `context/changes/play-the-change/plan.md`  
**Verdict:** **approve with changes** (0 blockers, 4 major, 5 minor)

---

## Executive Summary

The overall design in `plan.md` is well-scoped, elegant, and aligns with `docs/PROPOSAL.md` §5.4, §5.5, and §9.8. Replaying prompts on the 2D import map using precomputed steps, file diffs, and SVG node/edge highlighting is both performant and deterministic without introducing heavy dependencies.

However, there are four major gaps in the CLI/API wiring and schema that would stall an implementer if not addressed up front:
1. `mapRoute` does not load prompt details, making `diffFor` unavailable unless wired through `detailFor`.
2. `MapView` cannot determine whether to render the "▶ Play the change" link because `ImportMapResponse` lacks step/check indicators.
3. Cache key collisions between `mapRoute` and `playRoute` when reusing `mapCache`.
4. Undefined behavior for inherited (fork/resume) prompts in `playRoute`.

Addressing the amendments below will make each phase self-contained and ready for single-brief implementation.

---

## Findings and Concrete Fixes

### Major Findings

#### M1 (Major): `mapRoute` lacks `detailFor`, causing `diffFor` to return `null`
- **Location:** `plan.md` D1, Phase 2 (`packages/cli/src/map.ts`, `packages/cli/src/api.ts`).
- **Problem:** D1 states that `planImportMap` receives `analyzer` (or `diffFor`) to detect `new` edges. But in `packages/cli/src/api.ts:290-293`, `mapRoute` calls `allAnalyses(files)` which uses `analysisFor(f)` (`detail: false`). In `packages/core/src/analyze.ts:728`, `diffFor()` returns `null` unless the session was analyzed with `{ detail: true }`. Consequently, `diffFor` will always be `null` in `mapRoute` unless `detailFor` is used.
- **Fix:** In `packages/cli/src/api.ts`, update `mapRoute` to retrieve `detailFor(file)` (which already manages the LRU `detailCache`) and pass `(idx, path) => d?.analyzer.diffFor(idx, path)` into `planImportMap`. In `planImportMap`, make `diffFor` optional (`(promptIndex: number, path: string) => FileDiff | null`), gracefully defaulting to no new edges if `diffFor` is omitted or returns `null`.

#### M2 (Major): `ImportMapResponse` lacks a `playable` indicator for the Web UI
- **Location:** `plan.md` D7 (`MapView.tsx`), D2 (`schema.ts`).
- **Problem:** D7 specifies that the per-prompt map shows the "▶ Play the change" link, but it must be `hidden when the prompt has no steps with files or checks`. However, `MapView` only receives `map: ImportMapResponse`. `ImportMapResponse` does not contain steps or check data, and `MapRoute` in `App.tsx` only fetches `ImportMapResponse`. Without a flag on `ImportMapResponse`, `MapView` cannot evaluate this condition.
- **Fix:** Add `playable: z.boolean().optional()` to `ImportMapResponse` in `packages/core/src/schema.ts`. In `planImportMap`, set `playable: true` when `promptIndex !== null` and the prompt has at least one edited file or check (i.e. `analysis.prompts[promptIndex].files.length > 0 || analysis.prompts[promptIndex].checks.length > 0`), and the prompt is not inherited. In `MapView.tsx`, show the Play button if `map.playable === true`.

#### M3 (Major): Cache key collisions between `mapRoute` and `playRoute` in `mapCache`
- **Location:** `plan.md` D6 (`api.ts`).
- **Problem:** D6 states that `Body reuses the cached per-prompt map build`. In `packages/cli/src/api.ts:297`, `mapCache` stores entries under slot `${file.id}\0${prompt ?? "s"}`. If `playRoute` attempts to cache `PlayResponse` in `mapCache` under the same slot or key, it will overwrite the `ImportMapResponse`, causing subsequent `/map` requests to fail validation.
- **Fix:** Keep `mapCache` strictly for `ImportMapResponse` (which `playRoute` reads to get the map). Create a separate LRU cache `playCache = new Map<string, { key: string; body: PlayResponse }>()` with slot `${file.id}\0${prompt}` and key `${stamp}\0${prompt}\0${plan.fingerprint}\0play`.

#### M4 (Major): Undefined behavior for inherited prompts in `playRoute`
- **Location:** `plan.md` D1, D3, D6.
- **Problem:** `planImportMap` explicitly skips prompts where `p.inheritedFrom !== undefined`. If a client calls `GET /api/sessions/:id/prompts/:n/play` for an inherited prompt, the map has 0 changed nodes and any generated beats would be empty or disconnected from the map.
- **Fix:** Clarify that Play is only supported for own (non-inherited) prompts. In `playRoute`, if `analysis.prompts[n]?.inheritedFrom !== undefined`, return HTTP 404 (or 400). In `planImportMap`, ensure `playable` is `false`/omitted for inherited prompts so the web UI never renders a Play link for them.

---

### Minor Findings

#### M5 (Minor): Missing `window.matchMedia` guard for reduced-motion in SSR/tests
- **Location:** `plan.md` D7 (`PlayView.tsx`).
- **Problem:** Checking `window.matchMedia("(prefers-reduced-motion: reduce)").matches` directly in React components without a guard causes `TypeError: window.matchMedia is not a function` in Vitest/happy-dom/node test environments.
- **Fix:** In `PlayView.tsx`, use a safe check: `typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches`.

#### M6 (Minor): Keyboard `Space` key interception conflicts with focused `<button>`
- **Location:** `plan.md` D7.
- **Problem:** Pressing `Space` on an HTML `<button>` naturally fires the button's `click` event. If a global `window` keydown listener also binds `Space` to Play/Pause, pressing Space while focused on the Next (`›`) button would trigger both Next and Play/Pause.
- **Fix:** In the window keydown listener, ignore Space when `e.target instanceof HTMLButtonElement`: `if (e.key === " " && (e.target as HTMLElement)?.tagName === "BUTTON") return;`.

#### M7 (Minor): Accessibility: screen-reader announcements on beat changes
- **Location:** `plan.md` D7.
- **Problem:** When beats advance automatically or via keyboard, screen readers will not announce the updated caption without an ARIA live region. Also, `‹` and `›` buttons need accessible names.
- **Fix:** Add `aria-live="polite"` and `role="status"` to the beat text container in `PlayView`. Add `aria-label="Previous beat"` and `aria-label="Next beat"` to `‹` and `›`, and `aria-label="Play"` / `aria-label="Pause"` to the toggle button.

#### M8 (Minor): Ambiguity in template casing and missing diff counts
- **Location:** `plan.md` D4.
- **Problem:** Overview line 5 displays `Fix: edited cart.py (+3 -1)` (lowercase `edited`), while D4 states `prefix Fix: when fix` applied to `Edited <file> (+<a> -<r>)`. Furthermore, shell edits (`maybeIncomplete`) may have empty hunks (`+0 -0`).
- **Fix:** Specify exact casing:
  - If `fix: false`: `Created <file> (+<a>)`, `Edited <file> (+<a> -<r>)`, `Deleted <file>`.
  - If `fix: true`: `Fix: created <file> (+<a>)`, `Fix: edited <file> (+<a> -<r>)`, `Fix: deleted <file>`.
  - If a file has no hunk diff lines (e.g. `maybeIncomplete`), format as `Edited <file>` (or `Fix: edited <file>`) without the `(+0 -0)` suffix.

#### M9 (Minor): Hunk joining delimiter in pseudo-source extraction
- **Location:** `plan.md` D1 (`map.ts`).
- **Problem:** If `+` lines across distinct hunks are joined with a single newline, an incomplete statement at the end of Hunk 1 might accidentally concatenate with the beginning of Hunk 2 to form an unintended import match.
- **Fix:** Join `+` lines within each hunk, and separate hunks with `;\n\n` so regex-based extractors do not bridge across disjoint diff hunks.

---

## Phase Sizing and Feasibility

- **Phase 1: Core (schema + `buildBeats`)**
  - Files: `packages/core/src/schema.ts`, `packages/core/src/play.ts`, `packages/core/src/play.test.ts`, `packages/core/src/index.ts`.
  - Pure functions, deterministic, node-free. Easily fits into 1 brief.
- **Phase 2: CLI (new edges + play route)**
  - Files: `packages/cli/src/map.ts`, `packages/cli/src/api.ts`, `packages/cli/src/api.map.test.ts`, `packages/cli/src/api.play.test.ts`.
  - Integrates `diffFor`, `playable` flag, and `/prompts/:n/play` route. Fits into 1 brief.
- **Phase 3: Web (play route, PlayView, legend)**
  - Files: `packages/web/src/{viewmodel.ts,viewmodel.test.ts,App.tsx,MapView.tsx,MapView.test.tsx,PlayView.tsx,play.test.tsx,api.ts,styles.css}`.
  - Adds `Route`, `PlayView` overlay, legend counts, keyboard/reduced-motion handlers. Fits into 1 brief.
