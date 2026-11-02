# Quoted cookie values

Owner's approval, 2026-11-02: finding 3 of `context/archive/redact-decode-scope/reviews/findings.md`. First of three: then the value on the line under its key, then the tail chain.

## Cause

`COOKIE` in `packages/core/src/redact.ts` takes the header value as `[^\r\n"']{1,4096}`. It stops at the first quote, so `session="v"` gives an empty value and stays visible. A header value that opens with a quote does not match at all. A value past 4096 characters keeps its tail.

## Phase 1

Replace the value matching with a small linear scanner. The header name match and `COOKIE_SECRET_NAME` stay.

1. The header value may open with `"`, `'`, `\"` or `\'`. It then ends at the matching closer; otherwise at the end of the line. Text after the closer is kept.
2. Inside, segments split on `;` outside a quoted value. A segment's value may itself be quoted with `"`, `'`, `\"` or `\'`. The quoted value is replaced whole, its quotes included: `session=[redacted:cookie]`. An unterminated one runs to the end of the header value and is hidden.
3. A closing quote of the header value that follows an unquoted cookie value ends both.
4. No length cap on a secret cookie value within its line. Linear time.

Expected output:

| Input | Output |
|---|---|
| `Cookie: session="abc123secretvalue"` | `Cookie: session=[redacted:cookie]` |
| `Cookie: session=\"abc123secretvalue\"` | `Cookie: session=[redacted:cookie]` |
| `Cookie: session='abc123secretvalue'; theme=dark` | `Cookie: session=[redacted:cookie]; theme=dark` |
| `Cookie: theme="dark"; auth="abc123secretvalue"; lang=en` | `Cookie: theme="dark"; auth=[redacted:cookie]; lang=en` |
| `Cookie: session="a;b c"; theme=dark` | `Cookie: session=[redacted:cookie]; theme=dark` |
| `Cookie: session="abc123 secret value` | `Cookie: session=[redacted:cookie]` |
| `{"Cookie":"session=abc123secretvalue; theme=dark","x":"y"}` | `{"Cookie":"session=[redacted:cookie]; theme=dark","x":"y"}` |
| `{"Cookie": "session=abc123secretvalue"}` | `{"Cookie": "session=[redacted:cookie]"}` |
| `curl -H "Cookie: session=abc123secretvalue" http://x` | `curl -H "Cookie: session=[redacted:cookie]" http://x` |
| `curl -H 'Cookie: theme=dark; sid=abc123secretvalue' http://x` | `curl -H 'Cookie: theme=dark; sid=[redacted:cookie]' http://x` |
| `Cookie: session=` then 5000 `z` | `Cookie: session=[redacted:cookie]` |

Unchanged byte for byte, count 0: `Cookie: theme="dark"; lang=en`, `cookie: "hello"`, `the cookie: it's fine`, `Cookie: session=[redacted:cookie]`.

Tests: every row above, redact(redact(x)) === redact(x) for each. Those that pass on old code stay as tests. In `redact.perf.test.ts`: a 1 MB `Cookie: session="` value and a 1 MB line of `session="v"; ` repeats after `Cookie: `, each under 500 ms.

If the JSON escaping or decode loop changes a row's outer spelling, stop and report the actual output; do not change the row. Do not change any existing test expectation. Do not open `~/.claude/projects`; the orchestrator measures real logs, aggregates only.

## Gate
```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^packages/core/src/redact\.perf\.test\.ts$
allow: ^context/(changes|archive)/redact-cookie-quoted/
deps: no
schema: no
```
