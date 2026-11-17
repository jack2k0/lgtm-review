reviewers: haiku, opus

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/check-patterns-family.ts:52 | `check:types`/`check:lint` taken as aggregates, hiding a failing test | haiku | opus: confirmed (read) | fixed (7cff432) | exact aggregate names; `check:<x>` takes the family of x | — |
| 2 | Important | packages/core/src/check-patterns.ts:82 | new failure signals hit passing test titles under a masked exit | haiku | opus: confirmed (read) | fixed (7cff432) | anchored to line start; prose rows | — |
| 3 | Important | packages/core/src/check-patterns-evidence.ts:50 | any `&` hid the whole command (`pnpm test & wait`) | haiku | opus: confirmed (read) | fixed (7cff432) | per-segment, `wait` respected | — |
| 4 | Important | packages/core/src/analyze.ts:436 | unobserved check after a pass left `checked` | haiku | opus: confirmed (read) | fixed (7cff432) | treated like an incomplete check → unchecked | — |
| 5 | Pre-existing | packages/core/src/check-patterns-evidence.ts:24 | `grep -q/-l/-L` not count-only | haiku | — | fixed (7cff432) | added with flag clusters | — |
| 6 | Nit | packages/core/src/check-patterns-classify.ts | `go test -list` counted as a check | haiku | — | fixed (7cff432) | `-list` no-op | — |
| 7 | Nit | packages/core/src/analyze.ts:388 | scoped pass superseding a full failure not explained | haiku | — | fixed (7cff432) | reason note "earlier full run failed" | — |
| 8 | Nit | context/foundation/prd.md:114 | "every family" read as all five | haiku | — | fixed (7cff432) | "every family that ran" | — |

Opus read the round-1 diff. Real-log status audit PRE == POST (identical aggregates) before and after round 1. No existing expectation, label or golden changed; PRD wording change owner-approved (decision b).
