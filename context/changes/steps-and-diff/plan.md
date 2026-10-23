# Steps and diff (S-03) Implementation Plan

## Overview

From a prompt row in the browser, open its Steps view: ordered steps (phase Read / Write / Check / Fix, check command + exit result, agent quotes), expand any step to its raw action list, and click a changed file to see a unified diff labelled "agent edits, not final git state". Covers US-02, FR-005, FR-006, FR-007 and closes the MVP (S-01..S-03).

Planning ran non-interactively on the orchestrator's delegation; decisions are assumptions.

## Current State Analysis

- Core (`packages/core/src`): `parse.ts` normalises records to events (`prompt`, `tool_use`, `tool_result`, boundaries) with timestamps; `analyze.ts` (`createAnalyzer`, `analyzeSession`) computes status, files, timing; `timing.ts` classifies tool calls into Read/Write/Check/Fix (Fix = Read/Write started while the last completed check failed); `check-patterns.ts` classifies commands. Parser deliberately keeps only reduced inputs (`command`, `filePath`, `contentLines`) and counts for patches, so diff text and agent text are NOT retained yet.
- `@lgtm/core/node` has `analyzeFile` (streaming). CLI server (`packages/cli/src/{server,api,security,http}.ts`): `GET /api/sessions`, `GET /api/sessions/:id`, token/Host/Origin checks, caching by `path+mtime+size`. Web (`packages/web/src`): `App.tsx` hash routing (`#/session/<id>`), `SessionList`, `PromptTable` (expandable rows), strict text-only rendering (a test forbids `innerHTML`), contrast tests on `styles.css`.
- Log facts (archive `parser-statuses/spike-log-format.md`): Edit result carries `toolUseResult.structuredPatch[{oldStart,oldLines,newStart,newLines,lines}]`; Write create has `content`; Bash edits have `bashEditDiff.files[].hunks`; large fields (`originalFile`, `content`) can be hundreds of KB; agent text is `type:"assistant"` records with `text` blocks.

## Desired End State

- `GET /api/sessions/:id/prompts/:index` -> `PromptDetail`: `{index, steps: Step[]}`; `Step {n, phase, title, startedAt|null, durationMs, check?: {command, exitCode|null, passed|null, excerpt}, quotes: string[], actions: Action[], files: string[]}`; `Action {tool, summary, ok, ts|null}` (summary = file path / command truncated to 200 chars / pattern; never full file content). Steps are mechanical: consecutive actions of the same phase = one step; a check is always its own step; quotes = agent `text` blocks preceding the step's first action (each truncated to 400 chars, max 3 per step).
- `GET /api/sessions/:id/prompts/:index/diff?path=<file path>` -> `FileDiff {path, kind, truncated, maybeIncomplete, hunks: Hunk[]}`, `Hunk {header, lines: {t: "+"|"-"|" ", s: string}[]}`; hunks come from the log: `structuredPatch` for Edit/MultiEdit, synthetic all-`+` hunk for Write create, `bashEditDiff` hunks for shell edits; multiple edits to the same file within a prompt are listed in order as consecutive hunks. `path` must be one of the prompt's `files` (exact match, never used as a filesystem path; the server never reads repo files). Each diff is capped at 2000 lines (`truncated: true`), each line at 2000 chars.
- Web: prompt row gets "Steps" (link `#/session/<id>/prompt/<index>`): vertical list of steps with phase badge (text + color), title, duration, check result (command, "exit 1", excerpt), quotes (quoted block), "N actions" disclosure expanding the raw action list, file chips; clicking a file opens the diff view `#/session/<id>/prompt/<index>/diff?path=...` with banner "agent edits, not final git state" and, when `maybeIncomplete`, "may be incomplete (shell edits, removals and moves may be missing)". Unified diff rendered as text nodes only, +/- by CSS class and prefix character (not color only).
- Detail data is computed on demand: the list endpoint and `SessionAnalysis` stay unchanged and small. Detail analysis of one session runs the analyzer in `detail` mode (keeps steps/diffs), cached (LRU of 3 sessions) by `path+mtime+size`.
- NFRs: opening a 20 MB session's detail < 3 s; memory bounded by the caps; no markup interpretation; local-only protections unchanged (all new routes behind token/Host/Origin).

Verify: `pnpm install --frozen-lockfile && pnpm audit && pnpm check`; extended pack smoke hits the detail endpoints with and without token; the orchestrator opens a real local session in a headless browser.

## What We're NOT Doing

