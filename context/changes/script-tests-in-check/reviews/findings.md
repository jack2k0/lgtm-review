# Review findings: script-tests-in-check

reviewers: opencode, opus

Verified locally only: the workflow change has not run on GitHub. A local shallow clone fails `gate.test.mjs` (12 pass, 1 fail) and a full clone passes (19/19). With `removedLines` broken, `pnpm check` exits 1 before `turbo`.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Minor | scripts/gate.test.mjs:151 | `pnpm check` now fails in a shallow local clone, because Case 8 needs commit 21416d7 | opencode | opus: reproduced in a depth-1 clone | deferred | CI is covered by `fetch-depth: 0`; the test file was a non-goal, and changing it is a separate decision |
| 2 | Minor | .github/workflows/ci.yml:36 | The `pnpm lint` step duplicates `eslint .` in `pnpm check` | opencode | opus: read | deferred | harmless, and a non-goal of the plan |
