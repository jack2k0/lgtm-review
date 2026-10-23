# Fork/resume dedupe (S-13) Implementation Plan

## Overview

Resumed or forked Claude Code sessions copy the earlier history (same prompt `uuid`s) into a new file. Today both sessions list the same prompts, inflating counts. Mark such prompts as inherited and exclude them from counts and summaries.

## Current State Analysis

- `PromptAnalysis` has `uuid` (prompt record uuid). `SessionAnalysis` has `startedAt`, `prompts`, `warnings`; per-file analysis only (S-01 amendment A2: dedupe by uuid within one file).
- `packages/cli/src/api.ts`: `summarize()` builds `SessionSummary` (`statusCounts`, `promptCount`), analyzes all sessions of a project with a cache; `format.ts` (`sortSessions`, text list), `summary.ts` (markdown), `export.ts`/`export-html.ts`, web `SessionList.tsx` / `PromptTable.tsx`, schemas in `packages/core/src/schema.ts` (`SessionSummary`, `SessionsResponse`, `Analysis`).
- Audit: forks are consistent (identical status for identical prompt), they only duplicate counts.

## Desired End State

- Project-level post-processing function `markInherited(sessions: SessionAnalysis[]): SessionAnalysis[]` in `@lgtm/core` (pure, node-free): orders sessions by `startedAt` ascending (null last, ties by `sessionId`), keeps a map `promptUuid -> firstSessionId`; for each later session, every prompt whose `uuid` is already in the map gets `inheritedFrom: <sessionId>`; prompts with a non-empty uuid only; never marks a prompt inherited from the session itself; deterministic.
- Schema: `PromptAnalysis.inheritedFrom?: string` (optional, absent when not inherited); `SessionSummary.inheritedCount: number` (default 0) and `statusCounts`/`promptCount` computed over NON-inherited prompts only; `SessionSummary.forkOf?: string` (the most frequent `inheritedFrom` session id, ties by earliest).
- Consumers: the API list/detail routes, `--list`, `--json`, `--summary`, `--export` apply `markInherited` over all sessions of the project before rendering; single-session views still show inherited prompts, collapsed by default in the web table ("N inherited prompts from <id8>", expandable), listed with a marker in text output ("(inherited from abcd1234)"), excluded from the markdown summary's table and counts with one line "N prompts inherited from <id8> omitted", excluded from HTML export except a note. `--export`/`--summary` of a session whose id matches only inherited prompts still works (shows note).
- ETag/cache: because inheritance depends on other sessions, the list ETag already hashes all session files; the single-session ETag must also include the stamps of all sessions of the project that start before it (or simply the list stamp); use the project-level stamp for `/api/sessions/:id` and prompt routes.
- Live refresh keeps working (304 when nothing changed).

## What We're NOT Doing

- No merging of fork chains into one timeline, no deletion of inherited prompts from `--json` (they are present with `inheritedFrom`), no attempt to detect forks by anything other than prompt uuid equality, no change to the status rule, no change to per-file parsing.

## Implementation Approach

Two phases: (1) core `markInherited`, schemas, summary computation, with unit tests and synthetic fixtures (resume copy of 3 prompts + 2 new; fork chain A -> B -> C; unrelated sessions; sessions with equal startedAt; null startedAt); (2) consumers (API, CLI text/summary/export, web) with tests, smoke, docs.

## Critical Implementation Details

- Ordering: if two sessions share prompts, the earlier `startedAt` owns them; when startedAt is equal or missing, the lexicographically smaller `sessionId` owns them.
- `summarize()` receives the processed sessions; `promptCount` = number of non-inherited prompts; `inheritedCount` separate.
- Web: inherited rows render in a collapsed group with `aria-expanded`; text only (innerHTML scan test must cover new code); contrast tests for new styles.
- Node-free grep rule for core unchanged.
- Goldens: existing analysis goldens unchanged (the field is optional and absent); summary goldens change only for fixtures with inherited prompts (new fixtures).

## Phase 1: Core

**Files**: `packages/core/src/{schema.ts,inherit.ts,index.ts}`, tests, fixtures `fork-resume-a`, `fork-resume-b` (copies with same uuids), chain fixtures, goldens.

### Success Criteria

- `pnpm check` green; node-free grep empty; determinism test (shuffled input order => identical output)

## Phase 2: Consumers

**Files**: `packages/cli/src/{api.ts,format.ts,summary.ts,export.ts,export-html.ts,cli.ts}`, `packages/web/src/{SessionList.tsx,PromptTable.tsx,viewmodel.ts,styles.css}`, tests (api, e2e, summary goldens, web view-model + render), `scripts/smoke-pack.mjs` (packed CLI lists two forked fixture sessions, asserts counts not doubled), `packages/cli/README.md` section.

### Success Criteria

- `pnpm check` green incl. smoke; ETag 200 -> 304 still holds; list counts on the fork fixtures not doubled

## Progress

### Phase 1: Core

- [x] 1.1 `pnpm check` green, node-free grep empty, determinism

### Phase 2: Consumers

- [ ] 2.1 `pnpm check` green incl. smoke

## Plan-review amendments (accepted by orchestrator, 2026-10-23)

- I1: `forkOf` tie-break uses the ownership comparator (earliest `startedAt`, then smallest `sessionId`).
- I2: single-session and prompt-route ETags use the project-level stamp (all session files' versions + subagent stamps) plus the id; test: a sibling file change flips the ETag.
- I3: `summarize()` itself filters inherited prompts (`statusCounts`, `promptCount`) and computes `inheritedCount`; correctness must not depend on call-site pre-filtering.
- I4: schema additions (`PromptAnalysis.inheritedFrom?`, `SessionSummary.inheritedCount` default 0, `SessionSummary.forkOf?`) land in Phase 1 before any consumer.
- I5: web session header counts non-inherited prompts and shows "+ N inherited".
- I6: chain fixtures include `startedAt(B) == startedAt(C)` and null `startedAt`; the determinism test shuffles input order; ownership sorting is done once up front and the "from itself" guard compares against that order.
- I7: Phase 2 is split into 2A (API/CLI/export/summary/ETag/smoke) and 2B (web); checkboxes 2.1 (2A) and 2.2 (2B).
- I8: all prompts inherited: `--summary` prints the heading plus exactly `All N prompts inherited from <id8>. No prompts to review.`, exit 0; `--export` HTML shows that note in the session card; `--json` unchanged (prompts present with `inheritedFrom`).
