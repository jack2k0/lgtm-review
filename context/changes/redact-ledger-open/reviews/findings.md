# Review findings: redact-ledger-open

reviewers: haiku, opus

Implemented by Grok (owner's decision, 2026-11-01: critical). Agy and OpenCode were out of quota; Agy's uncommitted edit was treated as unverified. Grok's first commit left out item 1 of the plan; opus measured that on the build and sent it back.

One existing expectation changed: `a quoted value longer than 4096 characters stays visible` now asserts redaction. That test recorded finding 8 of redact-long-escaped, the defect the owner ordered fixed, so the fix cannot keep it. Reported to the owner with the merge.

New tests on the old `redact.ts`: 5 fail. Real logs, 44047 texts: 19 changed, 0 non-idempotent, 0 fewer redactions, 13 more. Masked shapes of the 19: nested JSON and drive-path inputs, mostly this project's own test inputs quoted in sessions.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Critical | packages/core/src/redact.ts | First commit: a quoted secret over 4096 characters still left visible, same as main | opus | opus: ran | fixed | `d548cf0`, tests for 5000 and 100000 characters, both quotes, closed and open |
| 2 | Major | packages/core/src/redact.ts | `password="C:\abc\" def ghi` shows ` def ghi`; main hid it. Follows from item 3 of the plan for any secret starting with a drive path | haiku | opus: ran | deferred | accepted by the plan: needs a value starting with a drive and containing `\"` before whitespace; 0 fewer redactions on real logs; the owner is told |
| 3 | Minor | packages/core/src/redact.ts | A nested secret's output loses inner escaping, `{"cfg":"{"password":"[redacted:secret]"}"}` is not valid JSON | haiku | opus: ran | deferred | secret hidden; existing behaviour of the decode loop |
| 4 | Minor | packages/core/src/redact.ts | When a redaction triggers the decode loop, the whole text is decoded: source quoted in a log loses backslashes (3 real-log texts) | opus | opus: real-log count | deferred | display only, fails closed; existing behaviour of the decode loop |
| 5 | Minor | packages/core/src/redact.ts | `password="` plus 300 repeats of `x\\"` is not idempotent | haiku | opus: ran | deferred | same on main; reproduced at 300 repeats, not at the reported 18; 0 on real logs |
| 6 | Minor | packages/core/src/redact.ts | `password="[redacted:secret]"keep this text"` loses `keep this text` (finding 5 of redact-long-escaped) | opus | opus: ran | deferred | plan decision: fails closed |
| 7 | Minor | packages/core/src/redact.ts | `{"cwd":"C:\\Users\\jack\\proj"}` is rewritten (finding 7 of redact-long-escaped) | opus | opus: ran | deferred | plan decision: Windows out of scope |
