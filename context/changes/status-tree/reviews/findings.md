reviewers: haiku, opus

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/analyze.ts:317 | unplaced filter in an agent worktree covered the whole worktree | haiku | opus: confirmed (read) | fixed (f585a60) | worktree branch returns the unplaced scope; test fails on round 0 | — |
| 2 | Important | packages/core/src/check-patterns-tree.ts:34 | reverts missed: `git stash 2>&1`, `-C`, `--no-pager`, `checkout -f`, `switch -f` | haiku | opus: confirmed (read) | fixed (f585a60) | redirections stripped, global options transparent, force = revert-all; tests | — |
| 3 | Important | packages/core/src/analyze.ts:330 | tree state per thread; non-isolated subagents share the main checkout | haiku | opus: confirmed (read) | fixed (f585a60) | one reverted set per prompt, keyed by tree; tests | — |
| 4 | Important | packages/core/src/check-patterns-scope.ts:293 | `--filter '!web'` counted as whole project | haiku | opus: confirmed (read) | fixed (f585a60) | exclusion = unplaced (named selector, within the owner's approval) | — |
| 5 | Important | packages/core/src/analyze.ts:394 | other-tree decided per check; new test passed on main | haiku | opus: confirmed (read) | fixed (f585a60) | per-path decision; test replaced, fails on main | — |
| 6 | Nit | packages/core/src/analyze.ts:799 | failing `git stash pop` left files reverted | haiku | — | fixed (f585a60) | restore ops before the error return | — |
| 7 | Nit | packages/core/src/parse.ts:16 | 4000-char command cut hides part of a revert | haiku | — | fixed (f585a60) | truncated command with a tree op = revert-all | — |
| 8 | Nit | packages/core/src/check-patterns-scope.ts | `--filter @acme/core` flagged its own package (noise) | haiku | — | fixed (f585a60) | name matched to the package directory by string | — |

Second reviewer Fable stalled (no output) and was stopped; Opus read the round-1 diff. Real-log audit PRE == POST (identical aggregates) before and after round 1. Ground-truth FAIL on `scoped-checks.labels.json` #4 and the SC-4 expectation change are owner-approved (2026-11-17).
