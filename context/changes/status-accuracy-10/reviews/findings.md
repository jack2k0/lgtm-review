# Review findings: status-accuracy-10

reviewers: haiku, sonnet

OpenCode was out of free quota; sonnet is the fallback second reviewer. Two rounds (round 2 on 4b98a5f only); the last round-2 fix (row 9) was made by the orchestrator, not reviewed again.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/check-patterns.ts (splitSegments) | `$((` closed by a lone `)` (command substitution in bash) swallowed later `;`/`&&`/pipe separators: 373/3000 silent edit losses vs main | haiku | sonnet: same root cause found independently | fixed | 4b98a5f, tests "sa10 review F1"; round-2 differential 0 losses |
| 2 | Important | packages/core/src/check-patterns.ts (splitSegments) | command-start `((` closed by `) )` (nested subshell) swallowed the rest; `((cd a && sed ...) )` lost the edit | sonnet | haiku: same root cause | fixed | 4b98a5f, tests "sa10 review F1" |
| 3 | Pre-existing | packages/core/src/check-patterns.ts | `#` after an escaped space read as a comment (silent loss) | haiku | opus: bash runs the later command | fixed | 4b98a5f, test "sa10 review F2" |
| 4 | Pre-existing | packages/core/src/check-patterns.ts | `\<<` read as a heredoc start | haiku | opus: bash reads `\<` then a redirect | fixed | 4b98a5f, plan F3 |
| 5 | Pre-existing | packages/core/src/check-patterns.ts | `( ((` / `{ ((` arithmetic not recognised, a shift becomes a heredoc | haiku | opus: same on main | deferred | round 11 |
| 6 | Nit | packages/core/src/check-patterns.ts (parseHeredocStarts) | `$'...'` delimiter ignores backslash escapes (over-report only) | haiku | opus: same on main | deferred | round 11 |
| 7 | Nit | packages/core/src/check-patterns.ts (splitSegments end) | `if (( x > 1 ))` leaves `if (( x > 1` and a spurious edit target `1` | sonnet | opus: over-report, likely on main | deferred | round 11 |
| 8 | Nit | packages/core/src/shell-edits.test.ts | no test for the `$((` fallback | haiku | opus: row 1 slipped through | fixed | 4b98a5f tests |
| 9 | Important | packages/core/src/check-patterns.ts (scanParenPair) | round 2: backticks skipped in the lookahead but not in splitSegments; `echo $((`echo )` ; sed ...))` lost the edit (branch only) | haiku | opus: test failed before the fix | fixed | backticks no longer skipped; test "sa10 review 2: a backtick" |
| 10 | Pre-existing | packages/core/src/check-patterns.ts (stripHeredocs) | round 2: heredoc scan is per line; a `$((`/`((` spanning a newline with `<<` inside is misread (loses edits) | haiku | sonnet: same, round-2 Nit | deferred | round 11 |
| 11 | Pre-existing | packages/core/src/check-patterns.ts (splitSegments) | round 2: `"$((cmd) ; sed ...)"` inside double quotes misses the edit | haiku | opus: same on main | deferred | round 11 |
| 12 | Nit | packages/core/src/shell-edits.test.ts | round 2: escape parity before `#` not pinned | haiku | opus | fixed | test "sa10 review 2: escape parity before #" |
