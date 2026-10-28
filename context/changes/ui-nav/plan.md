# ui-nav: narrow screens, Escape one level up, grouped Git cross-check

Owner decision 2026-10-27 (browser check `context/archive/prompt-triage/reviews/browser-check-2026-10-26.md`, observations 1-3). Web only; no core, CLI or schema change.

```gate
allow: ^packages/web/src/(App|GitView|StepsView|MapView|PromptTable|SessionList|triage|viewmodel)\.tsx?$
allow: ^packages/web/src/[a-z.-]*\.test\.tsx?$
allow: ^packages/web/src/styles\.css$
allow: ^context/(changes|archive)/ui-nav/
labels: none
deps: no
schema: no
```

## Phase 1 (single phase)

### 1. Narrow screens (observation 1)
- Wrap every data `<table>` (prompt table, session list, Git cross-check table, any other `<table>` in `packages/web/src`) in a container with class `table-scroll` (`overflow-x: auto`), same idea as `.map-scroll`. Tables keep their own column widths (give `.table-scroll table` a sensible `min-width`, e.g. 640px) so Prompt/Reason are not squeezed to a few characters; the page itself must not scroll sideways at 390px width.
- Keyboard navigation in the prompt table (`button.rowbtn`, ↑/↓, Enter, `s`, `m`) must keep working: the wrapper is a plain `div`, it must not steal focus or key events.

### 2. Escape goes one level up (observation 2)
Same guard as today (`escapeToList` in `triage.ts`: no modifier keys, not while typing in INPUT/TEXTAREA/SELECT/contenteditable, not when `defaultPrevented`). Reuse it; do not write a second guard. Mapping:
- Steps (`#/s/<id>/p/<n>`) → session page.
- Map (whole session or one prompt) → session page.
- Git cross-check → session page.
- Diff → Steps (exists, switch it to the shared guard so typing in a field no longer navigates).
- Play keeps its own handler (Escape = Done); make sure the new handlers do not also fire on Play (only one listener per route).
- Session page → list (exists, unchanged).
Implement as one small hook (e.g. `useEscapeTo(href)` in `App.tsx`) used by each route component; the handler calls `preventDefault()` so nested handlers do not double-navigate.

### 3. Git cross-check grouped (observation 3)
The response carries no worktree per file, so group by what it does carry. In `GitView.tsx`, "Changed in git but not in the log":
- Two sub-sections in this order: "Uncommitted (N)" and "Committed in the window (N)"; drop the "Where" column (it is the section now).
- Inside each, group rows by top-level directory (first path segment; files at the repo root group under "(root)"), groups sorted by descending count then name. Each group is a `<details>` with summary `<dir>/ — N files`; groups are open when the section has ≤ 20 rows, closed otherwise.
- Keep the total in the `<h3>` heading as today. Empty sections are omitted; when both are empty keep today's "Nothing: …" sentence.
- Put the grouping in a pure function (e.g. `groupByTopDir` in `viewmodel.ts`) with unit tests.

### Done when
- Tests (pure functions + DOM tests in the style of `controls.dom.test.tsx` / `git.test.tsx`):
  - `groupByTopDir`: root files, nested paths, sort order, stable for equal counts.
  - Escape on Steps, Map and Git routes changes the hash to the session page; Escape inside an input does not; Escape with Ctrl does not.
  - Git view renders two sections and the groups; ≤20 rows open, >20 closed.
  - Every `<table>` rendered by the web app sits inside `.table-scroll` (a test may render the prompt table, session list and Git view and assert `table.closest('.table-scroll')`).
- `pnpm check` green; `node scripts/gate.mjs --base main --plan context/changes/ui-nav/plan.md` exit 0 or 2 with reasons.
- No existing test expectation changed or deleted, except the two `git.test.tsx` lines that section 3 makes obsolete ("committed in the window" as a cell, the Where column header).

### Non-goals
- No schema/API change (no worktree field per git entry).
- No author filter, no "files the session touched" filter in the Git view.
- No responsive redesign beyond the horizontal scroller.

- [x] Phase 1 done
