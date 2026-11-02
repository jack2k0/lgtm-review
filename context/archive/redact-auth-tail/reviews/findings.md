# Review findings: redact-auth-tail

reviewers: haiku, opus

Written by opus on the owner's instruction, 2026-11-02: OpenCode and Agy are out of quota. Haiku ran the differential; opus read it and confirmed the deferred findings on the build.

New tests on the old `redact.ts`: 6 fail. Real logs, 44755 texts: 1 changed, a second header on one line now hidden, 0 non-idempotent, 0 fewer redactions. Haiku: 46 inputs, no secret shown that main hides, linear at 1 and 2 MB.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Major | packages/core/src/redact.ts | `Authorization: Basic dXNlcjpwYXNz ZmFrZVNlY3JldFZhbHVlMTIz` hides the first token only; the second stays visible. Same on main | haiku | opus: ran | deferred | outside this plan; reported to the owner |
| 2 | Minor | packages/core/src/redact.ts | `myauthorization: Basic Qm9vZ3VzU2VjcmV0MTIzNDU2` stays visible: the lookbehind skips a glued prefix. `x-authorization:` is hidden. Same on main | haiku | opus: ran | deferred | outside this plan; reported to the owner |