- No split diff, no syntax highlighting, no reading the repo's files or git (diffs are only what the log recorded), no "final git state" reconciliation, no export/share, no live refresh, no subagent transcript merging, no LLM-written step titles or captions (titles are templates, e.g. "Read 3 files", "Edit src/a.ts (+2 -1)", "Run pnpm test -> passed").
- No change to the status rule, the time model, or the list/summary contracts.
- No new runtime dependencies.

## Implementation Approach

Five phases: (1) core steps, (2) core diffs, (3) server detail API, (4) web Steps view, (5) web diff view + pack smoke/perf. Detail is opt-in (`createAnalyzer({detail: true})`) so the default analysis path and its goldens do not change.

## Critical Implementation Details

- **Detail mode retention**: parser keeps, when `detail` is on, for edit tool results the `structuredPatch` lines (truncate per the caps while parsing, not after), for Write create the first 2000 lines of content, for `bashEditDiff` hunks likewise; for assistant `text` blocks the first 400 chars; summaries of actions. Anything else stays dropped. `originalFile` is never kept. Total retained per prompt is bounded (e.g. 200 steps shown, "show more" semantic via `truncated` flag on the prompt detail if exceeded; at most 5000 actions per prompt).
- **Step grouping**: reuse the timing classifier (single source of truth for phase), so step phases agree with the time split. Unclassified tools (Agent, TodoWrite, MCP...) become actions inside the surrounding step with phase of the previous step ("Read" if none) and `summary` naming the tool; an `Agent` call adds `partial` note to the step title.
- **Check result**: exit code from `Exit code N` text, passed when no `is_error`; `excerpt` = first non-empty failing line(s), max 200 chars; checks without result: `exitCode: null, passed: null`.
- **Path param safety**: `path` query parameter is matched against the prompt's file list; unknown -> 404; decoded once; never joined to a filesystem path. Prompt `index` must be an integer within range.
- **Text-only UI**: diff and quote text rendered via React text nodes inside `<pre>`/`<blockquote>`; existing `innerHTML` scan test must keep passing and also cover new files.
- **Node-free core**: grep rule unchanged.

## Phase 1: Core steps and raw actions

### Changes Required:

**Files**: `packages/core/src/schema.ts` (`Step`, `Action`, `PromptDetail`), `packages/core/src/steps.ts` (new), `parse.ts` / `analyze.ts` (detail mode: `createAnalyzer({detail: true})` and `finish()` exposing `details(): PromptDetail[]`), tests, synthetic fixtures extended with a `steps-*.jsonl` (agent text blocks, parallel reads, failing check then fix, Agent call) + goldens `*.steps.json`

**Contract**: as Desired End State; default (non-detail) output byte-identical to current goldens. Grouping tests (>= 12 cases), caps tests, determinism test.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green; existing goldens unchanged; new step goldens deterministic
- node-free grep rule returns nothing

#### Manual Verification:

- Reviewer reads two step goldens against the fixtures

---

## Phase 2: Core diffs

### Changes Required:

**Files**: `packages/core/src/diff.ts` (new), schema (`FileDiff`, `Hunk`), analyzer detail mode (`diffFor(promptIndex, path)`), tests and fixtures with multi-edit file, Write create, bash edit, truncation, shell-edit `maybeIncomplete`

**Contract**: as Desired End State. Hunk header format `@@ -a,b +c,d @@`. Caps enforced at parse time (2000 lines/diff, 2000 chars/line) with `truncated`.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green; golden diffs for fixtures; truncation tests pass; node-free grep empty

#### Manual Verification:

- Reviewer reads one golden diff

---

## Phase 3: Server detail API

### Changes Required:

**Files**: `packages/cli/src/api.ts` (routes), `packages/core/src/node` (`analyzeFile` option `detail`), tests `api.test.ts`, extend `server.test.ts` attack matrix to the new routes

**Contract**: routes as Desired End State; LRU(3) detail cache keyed `path+mtime+size`; 404 for unknown session/index/path; 403 without token/Host/Origin as before; `path` param validated by exact match; responses validated against the zod schemas in tests; `Cache-Control: no-store`.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green; new routes covered by negative tests (no token, bad index `-1`, `1e3`, `NaN`, path not in list, traversal strings in `path`)
- Perf test: 20 MB synthetic session detail endpoint < 3 s (6 s on CI), logged

#### Manual Verification:

- none

---

## Phase 4: Web Steps view

### Changes Required:

**Files**: `packages/web/src/{App.tsx,StepsView.tsx,StepCard.tsx,api.ts,viewmodel.ts,styles.css}` + tests

