# Web sessions and prompts (S-02) Implementation Plan

## Overview

`lgtm-review` (no flags) starts a local HTTP server for the current repo's Claude Code sessions, prints a URL, and opens the browser. The UI lists sessions and shows, per prompt: status dot, reason, title, approximate active-time split (Read / Write / Check / Fix) with a one-sentence headline, and changed-file counts. Covers US-01 (browser half), FR-001, FR-003, FR-007 and the NFRs: local-only access by the person who started it, no markup rendering of log content, 20 MB session in < 3 s, reproducible output.

Planning ran non-interactively on the orchestrator's delegation; decisions below are assumptions.

## Current State Analysis

- S-01 merged: `@lgtm/core` exports `createAnalyzer`/`analyzeSession`, schemas (`SessionAnalysis`, `PromptAnalysis`, `FileChange`, `Warning`, `Analysis`), `@lgtm/core/node` (`discoverSessions`, `analyzeFile`, `loadRepoScripts`, `projectDirFor`, `defaultProjectsDir`). Core `index.ts` is node-free.
- `lgtm-review` CLI (`packages/cli/src/cli.ts`, `format.ts`) prints text/`--json`; flags `--dir`, `--projects-dir`, `--json`, `--version`, `--help`. tsup bundles core and zod (`noExternal`); package `files` = dist, README, LICENSE. `pnpm check` = typecheck + test + build + smoke (pack tarball, run `--version` through npx).
- `@lgtm/web` is a placeholder (Vite 6 + React 19, one `main.tsx`), private. No tests.
- Prompts have no timing data yet: `PromptAnalysis` has status, reason, files, partial, text. Events carry timestamps (spike: ISO UTC, not monotonic, ~7% decreasing; inherit timestamp when missing).

## Desired End State

