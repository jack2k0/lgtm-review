# Redact a secret value whose closing quote is missing

Open from `redact-edges` (deferred finding 4), and worse than recorded there. Every row of the roadmap is done; this is the remaining privacy item in the ledgers.

## Cause

Probed on `main`: `redact('password="hunter hei')` returns the text unchanged, count 0. The same for `export API_KEY="my secret val` and `{"password": "two words her`. With the closing quote, `password="hunter heidi" x=1` is redacted. Text is cut at a limit before `redact` sees it, so a value with spaces that crosses the limit is stored and shown whole. An unterminated quote in uncut text behaves the same way.

## Phase 1

Files: `packages/core/src/redact.ts`, tests in `packages/core/src/redact.test.ts`.

1. In `redact`, a value that opens with `"` or `'` after a secret key and `=`, `:` or `:=` (optional spaces, optional quote around the key), with no matching closing quote before the end of the line, is redacted up to the end of the line. Keep the key and the opening quote, as the closed form does. The end of the line or of the text ends it; later lines stay untouched.
2. Use the same secret-key test and the same non-literal exemptions as the closed form, so `password="$VAR`, `password="${VAR` and similar references stay unredacted. Non-secret keys stay unredacted: `title="hello wor`.
3. Closed values give exactly today's output. Redaction stays idempotent, and matching stays linear in the text length.
4. Tests that fail on the old code: the three probes above, a value cut through `parse`'s text limit, a single-quoted value, a value ending in spaces, and a value followed by a second line that must survive. Tests that hold on both: the reference exemptions, `title="hello wor`, the closed form, idempotence.

## Non-goals

`trimPartialSecret`, `parse.ts`, multi-line values, existing expectations, labels, goldens. If a label, a golden or an existing expectation disagrees, stop and report it.

## Audit

The orchestrator measures redaction counts on real logs before and after, aggregates only. Do not open `~/.claude/projects`.

## Gate
```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^context/(changes|archive)/redact-open-quote/
deps: no
schema: no
```
