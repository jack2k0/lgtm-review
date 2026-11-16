reviewers: opus, haiku

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Pre-existing | scripts/gate.mjs:845 | gate runs `git status` without `--no-optional-locks` | haiku | opus: confirmed (read) | deferred | moved to S-39 gate-coverage plan | — |
| 2 | Nit | packages/core/src/node/git.ts:8 | two adjacent parenthesised clauses in doc comment | haiku | — | rejected | style only | — |
| 3 | Nit | packages/cli/src/map.test.ts | new file name may collide later | haiku | — | rejected | file tests `map.ts`; the name is right | — |

Opus review: diff read, no findings. Haiku verified that the test fails without the flag (index sha changes on git 2.50.1).
