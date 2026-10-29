# Review findings: status-accuracy-11

reviewers: haiku, sonnet

OpenCode was out of free quota; sonnet is the fallback second reviewer. Review fixes (b989bea) by Agy; follow-up by the orchestrator (row 3), verified with tests and bash, no second review round (small diff).

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/check-patterns.ts (stripPrefixes) | R3 met only for `if`/`while`/`elif`: PREFIXES stripped the first `(` of a command-start `((`, so `(( x > 1 ))` still gave edit target `1` (over-report) | haiku | opus: reproduced | fixed | b989bea + orchestrator cleanup; tests "sa11 review" |
| 2 | Important | packages/core/src/check-patterns.ts (parseHeredocStarts) | R2: `$'..'` delimiter did not decode `\xHH`, octal, `\u`, `\U`, `\c` (fail closed: opaque) | haiku | opus: same on main for these escapes | fixed | b989bea; tests with `<<E$'\x41'` etc. |
| 3 | Nit | packages/core/src/check-patterns.ts (isArithmeticCommandStart) | `!\b` never matches, so `! (( x > 1 ))` still gave edit target `1`; the `re.source.includes("(")` guard only worked by accident | opus | bash: no file `1` is written | fixed | test "sa11 review: `! (( x > 1 ))` has no redirect target" fails before |
| 4 | Nit | packages/core/src/check-patterns.ts (stripHeredocs) | unclosed `$((` line followed by a far-closed heredoc keeps the body visible (adds false commands only; bash rejects the input) | sonnet | opus: fail closed | rejected | acceptable over-report |
| 5 | Pre-existing | packages/core/src/shell-edits.ts (redirects) | a redirect with a dynamic target or fd prefix (`echo > $x.ts`, `((x)) 2> f.ts`) is not reported although bash writes the file | sonnet | opus: same on main | deferred | round 12 |
| 6 | Nit | scratchpad harness | edit-diff counts `(shell edit)` as a miss | haiku | opus: harness only | rejected | not repo code |
