# Findings: change/review-process

Tier High (scripts/gate.mjs, AGENTS.md, REVIEW.md, CLAUDE.md). Implementer: Opus. Round 1 on be99418 (Sonnet) and 459558a (Agy); cross-verification both ways. One round.

reviewers: sonnet, agy

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Important | scripts/gate.mjs:84 | A table without a Verdict column, without outer pipes, or a row before the header gave 0 rows and passed | sonnet | agy: confirmed | fixed (459558a) | gate.test.ts "ledgers fail closed" | — |
| 2 | Important | scripts/gate.mjs:83 | Escaped pipe `\|` in a cell shifted columns onto a verdict | sonnet | agy: confirmed | fixed (459558a) | same test, escaped-pipe case | — |
| 3 | Nit | scripts/gate.mjs:85 | `fixed?` and `fixed-not` counted as fixed | sonnet | — | fixed (459558a) | same test, loose verdicts | — |
| 4 | Nit | scripts/gate.mjs:78 | Placeholder reviewers like `<a>` counted | sonnet | — | fixed (459558a) | same test, placeholders | — |
| 5 | Nit | REVIEW.md:24 | High row omitted `node/subagents` from TIERS | sonnet | — | fixed (459558a) | REVIEW.md tier row | — |
| 6 | Important | scripts/gate.mjs:90 | A row after a blank line inside a table was taken as a header and dropped | agy | sonnet: confirmed | fixed | header must be followed by a separator; test case "after a blank line" | — |
| 7 | Important | scripts/gate.mjs:91 | Unescaped pipe in a code span shifted columns onto a verdict | agy | sonnet: confirmed (GFM splits there too) | fixed | row cell count must equal header; test case | — |
| 8 | Important | scripts/gate.mjs:90 | A non-Verdict table elsewhere in the ledger counts as unanswered rows | agy | sonnet: confirmed, by design | rejected | fail-closed by design (finding 1); documented in REVIEW.md Ledger | — |
| 9 | Important | scripts/gate.mjs:80 | Bullet-list findings give 0 rows and pass | agy | sonnet: confirmed, format gap | fixed | empty ledger must say `findings: none`; test case | — |
| 10 | Nit | scripts/gate.mjs:95 | `**fixed**` or backticked verdicts failed | agy | — | fixed | markdown emphasis stripped; test case | — |
| 11 | Nit | scripts/gate.mjs:83 | `@handle` reviewers not counted | agy | — | fixed | leading @ stripped; test case | — |
