# Review findings: redact-long-escaped

reviewers: haiku, opus

Implemented by Grok (owner's decision). Opus added the last two commits: level-by-level decoding, and the limit on tail removal. Seven tests of the first commit failed on the old code. Real logs, aggregates only, last run on 43549 texts: 29 change, 0 with fewer redactions than main, 20 with more, 5 with a longer output, 0 not idempotent. The logs include this session's own probes, so these counts are not a rate. Synthetic fuzz, 200000 inputs: 0 values visible that main hid, 0 not idempotent. A second Haiku differential, 56000 inputs with secrets: 0, run before the last commit. 1 MB adversarial lines: at most 158 ms.

The plan's design was two regex passes; Grok wrote a hand scanner of about 190 lines, kept after the differential found no leak.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Critical | packages/core/src/redact.ts | First version: `cfg='x\' apikey='hunter2rocks99'` left the secret visible, redacted on main | haiku | opus: ran | fixed | test; escapes apply only to a secret key's value |
| 2 | Critical | packages/core/src/redact.ts | Second version: `['password="hunter hei','token="my secret val','x']` left the first value visible, redacted on main | opus | opus: synthetic reproduction of a real-log count | fixed | test |
| 3 | Major | packages/core/src/redact.ts | Not idempotent on two levels of escaping | opus | opus: real-log count | fixed | decode loop in `redact`, test; 0 on real logs |
| 4 | Major | packages/core/src/redact.ts | `leakedTailEnd` deleted `}, "name"` after a JSON-escaped secret | haiku | opus: ran | fixed | test |
| 5 | Minor | packages/core/src/redact.ts | `password="[redacted:secret]"keep this text"` loses `keep this text`; a glued word cannot be told from a leaked tail | haiku | opus: read | deferred | fails closed, rare shape |
| 6 | Major | packages/core/src/redact.ts | `token="C:\temp\" --flag value` hides the rest of the line | haiku | opus: ran | deferred | fails closed; a backslash cannot be told from an escape |
| 7 | Minor | packages/core/src/redact.ts | `{"cwd":"C:\\Users\\jack\\proj"}` becomes `{"cwd":"~\proj"}` | haiku | opus: ran | deferred | the home-path rule fires on decoded text; Windows is unsupported |
| 8 | Major | packages/core/src/redact.ts | A quoted secret over 4096 characters is still left visible | opus | opus: ran | deferred | stated limit of the plan |
| 9 | Major | packages/core/src/redact.ts | A secret inside a harmless key's JSON string, escaped twice, stays visible | opus | opus: ran | deferred | same on main; needs a nested JSON reader |
