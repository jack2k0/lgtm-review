reviewers: opus, haiku

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/parse.ts:229 | `cutBlocks` sent the 40-char probe and 4000-char slash args through cutForDisplay; args near 3996 chars were dropped | haiku | opus: confirmed (read) | fixed (6d6c9e9) | only RESULT_TEXT_MAX uses cutForDisplay; test `parse.test.ts` fails on the old code | — |
| 2 | Important | packages/core/src/check-patterns.ts:84 | masked tail could start mid-secret (`IOSFODNN7EXAMPLE 2 failed`), suffix not redacted | haiku | opus: confirmed (repro) | fixed (8085ebb) | round-1 fix dropped the whole first line (lost `2 failed`, status change); now drops only the partial token; test fails on the old code; real-log audit PRE == POST (identical aggregates) | — |
| 3 | Important | packages/cli/src/format.ts:23 | format.ts/summary.ts cuts not routed through cutForDisplay | haiku | opus: refuted (read) | rejected | both redact before cutting, so no partial secret reaches the cut | — |
| 4 | Nit | packages/core/src/redact.ts | wordWindow Infinity returns "ab" for "ab " + 300 x | haiku | — | rejected | same as old `oneLine` behaviour | — |

Agy review (inline diff) timed out after 15 min with no output; not counted.
