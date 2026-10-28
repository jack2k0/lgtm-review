# Findings: change/llm-titles

Tier High (schema, cli server, network path). Implementer: Grok (grok-4.7). Reviewers: Sonnet (subagent), OpenCode (GLM-5.3-Flash), in parallel; overlapping finding confirmed by both; every Important finding came with a reproduction on the built CLI. Rounds: 2 (round 2 diff-only, same reviewers: opencode no findings; sonnet 1 Nit + 1 Pre-existing).

reviewers: sonnet, opencode

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Important | packages/cli/src/llm.ts:655 | a stamp change drops ready titles from view() until the queue re-reads the cache; titles flash away on every live refresh | sonnet | opencode #2: confirmed (probe B: titles {} after utimes) | fixed | llm.test.ts "stamp change keeps ready titles for an unchanged key" |
| 2 | Important | packages/cli/src/llm.ts:546 | an empty (null) sanitised reply is re-requested after every stamp change; burns the 500 cap | sonnet | — (log counts 4 -> 9 -> 15) | fixed | llm.test.ts "a null outcome is remembered for the run and is not written to disk" |
| 3 | Important | packages/core/src/llm-input.ts:232 | an unterminated `<think>` block becomes the title and is cached | sonnet | — (node repro) | fixed | llm-input.test.ts "an unterminated think block is not a title" |
| 4 | Important | packages/web/src/PromptTable.tsx:14 | token re-read from sessionStorage; with storage blocked titles never load | sonnet | opencode: same behaviour noted, judged cosmetic | fixed | titles.test.tsx "blocked storage still loads titles when App passes its token" |
| 5 | Important | packages/cli/src/llm.ts:496 | SIGINT waits up to 60 s for an in-flight title request (no stop(), timer not unref'd) | opencode | — (59 s vs 4 ms measured) | fixed | llm.perf.test.ts "SIGINT during a hung title request exits within 2s" |
| 6 | Nit | packages/cli/src/llm.ts:419 | chmod 0700 applied to a pre-existing user directory given as --llm-cache-dir | sonnet | — (stat 755 -> 700) | fixed | llm.test.ts "a pre-existing cache directory keeps its mode" |
| 7 | Nit | packages/core/src/llm-input.ts:241 | round 2: a title that mentions `<think>` mid-line became null | sonnet | — (sanitizeTitle repro) | fixed | llm-input.test.ts "a mid-line mention of the tag is a title; …" (Opus) |
| 8 | Pre-existing | packages/core/src/llm-input.ts:240 | round 2: a lone `</think>` (opener in the template) left the reasoning as the title | sonnet | — (sanitizeTitle repro) | fixed | same test; text after the last `</think>` is used (Opus) |
