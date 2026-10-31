# Open redaction findings from `redact-long-escaped`

Owner's request, 2026-10-31. Ledger: `context/archive/redact-long-escaped/reviews/findings.md`.

## Decisions

- Finding 8 (secret over 4096 characters): fix, phase below.
- Finding 9 (secret in a JSON string escaped twice under a harmless key): fix, phase below.
- Finding 6 (`token="C:\temp\" --flag value` hides the rest of the line): fix only for a value that starts with a Windows drive path. `password="abc\" def ghi` must stay fully redacted, because a backslash-quote cannot otherwise be told from an escape and redaction fails closed.
- Finding 5 (`password="[redacted:secret]"keep this text"` loses `keep this text`): no change. A word glued to a closing quote cannot be told from a leaked tail, and redaction fails closed.
- Finding 7 (`C:\\Users\\...` home path in decoded text): no change. Windows is out of scope.

## Phase 1

Files: `packages/core/src/redact.ts`, tests in `packages/core/src/redact.test.ts`.

1. A quoted value of a secret key has no length cap: closed or open, it is redacted whatever its length, within its line. `QUOTED_CAP` stays for harmless keys. Matching stays linear; repeated `password="` on one line must not rescan.
2. The closing quote of a harmless value may also open the next key. `{"cfg":"{\"password\":\"abc\\\"def ghi\\\"\"}"}` must not show `abc` or `def ghi`. Today the decoded form loses the opening quote of `"password"` because `{` consumed it as a closer. Change where the scan resumes, not the value. Plain text with no secret stays byte for byte.
3. In a secret key's value that starts with `[A-Za-z]:\`, a backslash before the matching quote does not escape it when the quote is followed by whitespace or the end of the line: `token="C:\temp\" --flag value` gives `token="[redacted:secret]" --flag value`. `password="abc\" def ghi` and `password="a b\" and then plain` still hide the tail.
4. Tests that fail on the old code: closed and open values of 5000 and 100000 characters, single and double quotes; the nested JSON above, and the same with a further level of escaping; the drive-path case. Tests that hold on both: `password="abc\" def ghi`, `title="<5000 characters>"` unchanged, `{"cfg":"{\"a\":\"plain words\"}"}` unchanged, idempotence on each input. A 1 MB line of `password="` repeats, and of a 1 MB open value, stays under 500 ms.

## Non-goals

`CLI_FLAG`, headers, URLs, `parse.ts`, `leakedTailEnd`, Windows path rules, existing expectations, labels, goldens. If a label, a golden or an existing expectation disagrees, stop and report it.

## Audit

The orchestrator measures real logs before and after, aggregates only. Do not open `~/.claude/projects`.

## Gate
```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^context/(changes|archive)/redact-ledger-open/
deps: no
schema: no
```
