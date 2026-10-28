# Findings: change/llm-titles

Tier High (schema, cli server, network path). Implementer: Grok (grok-4.7). Reviewers: Sonnet (subagent), OpenCode (GLM-5.3-Flash), in parallel; overlapping finding confirmed by both; every Important finding came with a reproduction on the built CLI. Round 1.

reviewers: sonnet, opencode

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Important | packages/cli/src/llm.ts:655 | a stamp change drops ready titles from view() until the queue re-reads the cache; titles flash away on every live refresh | sonnet | opencode #2: confirmed (probe B: titles {} after utimes) | open | |
| 2 | Important | packages/cli/src/llm.ts:546 | an empty (null) sanitised reply is re-requested after every stamp change; burns the 500 cap | sonnet | — (log counts 4 -> 9 -> 15) | open | |
| 3 | Important | packages/core/src/llm-input.ts:232 | an unterminated `<think>` block becomes the title and is cached | sonnet | — (node repro) | open | |
| 4 | Important | packages/web/src/PromptTable.tsx:14 | token re-read from sessionStorage; with storage blocked titles never load | sonnet | opencode: same behaviour noted, judged cosmetic | open | |
| 5 | Important | packages/cli/src/llm.ts:496 | SIGINT waits up to 60 s for an in-flight title request (no stop(), timer not unref'd) | opencode | — (59 s vs 4 ms measured) | open | |
| 6 | Nit | packages/cli/src/llm.ts:419 | chmod 0700 applied to a pre-existing user directory given as --llm-cache-dir | sonnet | — (stat 755 -> 700) | open | |
