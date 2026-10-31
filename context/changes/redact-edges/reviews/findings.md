# Review findings: redact-edges

reviewers: opencode, opus

Real-log aggregate (24 logs, 3562 message texts, counts only): `redact` changes 3 texts, all with more redactions; 1 of 1251 cuts at character 200 inside a word is trimmed; status audit JSON is byte-identical to `main`.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/redact.ts | A URL password across the cut left a fragment | opencode | opus: read | fixed | new tests in `redact.test.ts` |
| 2 | Important | packages/core/src/redact.ts | `password : hun` with spaces around the separator left a fragment | opencode | opus: read | fixed | new tests in `redact.test.ts` |
| 3 | Minor | packages/core/src/redact.ts | A cut inside a prefix or key name (`ghp`, `passw`) leaves that fragment | opencode | opus: read | rejected | the fragment holds no secret material |
| 4 | Minor | packages/core/src/redact.ts | A value with inner spaces (`password="hunter hei`) leaves the last word | opencode | opus: read | deferred | needs quote tracking across runs; `redact` itself still sees no closing quote |
| 5 | Minor | packages/core/src/redact.ts | Prose after a secret-like word can lose its last partial word | opencode | opus: real-log count | rejected | fail closed by AGENTS.md; 1 of 1251 real cuts |
