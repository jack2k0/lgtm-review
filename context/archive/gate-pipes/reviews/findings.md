# Findings: change/gate-pipes

Tier High (scripts/gate.mjs). Implementer: Grok (grok-4.7, phase 1); fix by Opus. Reviewers: Opus, Haiku (subagent). One round.

reviewers: opus, haiku

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | Important | scripts/gate.mjs:161 | verdict read from the row end: an empty verdict with an unescaped pipe after it read Evidence text as the verdict (fail open) | haiku | opus noted the same as a Nit; haiku probe p1 showed PASS | fixed | long rows are unanswered again (main behaviour), short rows malformed; gate.test.ts "a long row is unanswered, a short row is malformed" (shifted case fails on 03caa8f) |
| 2 | Pre-existing | scripts/gate.mjs:97 | a row whose only pipes are escaped is not seen as a row | haiku | — | deferred | same on main; a ledger made only of such rows already fails with "no findings table rows" |
