# Review findings: redact-open-quote

reviewers: haiku, opus

Implemented by Agy (Claude Opus 4.6). Seven new tests fail on old code (redact.ts swapped back to main). Real logs, aggregates only, 43101 texts in 24 files: 6 texts change, redaction stays idempotent, time 778 ms to 830 ms. 1 MB inputs at most 212 ms.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Major | packages/core/src/redact.ts | `password="abc\"def ghi` leaves `def ghi` visible; same on main for the closed form | haiku | opus: read | deferred | pre-existing; next change `redact-long-escaped` |
| 2 | Major | packages/core/src/redact.ts | A quoted value over 300 characters is not redacted at all, closed or open | haiku | opus: ran | deferred | pre-existing cap in ASSIGN; next change `redact-long-escaped` |
| 3 | Minor | packages/core/src/redact.test.ts | The parse-limit test did not go through `parse` | haiku | opus: read | fixed | fixed later in `redact-cut-test`; this ledger first said fixed in error, before the test existed, and the gate block in merge `20e7a65` repeats that |
