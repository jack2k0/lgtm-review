# Review findings: api-test-speed

reviewers: haiku, opus

Owner: Haiku reviews; the orchestrator (opus) is the second check (read the api.ts cache change and the test restructure: every assertion kept, cache keyed by the project stamp). Haiku ran a throwaway live-refresh test (append, add, remove, archive switch): fresh data every time; the fixture test now takes ~0.9 s (was ~6.1 s).

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Nit | packages/cli/src/api.ts:209-222 | a request with an older stamp replaces the single cache entry and recomputes (correct, may thrash during writes) | haiku | opus: correctness unaffected | rejected | acceptable for a local single-user server |
| 2 | Pre-existing | packages/cli/src/api.ts:197-203 | the stamp does not cover repo scripts read by loadRepoScripts | haiku | opus: same gap in analysisFor on main | deferred | follow-up if a repo-script edit must refresh statuses live |
| 3 | Nit | packages/cli/src/api.test.ts:211-222 | first failure stops one worker, others finish their item | haiku | opus: failures still fail the test | rejected | same reporting as the serial loop |
