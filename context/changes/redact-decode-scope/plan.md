# Remaining redaction findings from `redact-ledger-open`

Owner's request, 2026-11-01. Ledger: `context/archive/redact-ledger-open/reviews/findings.md`. Not critical.

## Decisions

- Finding 4 (a redaction found in decoded text rewrites the whole text, so source quoted elsewhere loses backslashes): fix, Phase 1.
- Finding 5 (`password="` plus 300 repeats of `x\\"` is not idempotent): fix, Phase 1.
- Finding 3 (a nested secret's output is not valid JSON): no change. Re-escaping needs a map from decoded back to escaped text; the secret is hidden and the output is for display. The fix for finding 4 keeps this limited to the line that held the secret.
- Finding 2 (drive-path tail): no change, accepted by the owner, 2026-11-01.
- Finding 6 (glued word after a placeholder): no change, fails closed.
- Finding 7 (`C:\\Users\\...`): no change, Windows is out of scope.

## Phase 1

In `redact` in `packages/core/src/redact.ts`:

1. Decoding stays only on the lines that need it. When the existing decode loop finds a secret, redact the text line by line with that same loop, so a line where decoding reveals nothing keeps its original spelling. Fail closed: a rule can span lines, so if the line-by-line result has a lower count than the whole-text result, or still contains a value the whole-text result hid, keep the whole-text result. Text where decoding finds nothing takes the same path as today, with no extra cost.
2. Find why the finding 5 input changes on the second call, and fix that cause. If the cause cannot be fixed inside this plan, stop and report it; do not hide it with an extra outer loop.
3. Tests that fail on the old code:
   - Two lines, the first `const a = "x\\y";` and the second `{\"password\":\"hunter2 words\"}`: the first line stays byte for byte, the second hides the secret.
   - The finding 5 input: `redact(redact(x)).text === redact(x).text`.
4. Tests that hold on both:
   - The nested input `{"cfg":"{\"password\":\"abc\\\"def ghi\\\"\"}"}` shows neither `abc` nor `def ghi`.
   - A single line with an escaped secret and other text hides the secret.
   - A PEM block whose BEGIN and END lines are escaped and on separate lines stays redacted.
   - Idempotence for every new input.
   - In `redact.perf.test.ts`: 1 MB of 20000 lines, each with an escaped secret, under 500 ms.

Do not change any existing test expectation. Do not open `~/.claude/projects`; the orchestrator measures real logs, aggregates only.

## Gate
```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^packages/core/src/redact\.perf\.test\.ts$
allow: ^context/(changes|archive)/redact-decode-scope/
deps: no
schema: no
```
