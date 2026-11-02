# Review findings: redact-next-line

reviewers: haiku, opus

Implemented by Agy (Gemini 3.8 Flash), owner's decision, 2026-11-02. Haiku ran the differential; opus read the diff and reran the key inputs on rebuilt builds. Haiku's note that main's build was stale did not hold: the cap is absent from the rebuilt main build and the long-token input is hidden on it.

New tests on the old `redact.ts`: 7 fail. Real logs, 40386 texts (the audit takes the 60 largest logs under 8 MB, so the sample shifted from earlier rounds): 0 changed, 0 non-idempotent. Haiku: 86 inputs, no secret shown that main hides, linear at 1 and 2 MB. `Authorization: Bearer xyz for the API` stays byte for byte.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Minor | packages/core/src/redact.ts | Ordinary text is hidden under a secret key: `Password:` then `Important`, `password =` then `getPassword1()` | haiku | opus: ran | deferred | by the plan's rule, fails closed; 0 changes on real logs; the owner is told |
| 2 | Minor | packages/core/src/redact.ts | Still visible: `password:` then `- Changeme123Now`, a table row, `password: ""` then a value on the next line. Same on main | haiku | opus: read | deferred | outside the plan's rule |
| 3 | Minor | packages/core/src/redact.ts | `preauthorization=abc123def` is hidden; `redactNextLine` matches any key ending in `authorization` | haiku | opus: read | deferred | fails closed; follows from the glued prefix the owner asked for |
| 4 | Minor | packages/core/src/redact.ts | A long camelCase word after a token is hidden: `Bearer abc123DEF456ghi789 thisIsAVeryLongCamelCaseWordHere` | haiku | opus: read | deferred | by the plan's rule, fails closed |
| 5 | Minor | packages/core/src/redact.ts | `Bearer abc123def456 ZmFrZVNlY3JldFZhbHVlMTIz, see docs` leaves the second token visible: the comma stops it. Same on main | haiku | opus: read | deferred | outside the plan's rule; the owner is told |
