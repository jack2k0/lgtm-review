reviewers: haiku, opus

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/redact.ts:1242 | camelCase XML tags over-hidden (`<passwordPolicy>strict</passwordPolicy>`, `<tokenType>`) | haiku | opus: confirmed (probe) | fixed (c574d8c) | tag must end in a secret word; corpus rows | — |
| 2 | Important | packages/core/src/redact.ts:1261 | `=>` hid Laravel prose messages | haiku | opus: confirmed (probe) | fixed (c574d8c) | prose exemption kept for `=>`; corpus rows | — |
| 3 | Important | packages/core/src/redact.ts:584 | `Config.PasswordMaxLength256` taken for a token | haiku | opus: confirmed (probe) | fixed (c574d8c) | digits must sit between letters | — |
| 4 | Important | packages/core/src/redact.ts:1239 | DOC_PLACEHOLDER prefix let `example.Hunter2xyzABC` through | haiku | opus: confirmed (probe) | fixed (c574d8c) | anchored placeholder | — |
| 5 | Important | packages/core/src/redact.ts:1242 | multi-line or >500-char XML values survived | haiku | opus: confirmed (probe) | fixed (c574d8c) | values span lines, no cap | — |
| 6 | Important | packages/core/src/redact.ts:1226 | `.netrc` `default` entry not handled | haiku | opus: confirmed (probe) | fixed (c574d8c) | corpus rows | — |
| 7 | Important | packages/core/src/redact.ts:1660 | URL template closers optional (`${Hunter2…@`) | haiku | opus: confirmed (probe) | fixed (c574d8c) | closer required; `%NAME%` upper case only | — |
| 8 | Nit | packages/core/src/redact.ts:1283 | env-default literal of a secret-named var always hidden | haiku | — | rejected | fail closed (AGENTS.md) | — |
| 9 | Nit | packages/core/src/redact.ts | `password=${Hunter2SecretPw9 more` (unclosed `${` outside URLs) kept as a reference | opus | — | deferred | deliberate prefix rule for values cut at whitespace (`$(vault read …`); rare shape | — |

Second reviewer Fable stopped after 40 min without output; Opus cross-checked every Important with a probe on the head build.