**Contract**: as Desired End State (Steps part): route `#/session/<id>/prompt/<index>`, back navigation, loading/empty/error states, keyboard accessible disclosure (`button aria-expanded`), phase badge text + color, contrast tests extended to new styles, view-model unit tests (formatting durations, step titles fallbacks). Prompt row in `PromptTable` links to Steps.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green; `innerHTML` scan passes on new files; contrast tests pass

#### Manual Verification:

- Reviewer opens Steps on fixtures in a headless browser (screenshot) in light and dark

---

## Phase 5: Web diff view and end-to-end

### Changes Required:

**Files**: `packages/web/src/{DiffView.tsx,...}`, `scripts/smoke-pack.mjs` (+ detail endpoints with/without token), docs: `packages/cli/README.md` (Steps/Diff section, limits), root README (status of MVP)

**Contract**: file chips in steps and in the prompt row open the diff; unified diff lines with `+`/`-`/` ` prefix chars and background classes; banner and incomplete notice; truncated notice; long lines scroll horizontally inside `<pre>`; keyboard back navigation. Smoke: packed CLI serves detail routes: 403 without token, 200 with token for one fixture prompt, `path` outside list -> 404.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green incl. extended smoke; tarball < 2 MB

#### Manual Verification:

- Orchestrator opens a real local session via the packed CLI in a headless browser, goes prompt -> steps -> diff (screenshots), no console errors

## Testing Strategy

Core: golden steps/diffs from synthetic fixtures. Server: real HTTP tests incl. negative matrix. Web: view-model + static scans + headless-browser review. Pack smoke covers the shipped artifact.

## Performance Considerations

Detail analysis on demand only; caps on retained text; LRU cache of 3 sessions.

## References

- `context/foundation/prd.md` (US-02, FR-005..007), `context/archive/web-sessions-prompts/plan.md`, `context/archive/parser-statuses/spike-log-format.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done.

### Phase 1: Core steps and raw actions

#### Automated

- [x] 1.1 `pnpm check` green; existing goldens unchanged
- [x] 1.2 node-free grep empty

#### Manual

- [ ] 1.3 Step goldens reviewed

### Phase 2: Core diffs

#### Automated

- [x] 2.1 `pnpm check` green; golden diffs and truncation tests
- [x] 2.2 node-free grep empty

#### Manual

- [ ] 2.3 Golden diff reviewed

### Phase 3: Server detail API

#### Automated

- [x] 3.1 `pnpm check` green incl. negative tests on new routes
- [x] 3.2 Detail perf test 20 MB under limit

### Phase 4: Web Steps view

#### Automated

- [x] 4.1 `pnpm check` green; innerHTML scan and contrast tests pass

#### Manual

- [ ] 4.2 Steps view reviewed in headless browser

### Phase 5: Web diff view and end-to-end

#### Automated

- [ ] 5.1 `pnpm check` green incl. extended smoke
- [ ] 5.2 Tarball < 2 MB

#### Manual

- [ ] 5.3 Real-session walk-through prompt -> steps -> diff

## Plan-review amendments (accepted by orchestrator, 2026-10-23)

- C1: one shared phase classifier (extract from `timing.ts` into a function used by both `timing.ts` and `steps.ts`); step titles for merged runs list the mix (e.g. "Fix: read 2 files, edit src/a.ts (+2 -1)"); test that per-step phases agree with the time-split classification on all fixtures.
- C2: detail cache is bounded by an estimated byte size (50 MB total, evict LRU), and diffs are materialised lazily per `(promptIndex, path)` request from compact retained patch data; steps are retained slim.
- C3: `path` query: decode in try/catch -> 400 on bad encoding; normalise `\` to `/` before matching; same for `index` parsing (integer only, else 400/404).
- C4: `PromptDetail` also carries `text` (200 chars), `status`, `reason`, `headline`, `startedAt`, `activeMs`, `truncated: boolean`; the Steps view needs no other request and deep links work after F5. StepsView shows a banner when `truncated`.
- C5: check exit code comes from structured data first (`toolUseResult` string prefix `Error: Exit code N` / `is_error`), the text regex only as fallback; add a test where output text contains "Exit code 0" while `is_error` is true.
- C6: (see C4) truncated flag in schema.
- C7: Phase 5 split: 5a = `DiffView` + tests + styles; 5b = extended smoke, docs, final walk-through. Checkboxes 5.1/5.2 are ticked after 5b.
- C8: Phase 3 adds a memory regression test: heapUsed delta < 150 MB after detail analysis of the 20 MB synthetic session plus 3 diff requests.
- C9: `FileDiff.kind` reuses `"M" | "A" | "D"` from `FileChange`; emptied file => `M` with an all-`-` hunk; shell removals => `D` with `maybeIncomplete: true` and `hunks: []` when no content is known.
