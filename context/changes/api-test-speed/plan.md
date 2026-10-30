# API Test Speed Optimization Plan

## Cause Analysis and Profiling Numbers

The test `"every fixture prompt validates against PromptDetail and matches the analysis"` in `packages/cli/src/api.test.ts` (lines ~211-228) takes ~5.9s–6.5s locally (average ~6.17s; 6109ms, 5893ms, 6509ms across three baseline runs) and timed out (>5000ms default) on GitHub CI (run 40911943046).

Profiling breakdown:
- 59 fixture sessions, containing 171 prompts in total.
- 59 serial HTTP `GET /api/sessions/:id` requests taking ~2340ms (~39.7ms per request).
- 171 serial HTTP `GET /api/sessions/:id/prompts/:index` requests taking ~3994ms (~23.4ms per request).
- Total serial HTTP round trips: 230 requests taking ~6334ms.
- Client-side CPU time (`PromptDetail.parse`, `SessionAnalysis.parse`, assertion checking): ~50ms total. Over 99% of elapsed time is serial network roundtrips and redundant server computation.
- Server-side inefficiency: `packages/cli/src/api.ts` invokes `allAnalyses(files)` on every `GET /api/sessions/:id` call. Because `allAnalyses` is not cached per project stamp, 59 requests to `/api/sessions/:id` perform 59 separate iterations over all 59 files and run `markInherited(sessions)` 59 times (3,481 session checks).

## Rules and Optimization Strategy

1. **Server Optimization (`packages/cli/src/api.ts`)**:
   Cache `allAnalyses` results keyed by `stamp`:
   - Store `{ stamp: string; result: Promise<SessionAnalysis[]> } | null`.
   - If `stamp === allAnalysesCache.stamp`, return `allAnalysesCache.result`.
   - Since `stamp` is generated from `projectStamp(files)` (which hashes file sizes, mtimes, and subagent stamps), any session addition, deletion, or modification automatically invalidates the cache.
   - This benefits both tests and real end users accessing the server.

2. **Test Concurrency Optimization (`packages/cli/src/api.test.ts`)**:
   - Instead of purely serial `for` loops across all 59 sessions and 171 prompts, use a bounded concurrency worker pool (concurrency limit = 8) to fetch and validate prompts concurrently without socket exhaustion (`read ECONNRESET`).
   - Every single fixture session and prompt is still fetched via HTTP and validated against `PromptDetail` with the exact same assertions (`status === 200`, `cache-control`, `index`, `status`, `activeMs`, and step file matching).
   - Zero test assertions weakened, zero fixtures skipped.

## Gate
```gate
allow: ^packages/cli/src/(api|api\.test)\.ts$
allow: ^context/(changes|archive)/api-test-speed/
deps: no
schema: no
```
