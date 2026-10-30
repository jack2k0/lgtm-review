# Review findings: stamp-scripts

reviewers: haiku, opus

Owner: Haiku reviews; the orchestrator (opus) is the second check: verified the review-fix commit (no diff in packages/core any more, ctime in the fingerprint, one stamp per request; packages/cli 668 tests pass, the same-size/restored-mtime test passes). Agy's proposal to add `ci`/`verify`/`gate` to PKG_SCRIPTS is for the owner (status-rule change, needs a real-log audit).

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/cli/src/api.ts (statFingerprint) | `mtime:size` missed a same-size rewrite with a restored mtime (stale 304, old status) | haiku | opus: test passes after fix | fixed | ctimeMs added; test with fs.utimes |
| 2 | Nit | packages/cli/src/api.ts | repo-script stamp computed several times per request | haiku | opus: diff | fixed | one stamp per root per request, passed down |
| 3 | Nit | packages/cli/src/api.ts:121 | an unreadable script file makes every request a cache miss | haiku | opus: fail closed by design | rejected | correct, only costs time while the permission problem lasts |
| 4 | Nit | packages/core/src/node/discover.ts:202 | `ci`/`verify` added to PKG_SCRIPTS outside the plan, unaudited (changes statuses) | haiku | opus: scope violation | fixed | reverted; kept as an owner proposal |
| 5 | Nit | packages/cli/src/api.test.ts:471 | unreadable-file assertions skipped for uid 0 | haiku | opus | rejected | root cannot make a file unreadable to itself |
