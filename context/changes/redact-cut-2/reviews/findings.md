reviewers: grok-orchestrator, grok-review

findings: none

A command longer than 4000 characters is cut with `cutForDisplay` and padded with spaces back to 4000 so `runTreeOps` still treats it as truncated. The existing analyze test "a cut command with a revert reverts everything" passes without an expectation change. Core suite 3357 passed. CLI `redact-cut.test.ts`, `summary.test.ts` and `format.test.ts` passed (109).
