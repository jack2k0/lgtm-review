# Review findings: redact-decode-scope

reviewers: haiku, opus

Implemented by OpenCode (GLM-5.3-Flash). Its first commit was sent back after opus measured a new leak on the build.

New tests on the old `redact.ts`: 3 fail on the first commit's suite. Real logs, 44268 texts: 33 changed, all with longer output, 0 non-idempotent, 0 more redactions. 5 have a lower count; in the masked shapes the placeholders in the text match main, and the count falls because a chain now takes one redaction instead of several. Differential by haiku: 93 inputs, 8 of them 1 MB, no secret shown that main hides.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Critical | packages/core/src/redact.ts | First commit: `password=\"abc\"def\"ghi jkl\"` kept `def"ghi jkl"` visible, hidden on main | opus | opus: ran | fixed | `ea537f2` removes the chain in one pass, tests |
| 2 | Minor | packages/core/src/redact.ts | The chain removes plain text across spaces and quotes: `password="abc"xaa bb "c"daa bb "c"daa bb "c"d end plain` gives `password="[redacted:secret]"d end plain`; main keeps one more piece | haiku | opus: ran | deferred | fails closed; main also loses most of this text |
| 3 | Major | packages/core/src/redact.ts | `Cookie: session="abc123secretvalue"` stays visible; `Cookie: session=\"abc123secretvalue\"` shows the value after the placeholder | haiku | opus: ran | deferred | same on main, outside this plan; reported to the owner |
| 4 | Minor | packages/core/src/redact.ts | A value on the line after its key stays visible: `password=` newline `hunter2secretvalue`, `Authorization:` newline `Basic ...` | haiku | opus: ran | deferred | same on main, outside this plan; reported to the owner |
