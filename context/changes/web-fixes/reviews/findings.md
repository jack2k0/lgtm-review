# Findings: change/web-fixes

Tier Medium (packages/web/src, core index export). Source: read-only review of packages/web by Agy (9 findings; 5 accepted, 4 rejected with reasons in the verdict table below). Implementer: Agy (Gemini 3.8 Flash). Pre-merge review: Opus, diff-only; every new test fails on the old source (6/6).

reviewers: opus

| # | Tag | file:line | Finding | Reviewer | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|
| 1 | Nit | packages/web/src/viewmodel.ts:435 | `SHELL_EDIT_FILE` copied as a string literal instead of imported from core | opus | fixed (refactor commit) | core index exports it; web already imports values from `@lgtm/core` |

## Source review (Agy) verdicts

| # | Tag | Finding | Verdict | Evidence or reason |
|---|---|---|---|---|
| 1 | Important | PlayView state kept across prompts / Back | rejected | useLive returns loading on key change, Status unmounts PlayView; beats use replaceState |
| 2 | Important | Play keys scroll the page | fixed | test "play keys prevent default when handled" |
| 3 | Important | `(shell edit)` rendered as a diff link | fixed | tests in prompts.dom.test.tsx and steps.test.tsx |
| 4 | Important | no back link on Steps/Map errors | fixed | test "StepsRoute and MapRoute render back to session link on error" |
| 5 | Important | StepsView state kept across prompts | rejected | same remount as 1 |
| 6 | Important | useLive key collision Steps/Play | rejected | state is per hook instance in different components |
| 7 | Nit | setLastListRoute during render | rejected | idempotent, no observable failure |
| 8 | Nit | GitView th without scope | fixed | test "table headers have scope=col" |
| 9 | Nit | whitespace-only prompt shows blank button | fixed | test "whitespace-only prompt button displays (empty prompt)" |
