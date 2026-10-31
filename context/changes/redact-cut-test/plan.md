# Correct the `redact-open-quote` record and add the missing test

The `redact-open-quote` ledger and the gate block in merge `20e7a65` say finding 3 was fixed. It was not: the worker hit its quota before committing, and the orchestrator merged without reading that result. The test "value cut through parse text limit" still calls `redact` on a short string.

## Phase 1

1. In `packages/core/src/redact.test.ts`, replace nothing; add one test that sends a prompt longer than `PROMPT_TEXT_MAX` through `parseLines`, with a quoted secret with spaces crossing the limit, and checks `redact` on the parsed text.
2. Correct `context/archive/redact-open-quote/reviews/findings.md`: finding 3 is fixed here, and the count of tests failing on old code is seven.

Existing expectations stay.

## Gate
```gate
allow: ^packages/core/src/redact\.test\.ts$
allow: ^context/archive/redact-open-quote/reviews/findings\.md$
allow: ^context/(changes|archive)/redact-cut-test/
deps: no
schema: no
```
