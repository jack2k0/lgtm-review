# Live refresh (S-10 reduced) Implementation Plan

## Overview

The web UI polls the local API every 5 s while the tab is visible, using conditional requests (ETag / 304), so a running Claude Code session shows up-to-date statuses, steps and diffs without reload. FR-011.

## Current State Analysis

- Server (`packages/cli/src/{server,api,security,http}.ts`): routes `GET /api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/prompts/:index`, `.../diff?path=`; analysis cache keyed by `path+mtime+size`; detail cache (LRU, bytes); all behind token/Host/Origin checks; `Cache-Control: no-store` on API. `sendJson` in `http.ts`.
- Web (`packages/web/src`): `api.ts` fetch + zod parse with token header, `App.tsx` hash routing, views `SessionList`, `PromptTable`, `StepsView`, `DiffView` load data once on mount with loading/error states via a shared `Status`.
- Parser tolerates a truncated last line (warning "truncated last line"); during a live session this warning can appear transiently.

## Desired End State

- API responses of the four routes carry a strong `ETag` derived from the files they depend on: list = hash of all `(sessionId, mtime, size)` in the project dir; session/detail/diff = hash of that session file's `(path, mtime, size)`. `If-None-Match` matching -> `304` with no body, after all security checks (Host/Origin/token) and routing validation; headers keep `no-store`... `Cache-Control: no-cache` is used instead of `no-store` for these four routes so browsers may revalidate; token header requirement unchanged, and no response is cacheable by shared caches (`private`).
- Web: a `useLive` hook (or equivalent) re-fetches the current view's endpoint every 5 s with `If-None-Match`; on 200 replaces data, on 304 does nothing, on errors keeps the old data and shows a small "connection lost, retrying" note with backoff (5 s -> 10 s -> 30 s, reset on success); pauses when `document.visibilityState !== "visible"` and refetches immediately on becoming visible; aborts in-flight requests on route change/unmount. A header indicator shows "Live · updated HH:MM:SS" with a pause/resume toggle (state kept in sessionStorage, default on).
- Updates must not reset UI state: expanded rows, expanded step action lists and scroll position survive a data refresh (keys by prompt index / step n).
- The 20 MB perf tests keep their limits; an idle poll (304) costs a `stat` per session file only (no re-analysis).

## What We're NOT Doing

- No websockets/SSE, no fs watchers, no push notifications, no auto-switching to the newest session, no live diff animations, no persistence of the live preference across tabs beyond sessionStorage, no change to analysis/status rules.

## Implementation Approach

Two phases: (1) server conditional requests with tests; (2) web live polling, UI indicator, state preservation, docs.

## Critical Implementation Details

- ETag value: `"` + first 16 hex of sha256 of the key string + `"`; weak validators not needed. Comparison handles `If-None-Match` lists and `*` (treat `*` as match only when the resource exists) and W/ prefixes.
- 304 responses must still include the security headers (CSP, nosniff, Referrer-Policy, X-Frame-Options) and no `Access-Control-*`.
- Computing the list ETag requires `discoverSessions` + `stat`; reuse the existing discovery; if a file disappears between discover and stat, skip it.
- A session file being appended during analysis: analysis reads a consistent prefix up to EOF at open time; cache key uses `stat` taken before reading, so the next poll (changed mtime/size) re-analyzes.
- Browser `fetch` handles `If-None-Match` itself only with HTTP cache; since the API uses `Cache-Control: no-cache` + token header, the client sends the stored ETag explicitly and treats `304` as "no change" (do not rely on the browser cache).
- Polling loop uses a single timer chain (setTimeout after the previous request finished), never overlapping requests.

## Phase 1: Server conditional requests

**Files**: `packages/cli/src/{api,http}.ts`, tests `api.test.ts`, `server.test.ts`.

**Contract**: as Desired End State. Tests: first request 200 + ETag; same ETag in `If-None-Match` -> 304 empty body; changed file (append a line, bump mtime) -> 200 with new ETag; list ETag changes when a new session file appears; `*` and list forms; 304 still 403 without token and for bad Host/Origin (security checks first); 304 includes security headers; unknown session still 404 (never 304); no `Access-Control-Allow-Origin`; idle 304 does not call analysis (spy/counter or timing assertion).

### Success Criteria

- `pnpm check` green incl. new tests; existing perf tests within limits

## Phase 2: Web live polling

**Files**: `packages/web/src/{api.ts,live.ts(x),App.tsx,SessionList.tsx,PromptTable.tsx,StepsView.tsx,DiffView.tsx,styles.css}` + tests, `packages/cli/README.md` (Live section), `scripts/smoke-pack.mjs` (conditional request check on packed CLI).

**Contract**: as Desired End State. Tests (no DOM library): pure scheduler/backoff function tests (intervals, reset on success, pause on hidden), ETag/304 handling in the api client with a mocked fetch, state-preservation keyed by prompt index/step n via view-model tests, render tests of the indicator (text, aria-live="polite", toggle button label), innerHTML scan covers new files, contrast tests for new styles.

### Success Criteria

- `pnpm check` green incl. smoke (200 -> 304 on the packed CLI)
- Headless-browser check by the orchestrator: append a line to a fixture session file while the UI is open and see the update without reload (screenshot or text assertion)

## Progress

### Phase 1: Server conditional requests

- [ ] 1.1 `pnpm check` green incl. conditional-request tests and perf limits

### Phase 2: Web live polling

- [ ] 2.1 `pnpm check` green incl. smoke 200 -> 304
- [ ] 2.2 Live update observed in a headless browser
