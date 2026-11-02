# Secret value on the line under its key

Owner's approval, 2026-11-02: finding 4 of `context/archive/redact-decode-scope/reviews/findings.md`. Second of three.

## Cause

Assignment and `Authorization` rules read the value on the key's own line only, so `password=` with the value on the next line stays visible.

## Phase 1

In `packages/core/src/redact.ts`, a secret key (`isSecretKey`) or `authorization`, followed by `=` or `:` and nothing else on its line, takes the next line as its value when that line, trimmed, is one token: no whitespace except the scheme form `Basic x`, `Bearer x`, and no `=`, `:`, `{`, `[`, `(`, `<` or quote at its start. `~`-free, not a placeholder, at least 8 characters, and containing a digit or an uppercase letter and a lowercase letter. Only the next line, never a later one. Linear; the indent is kept.

Expected output:

| Input (`\n` is a newline) | Output |
|---|---|
| `password=\nhunter2secretvalue` | `password=\n[redacted:secret]` |
| `password:\n  Zq9Xv7Lm2P` | `password:\n  [redacted:secret]` |
| `Authorization:\nBasic dXNlcjpodW50ZXIycGFzcw==` | `Authorization:\nBasic [redacted:auth-header]` |
| `API_KEY=\r\nZq9Xv7Lm2P\r\n` | `API_KEY=\r\n[redacted:secret]\r\n` |

Unchanged byte for byte, count 0:

- `password:\n  file: /run/secret`
- `password:\n  - item`
- `token:\n\nZq9Xv7Lm2P`
- `password=\nnext line of prose`
- `password:\nrequired`
- `title=\nZq9Xv7Lm2P`
- `password=\n[redacted:secret]`

If the rule for a row's placeholder kind differs from the table, stop and report the actual output. Tests: every row, exact output, `redact(redact(x)).text === redact(x).text`. In `redact.perf.test.ts`: 1 MB of `password=\n` repeats and 1 MB of `password=\nZq9Xv7Lm2P\n` repeats, each under 500 ms.

Do not change any existing test expectation. Do not open `~/.claude/projects`; the orchestrator measures real logs, aggregates only.

## Gate
```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^packages/core/src/redact\.perf\.test\.ts$
allow: ^context/(changes|archive)/redact-next-line/
deps: no
schema: no
```
