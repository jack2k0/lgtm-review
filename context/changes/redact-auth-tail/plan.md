# Authorization value over 4096 characters

Owner's decision, 2026-11-02: fix finding A2 of `docs/review-2026-11-02.md`. Close A4 as it stands: the tail chain keeps failing closed.

## Phase 1

`AUTH_HEADER` caps the value at 4096 characters, so the rest of a longer token stays visible after the placeholder. Remove the cap; the value runs to the end of the line, or to the next `authorization` header on it, so that header keeps its own match. Tests fail on old code for Bearer, Basic, no scheme and Digest at 5000 characters. Prose and JSON structure stay as they are. In `redact.perf.test.ts`: a 1 MB token and 1 MB of repeated headers, each under 500 ms.

## Gate
```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^packages/core/src/redact\.perf\.test\.ts$
allow: ^docs/review-2026-11-02\.md$
allow: ^context/(changes|archive)/redact-auth-tail/
deps: no
schema: no
```
