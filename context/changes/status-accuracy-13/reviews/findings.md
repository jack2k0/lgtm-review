# Review findings: status-accuracy-13

reviewers: haiku, opus

Owner (2026-10-29): Haiku reviews only; the orchestrator (opus) is the second check: reran Haiku's repros on the fix commit (all give the expected edits), core vitest 2622 passed. Extra commit cb2fedf raises the timeout of the all-fixtures API test to 20s (Haiku: ~2.9 s on main and branch, no slowdown hidden).

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/shell-edits.ts (poisonTempNamesInSegment) | `: ${TMPDIR:=src}; echo > $TMPDIR/a.ts` kept TMPDIR as scratch (silent loss, also on main) | haiku | opus: probe now gives "(shell edit)" | fixed | review fix commit, test |
| 2 | Important | packages/core/src/shell-edits.ts (check redirects) | a check's group redirect to a code file (`{ pnpm check; } > src/out.ts`) was exempt as a log (branch-only loss vs main); plain `pnpm check > src/out.ts` also missed on main | haiku | opus: probes now report src/out.ts; log targets stay non-edits | fixed | review fix commit, tests; differential now includes checks, 0 losses |
| 3 | Nit | packages/core/src/shell-edits.ts | `local T=src` at top level over-reports (bash errors there) | haiku | opus: fail-closed direction | rejected | acceptable over-report |
| 4 | Nit | packages/core/src/shell-edits.ts (KNOWN_SCRATCH_ENV_NAMES) | unassigned `$S` stays scratch by name | haiku | opus: owner decision, `$S` is the agents' scratchpad | rejected | owner decision 2026-10-28 Q1 |
| 5 | Nit | packages/cli/src/api.test.ts:228 | timeout raised to 20s | haiku | opus: timing equal on main | rejected | not hiding a regression |