- `npx lgtm-review` (in a repo) starts a server on `127.0.0.1:<random port>`, prints `http://127.0.0.1:PORT/#k=<token>` and opens the default browser (skip with `--no-open`; `--port N` optional). `lgtm-review --list` keeps the S-01 terminal output (current default behaviour moves to `--list`; `--json` implies list).
- Web: session list (title, branch, started, prompt count, status counts), click a session -> prompt table: status dot (+ text label, not color only), title, reason, time split bar with phase legend and headline, "N files +A -D", a "may be incomplete" marker and warnings panel.
- Security: server binds loopback only; every `/api/*` request must carry header `X-Lgtm-Token` equal to the per-run random token (32 bytes hex, `crypto.randomBytes`), compared in constant time; `Host` header must be `127.0.0.1:PORT` or `localhost:PORT`; `Origin` if present must equal the server origin; no CORS headers; the token lives only in the URL fragment (never sent to the server, not readable cross-origin) and is read by the SPA, which keeps it in memory; responses carry `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API. Static assets are served without the token (they contain no session data). Log content is rendered only as React text nodes (no `dangerouslySetInnerHTML`, no markdown/HTML rendering); a test greps web sources for it.
- Time split: per prompt `timeSplit {readMs, writeMs, checkMs, fixMs}`, `activeMs`, `headline` (e.g. "Mostly writing (62%), 1 check") computed in core. Approximate and labelled so in the UI ("approx.").
- Performance: analyzing + serving the list for a 20 MB synthetic session < 3 s end to end (test with 6 s ceiling when `CI`).

Verify: `pnpm install --frozen-lockfile && pnpm audit && pnpm check`; smoke test starts the packed CLI and checks auth behaviour over HTTP; orchestrator opens the UI on real local sessions (visual check via browser tooling if available).

## What We're NOT Doing

- No Steps view, raw actions or diffs (S-03). No prompt detail page beyond the table row (expandable row with full reason and file list is allowed, nothing more).
- No LLM titles, no export, no archive, no live watch/refresh (reload the page to re-read).
- No auth beyond the per-run token; no HTTPS; no remote access; no multi-repo picker (repo = `--dir`/cwd).
- No web unit-test framework migration; use vitest (already in repo) with jsdom only if needed for component tests, otherwise test pure view-model functions.
- No UI library / CSS framework: plain CSS in one file, light + dark via `prefers-color-scheme`.
- No changes to the status rule.

## Implementation Approach

Four sequential phases: (1) time split in core, (2) HTTP server + security in cli with a JSON API over the existing analysis, (3) React UI, (4) bundle the built web into the cli package and prove it end to end in the pack smoke test. The SPA is built by Vite with relative asset paths (`base: "./"`), copied into `packages/cli/dist/web/` by a build step, and served by the cli server from that directory.

## Critical Implementation Details

- **Time split**: walk the prompt's turn events in file order; each tool call is classified: Read (Read/Grep/Glob/LS/WebFetch/WebSearch, Bash non-check non-edit), Write (edit tools, Bash edits), Check (check commands), Fix (any Write or Read after a failed check until the next passing check — i.e. work done while the last completed check is failing). Duration of an action = timestamp(tool_result) − timestamp(tool_use) when both exist and the delta is 0..10 min; model "thinking" time between actions is attributed to the NEXT action's phase (gap from previous event timestamp to this action's result), capped at 5 min per gap; any single gap > 5 min is treated as waiting for the user and excluded (NFR). Negative or missing deltas count as 0. Sum per phase; `activeMs` = sum. Deterministic (no clock).
- **Headline**: template from the largest phase share and check count: `"<Mostly writing|reading|checking|fixing> (NN%), K check(s)"`; `"No timing data"` when `activeMs` is 0.
- **Token transport**: SPA reads `location.hash` (`#k=...`), immediately removes it with `history.replaceState`, and sends it as `X-Lgtm-Token`. Server serves `index.html` for `/` and static files only for paths inside `dist/web` (reject `..`, absolute, and symlink escapes via `path.resolve` + prefix check). Unknown `/api/*` -> 404 JSON; API requires token and Host check before anything else (403 JSON `{error}` with no detail).
- **Server lifecycle**: `Ctrl+C` closes; no idle timeout; bind port 0 by default and print the actual URL; if `--port` is busy, exit 1 with message.
- **Caching**: analysis of a session file is cached in memory keyed by `path+mtime+size`; the list endpoint analyzes all sessions on first request (streaming, sequential); `/api/sessions` returns summaries, `/api/sessions/:id` returns the full `SessionAnalysis` (id = file basename without extension, validated against the discovered list, never used as a path).
- **Node-free core** remains: grep rule from S-01 (`packages/core/src` excluding `node`, tests, `testing`).
- **Opening the browser**: `xdg-open`/`open`/`start` via `child_process.spawn` with argv array (no shell), failure ignored; skipped when `--no-open` or when `CI` is set.

## Phase 1: Time split and headline in core

### Overview

Add timing to `PromptAnalysis`.

### Changes Required:

**Files**: `packages/core/src/schema.ts`, `packages/core/src/analyze.ts` (and parse events if timestamps are not yet carried), new `packages/core/src/timing.ts`, tests, fixtures + goldens

**Contract**: `PromptAnalysis` gains `timeSplit {readMs, writeMs, checkMs, fixMs}`, `activeMs`, `headline`. Event model carries `ts` for tool_use and tool_result (inherit last known timestamp when missing). Fixtures get explicit timestamps designed to test: parallel calls, a > 5 min gap excluded, a failed check followed by fix work, non-monotonic timestamp, missing timestamps. Goldens regenerated; the S-01 status-match test still 100%. Reproducibility test (twice identical) retained.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green; new timing unit tests (>= 10 cases) pass
- node-free grep rule returns nothing

#### Manual Verification:

- Reviewer reads two goldens' split numbers against the fixture timestamps

---

## Phase 2: Local server and JSON API with security properties

