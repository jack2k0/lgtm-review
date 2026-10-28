# bom-strip: tolerate a UTF-8 BOM at the start of a session log

Owner decision 2026-10-27 (recommendation accepted): cheap robustness, no status-rule change. Today a session file starting with U+FEFF loses its first record (`JSON.parse` fails -> "invalid JSON" warning), so a session whose first line is the first prompt drops that prompt.

```gate
allow: ^packages/core/src/(parse|node/lines|node/archive)(\.test)?\.ts$
allow: ^packages/core/src/node/[a-z-]+\.test\.ts$
allow: ^context/(changes|archive)/bom-strip/
labels: none
deps: no
schema: no
```

## Phase 1
- In the line parser (`packages/core/src/parse.ts`, `push`), strip one leading `﻿` from the FIRST line only (line 1). Not from later lines. Check whether any other reader of the first line (title/peek/metadata readers in `src/node/lines.ts` or `src/node/archive.ts`, e.g. reading the first record for listing) has the same problem and fix it the same way.
- Tests (fail on the old code): a log whose first line is BOM + a user prompt record yields that prompt and no "invalid JSON" warning; a BOM in the middle of line 3 is not stripped (record stays invalid as today); any first-line reader you fixed has its own test.
- Done: `pnpm check` green; `node scripts/gate.mjs --base main --plan context/changes/bom-strip/plan.md` exit 0/2.
- Non-goals: other encodings (UTF-16), Windows CRLF, any status rule.
- [x] Phase 1 done
