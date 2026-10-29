# Review findings: status-accuracy-9

reviewers: haiku, sonnet (opencode out of free quota)

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Pre-existing | packages/core/src/check-patterns.ts (inCommentOrArithmetic) | a `<<` shift inside `$((...))` after a `|` (`echo $((8 / 1<<2))` with a pipe) starts a heredoc; the real body never closes | haiku | opus: fails closed (opaque), same on main | deferred | round 10 |
| 2 | Pre-existing | packages/core/src/check-patterns.ts (parseHeredocStarts) | a `<<` inside a double-quoted argument (`python3 -c "print(1 << 2)"`, `grep "<<EOF" ...`) is read as a heredoc start; silent edit loss only when a later line equals the bogus delimiter | haiku | opus: same on main, needs quote-aware scan | deferred | round 10 |
| 3 | Nit | packages/core/src/shell-edits.ts:13 | `parseHeredocStart` unused after the change | haiku | opus: grep shows no caller | fixed | removed export and import; typecheck green |