### Overview

Server in `packages/cli`, pure Node `http`, no framework.

### Changes Required:

**Files**: `packages/cli/src/server.ts`, `packages/cli/src/security.ts`, `packages/cli/src/api.ts`, `packages/cli/src/cli.ts` (flags `--list`, `--no-open`, `--port`), `packages/cli/src/open.ts`, tests `server.test.ts`

**Contract**: as in Desired End State. `startServer({dir, projectsDir, webRoot, port?, token?}): Promise<{url, close()}>`. API: `GET /api/sessions` -> `{dir, sessions: SessionSummary[]}` (id, title, branch, startedAt, promptCount, statusCounts, warningCount), `GET /api/sessions/:id` -> `SessionAnalysis`. Tests (real HTTP on port 0): 403 without token; 403 with wrong token; 403 with bad Host (`evil.example`), 403 with foreign Origin; 200 with right token; CSP and nosniff headers present; path traversal attempts (`/../package.json`, `/%2e%2e/x`, encoded) get 404/403; `:id` not in the discovered list -> 404; no `Access-Control-Allow-Origin` anywhere; server listens only on 127.0.0.1 (assert `address()`).

### Success Criteria:

#### Automated Verification:

- `pnpm check` green incl. server tests
- `lgtm-review --list` output unchanged vs S-01 (e2e test updated to pass `--list`)

#### Manual Verification:

- Reviewer reads `security.ts` once

---

## Phase 3: React UI

### Overview

Sessions list and prompt table.

### Changes Required:

**Files**: `packages/web/src/*` (App, api client, SessionList, PromptTable, TimeBar, StatusDot, styles.css, view-model helpers + tests), `packages/web/vite.config.ts` (`base: "./"`), `packages/web/package.json` (test script with vitest)

**Contract**: as in Desired End State. Status shown as colored dot AND text label; contrast >= 4.5:1 in light and dark; keyboard-navigable rows; empty state ("No sessions found for <dir>"), error state (403: "Open the URL printed by lgtm-review"), loading state. No `dangerouslySetInnerHTML`, no `innerHTML`, no markdown. A unit test scans `packages/web/src` for those strings. Token handling per Critical Implementation Details. Types come from `@lgtm/core` schemas (parse API responses with zod).

### Success Criteria:

#### Automated Verification:

- `pnpm check` green (typecheck, view-model tests, vite build)
- `grep -rnE "dangerouslySetInnerHTML|innerHTML" packages/web/src` returns nothing

#### Manual Verification:

- Reviewer opens the UI on fixtures served by the dev server and confirms layout, dark mode and keyboard use

---

## Phase 4: Bundle web into the CLI and end-to-end smoke

### Overview

One packed tarball starts the UI.

### Changes Required:

**Files**: `packages/cli/package.json` / `tsup.config.ts` / a build script `scripts/copy-web.mjs` (copies `packages/web/dist` to `packages/cli/dist/web`), `turbo.json` (cli build depends on web build), `scripts/smoke-pack.mjs`, README of cli (usage section)

**Contract**: `files` includes `dist/web`. Smoke test additionally: runs the packed CLI via npx with `--no-open --port 0 --projects-dir <tmp> --dir <fixture dir>`, parses the printed URL, fetches `/` (200), `/api/sessions` without token (403) and with token (200, JSON with expected sessions), then kills the process; temp dirs cleaned. Performance test: 20 MB synthetic session through the HTTP API < 3 s (6 s on CI). Tarball content check asserts `package/dist/web/index.html`.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green incl. extended smoke test
- Tarball contains `dist/web/index.html`; no `src/`, no source maps of web unless small (< 1 MB total)

#### Manual Verification:

- Orchestrator runs the CLI on real local sessions and inspects the UI

## Testing Strategy

Unit: timing, view-model helpers, security helpers. Integration: real HTTP server tests; pack + npx smoke including auth behaviour. Manual: visual check on real sessions.

