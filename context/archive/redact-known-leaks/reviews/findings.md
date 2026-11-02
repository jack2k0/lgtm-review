# Review findings: redact-known-leaks

reviewers: haiku, opus

Implemented by Agy (Gemini 3.8 Flash), owner's decision, 2026-11-02. Haiku ran 188 differential inputs and timing up to 2 MB; opus read the diff and reran the key inputs and the real-log audit after the fix round. New tests on the old `redact.ts`: fail. Real logs, 40386 texts: 0 changed, 0 non-idempotent. Fuzz: 0 new leaks.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Major | packages/core/src/redact.ts | First strict value hid ordinary table and list text: `gpt-4o-mini`, `v1.2.3-beta`, `string64`, `varchar255`, `config/db1.yml`, `TOKEN_LIMIT_100` | haiku | opus: ran | fixed | `8040695`; the rows are now tests |
| 2 | Minor | packages/core/src/redact.ts | Accepted cost of the fix: `password` table row with `hunter2secret` stays visible (one letter case, under 16 characters) | opus | haiku: n/a | deferred | the owner asked not to over-hide; the owner is told |
| 3 | Minor | packages/core/src/redact.ts | Still hidden in a secret column: `Claude-3-5-Sonnet`, `Version12` | opus | haiku: n/a | deferred | digit and both letter cases; fails closed |
| 4 | Minor | packages/core/src/redact.ts | Still visible, same on main: `Authorization: Bearer abc123def456 Changeme123Now, see docs` (second token under 16 characters) | haiku | opus: read | deferred | same limit with or without the comma |
| 5 | Minor | packages/core/src/redact.ts | Still visible, same on main: `password:` then `- "Changeme123Now"`; `password: ""` then `- Changeme123Now` | haiku | opus: read | deferred | outside the plan's rule |
