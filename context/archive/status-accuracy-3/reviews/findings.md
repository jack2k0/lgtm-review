# Findings: change/status-accuracy-3

Tier High (status rule). Implementer: Sonnet (tool), Sonnet (truth script, separate agent). Plan review: Agy (8 points, 7 accepted, see plan-review.md and plan amendments). Pre-merge review: Agy + Haiku, cross-verified both ways. Two rounds.

reviewers: agy, haiku

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/check-patterns.ts | `flock -c CMD LOCK` treated as running LOCK | agy | haiku: refuted (invalid flock syntax, exit 64) | rejected | util-linux flock takes -c after the lock file |
| 2 | Important | packages/core/src/check-patterns.ts | `--command=CMD` not unwrapped | agy | haiku: refuted (flock rejects it) | rejected | invalid syntax |
| 3 | Important | packages/core/src/shell-edits.ts | non-literal open() mode drops the write | agy | haiku: confirmed (pre-existing) | fixed (77b753d) | test "A3 non-literal mode" |
| 4 | Important | packages/core/src/shell-edits.ts | qualified receiver resolves to an unrelated variable | agy | haiku: confirmed (regression) | fixed (77b753d) | tests "A4 qualified/chained receiver" |
| 5 | Important | packages/core/src/shell-edits.ts | apostrophe in a Python comment drops the write | agy | haiku: confirmed (pre-existing) | fixed (77b753d) | tests "A5 …" |
| 6 | Important | packages/core/src/shell-edits.ts | heredoc through a multi-stage pipe dropped | agy | haiku: confirmed (regression) | fixed (77b753d) | tests "A6 …" |
| 7 | Important | packages/core/src/shell-edits.ts | indented binding overrides a real target | agy | haiku: confirmed (regression) | fixed (77b753d) | test "A7 indented rebinding" |
| 8 | Important | packages/core/src/shell-edits.ts | prefix assignment leaks to later segments | agy | haiku: confirmed (regression) | fixed (77b753d) | tests "A8 …" |
| 9 | Important | packages/core/src/analyze.ts | unrecognised code write next to a doc edit attributed to git | haiku | agy: confirmed | fixed (77b753d, 3566eb2) | `opaque` fallback; tests "H1 …"; safe list widened after the real-log audit |
| 10 | Important | packages/core/src/shell-edits.ts | FILES_MAX cap drops plain targets | haiku | agy: confirmed | fixed (77b753d) | test "H2 …" |
| 11 | Pre-existing | packages/core/src/analyze.ts | git op + unrecognised write wholly git (main too) | haiku | — | deferred | changes main's gitOnly rule; owner question 3 / next slice |
| 12 | Nit | packages/core/src/analyze.ts | cd suffix match over-attributes to plain | haiku | — | rejected | errs conservative |
| 13 | Nit | packages/core/src/analyze.ts | misplaced JSDoc | haiku | — | fixed (77b753d) | — |
| 14 | Important | packages/core/src/shell-edits.ts | `sort -o` / `uniq in out` counted non-writing | agy, haiku | both found it | fixed (6f731ab) | tests "opaque: sort …" |
| 15 | Important | packages/core/src/shell-edits.ts | `git diff/show --output=` counted non-writing | haiku | — | fixed (6f731ab) | tests "opaque: git … --output" |
| 16 | Important | packages/core/src/shell-edits.ts | sed `W`/`e` commands counted read-only | agy, haiku | both found it | fixed (6f731ab) | tests "opaque: sed …" |
| 17 | Important | packages/core/src/shell-edits.ts | `>& file` not parsed as a write redirect | agy | — | fixed (6f731ab) | tests "opaque: >& …" |
| 18 | Nit | packages/core/src/shell-edits.ts | stderr redirect to an unknown target ignored | agy | — | fixed (6f731ab) | tests "opaque: 2> …" |
| 19 | Nit | packages/core/src/shell-edits.ts | herdr and `git worktree add` in the safe list | haiku | — | deferred | owner note; not seen writing repo files |