## Performance Considerations

Streaming analysis from S-01 (20 MB in ~0.3 s); API caches by mtime; the list endpoint does not send prompts; UI virtualization not needed at MVP scale (cap rendering at 500 prompts per session with "show more").

## References

- `context/foundation/prd.md` (US-01, FR-001/003/007, NFRs), `context/foundation/roadmap.md` S-02, `context/archive/parser-statuses/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Time split and headline in core

#### Automated

- [x] 1.1 `pnpm check` green with timing tests
- [x] 1.2 node-free grep returns nothing

#### Manual

- [ ] 1.3 Golden split numbers reviewed

### Phase 2: Local server and JSON API

#### Automated

- [x] 2.1 `pnpm check` green incl. security tests — 42a99d5
- [x] 2.2 `--list` output unchanged — 42a99d5

#### Manual

- [ ] 2.3 security.ts reviewed

### Phase 3: React UI

#### Automated

- [x] 3.1 `pnpm check` green
- [x] 3.2 No innerHTML / dangerouslySetInnerHTML in web sources

#### Manual

- [ ] 3.3 UI reviewed on fixtures

### Phase 4: Bundle and end-to-end smoke

#### Automated

- [ ] 4.1 `pnpm check` green incl. extended smoke
- [ ] 4.2 Tarball contains dist/web/index.html

#### Manual

- [ ] 4.3 Real-session UI check

## Plan-review amendments (accepted by orchestrator, 2026-10-23)

- B1 (blocking): static file serving: `decodeURIComponent` in try/catch (URIError -> 400), reject `\0`, then `fs.realpath` the target and require it to start with `realpath(webRoot) + sep`. Add negative tests (`%2e%2e`, `%00`, symlink inside webRoot pointing outside).
- B2 (blocking): token persistence: SPA reads `#k=` once, stores it in `sessionStorage`, then strips the fragment; on load it falls back to `sessionStorage`. F5 therefore keeps working in the same tab; a new tab needs the printed URL.
- B3 (blocking): `Host` validation is the first check for ALL requests (static included); 403 otherwise.
- B4: server has a fixed extension -> Content-Type map (html, js/mjs, css, svg, json, png, ico, woff2, map) with charset for text; unknown extension -> `application/octet-stream`.
- B5: time split: sort/handle non-monotonic timestamps by clamping negative deltas to 0, and per phase merge overlapping intervals (interval union) so parallel tool calls are not double counted; `activeMs` = union of all phase intervals. Add tests for parallel calls and overlaps; fixture split numbers asserted exactly (hand-computed).
- B6: build order enforced in turbo: web build -> cli build (tsup) -> copy web into `dist/web`; tsup `clean` must not remove it (copy runs after tsup, as a cli build step). Smoke test asserts `dist/web/index.html` exists in the tarball.
- B7: CLI prints the URL with `process.stdout.write(url + "\n")`; smoke test waits for the URL with a 15 s timeout and always kills the child process and cleans temp dirs in `finally`.
- B8: Phase 2 is executed as two briefs: 2A = server core (security middleware, static files, content types, tests of the attack matrix, no API); 2B = `/api/sessions*`, CLI flags (`--list`, `--no-open`, `--port`), `open.ts`, caching, tests. Progress checkboxes 2.1/2.2 are ticked after 2B.
- B9: `Origin` rule: if the header is present it must equal exactly `http://127.0.0.1:PORT`; `null` and anything else -> 403. Add a negative test for `Origin: null`.
- B10: printed and opened URL always uses the literal `127.0.0.1`; tests never use `localhost` as the connect address (the `localhost:PORT` Host value is still accepted).
- B11: manual "read the file" items become automated where possible: attack-vector matrix test (Phase 2A), exact split assertions (Phase 1), tarball size assertion < 2 MB in the smoke test (Phase 4).
