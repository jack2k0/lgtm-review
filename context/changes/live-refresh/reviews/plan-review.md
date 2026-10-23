# Plan review (OpenCode via herdr, 2026-10-23)

# Plan Review: Live Refresh (S-10 reduced) Implementation Plan

**File reviewed:** `/home/jack/git/lgtm-review/context/changes/live-refresh/plan.md`
**FR-011:** Web UI polls local API every 5s while tab visible, using conditional requests (ETag/304), so a running Claude Code session shows up-to-date statuses, steps and diffs without reload.

## Findings (8 max)

### 1. BLOCKING: ETag computation order relative to security checks
- **Location:** Server API routes (`packages/cli/src/api,/http.ts`), the four routes `GET /api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/prompts/:index`, `.../diff?path=`
- **Detail:** The contract states "304 with no body, after all security checks (Host/Origin/token) and routing validation." However, if the implementation computes the ETag from session/file hashes *before* validating security, an attacker could learn ETag values for sessions they shouldn't access via timing or error-side-channel analysis. Security checks must short-circuit *before* any ETag computation.
- **Fix:** Reorder middleware in all four routes to validate token, Host, and Origin first. Return 403 immediately on failure without computing or returning an ETag. The ETag should only be computed and included after security passes.

### 2. WARNING: Polling race — in-flight fetch requests not aborted on unmount/route change
- **Location:** Web `useLive` hook (`packages/web/src/live.ts` or equivalent)
- **Detail:** The plan mentions "a single timer chain (setTimeout after the previous request finished), never overlapping requests" but does not address aborting in-flight `fetch` requests when the user navigates away, the component unmounts, or the route changes. If a poll request is in-flight and the component unmounts, the callback could fire on an unmounted component, causing stale state updates or memory leaks.
- **Fix:** Implement an `AbortController` per poll cycle stored in a `ref`, and call `abort()` on route change or component unmount. Clean up the timer clear in the unmount effect. Ensure the fetch uses the AbortSignal.

### 3. WARNING: Truncated last line warning can flicker during live refresh
- **Location:** Parser + live refresh polling cycle
- **Detail:** The plan acknowledges "Parser tolerates a truncated last line (warning 'truncated last line'); during a live session this warning can appear transiently." When polling every 5s, if a session file's last line gets truncated during write, the warning may flicker on/off between polls, causing UI noise. The plan does not address how to suppress or debounce this in live mode.
- **Fix:** Add a live-mode flag or debounce logic: only show the "truncated last line" warning after it's detected consecutively (e.g., 2 out of 3 polls), or suppress it entirely during live refresh since the user expects transient state. Alternatively, ensure the parser's consistent prefix reading (already reading up to EOF at open time) prevents the warning from triggering on every poll.

### 4. WARNING: State preservation key strategy not fully specified
- **Location:** View models (`packages/web/src/StepsView.tsx`, `PromptTable.tsx`, `SessionList.tsx`)
- **Detail:** The plan states "Updates must not reset UI state: expanded rows, expanded step action lists and scroll position survive a data refresh (keys by prompt index / step n)." However, the specific key strategy (what constitutes the key, how it maps across re-fetches) isn't detailed. If prompt indices shift or the data structure changes after a 304, state could still reset unexpectedly.
- **Fix:** Document and test the exact key strategy. Prefer using stable session-internal IDs over array indices. Implement a state-preservation middleware or view-model pattern that captures/restores expanded/scroll state using stable identifiers, and add unit tests that simulate a 304 response and verify state is preserved.

### 5. OBSERVATION: Cache-Control header may not fully prevent shared-cache storage
- **Location:** Server response headers (`packages/cli/src/http.ts`), the four API routes
- **Detail:** The plan changes `Cache-Control: no-store` to `Cache-Control: no-cache` for the four routes "so browsers may revalidate" and notes "no response is cacheable by shared caches (`private`)." However, `no-cache` alone does not prevent shared caches (proxies) from caching responses; it only mandates revalidation on each use. To truly prevent shared-cache caching, the header must include `private` (e.g., `Cache-Control: no-cache, private`). The plan mentions `private` but needs verification that it's actually included in the response headers.
- **Fix:** Verify the actual `Cache-Control` header value sent for the four routes. Ensure it is `no-cache, private` (or `no-store` if shared-cache prevention is required). Add `private` explicitly if missing.

### 6. OBSERVATION: ETag `*` and W/ prefix handling edge cases not tested
- **Location:** Server 304 logic (`packages/cli/src/api,/http.ts`)
- **Detail:** The contract says the ETag comparison handles `If-None-Match` lists, `*` (treat `*` as match only when the resource exists), and `W/` prefixes. The ETag value format is `"` + first 16 hex of sha256 + `"` (a strong validator). However, edge cases exist: what if a proxy midway upgrades the ETag to weak? What if the client sends `W/"<hash>"`? The plan doesn't address whether the server ever responds with `ETag: *` or how `W/` from the client is normalized.
- **Fix:** Add integration tests for all `If-None-Match` variants: client sends `*`, client sends specific strong ETag, client sends `W/"<hash>"`, client sends a list of tags. Verify 304 is returned only when the resource exists and tags match; 200 with new ETag when they don't.

### 7. WARNING: Frequent stat() calls under the 304 path may impact perf on large projects
- **Location:** Server `discoverSessions` + `stat` (`packages/cli/src/server,api`)
- **Detail:** The plan says "an idle poll (304) costs a `stat` per session file only (no re-analysis)." This is correct — a 304 avoids the expensive analysis step. However, each 304 poll still requires `stat()` on all session files to compute the ETag hash. If a project has many session files (e.g., 100+), the cumulative `stat()` calls across the 5s polling interval could add latency, especially on filesystems with high stat latency (network mounts, CIFS). The 20 MB perf tests may not exercise this scenario.
- **Fix:** Profile `stat()` calls under load with many session files. Consider caching mtime/size per file across polls and only re-stat when the file's mtime changes (using mtime nanoseconds or ctime comparison). Or compute a delta ETag that only hashes changed files.

### 8. OBSERVATION: No explicit test for UI state preservation after 304 in Phase 2 criteria
- **Location:** Web live polling tests + Phase 2 success criteria
- **Detail:** Phase 2 success criteria include "Headless-browser check by the orchestrator: append a line to a fixture session file while the UI is open and see the update without reload." However, this checks for visual updates only; there is no explicit test for verifying that UI state (expanded rows, scroll position) is preserved after a 304 response. The orchestrator smoke test may pass without confirming state preservation.
- **Fix:** Add a unit/test that simulates a 304 response and verifies the view-model state (expanded indices, scroll offsets) is preserved. Add an integration test in a headless browser that: (1) expands a row, (2) triggers a live poll that returns 304, (3) verifies the row remains expanded and scroll position is maintained.

---
**Summary:** The plan is largely well-structured and addresses FR-011 comprehensively. The eight findings above highlight one blocking security concern, three warnings (polling races, transient UI warnings, state preservation fragility), and four observations (cache-header correctness, edge-case ETag handling, perf scaling, test gaps). Addressing these before Phase 1 ship will reduce regression risk and ensure the live refresh feature is both secure and polished.