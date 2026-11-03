# Review findings: redact-key-names

reviewers: haiku, opus

Implemented by OpenCode (GLM-5.3-Flash, Agy got 401), owner's decision, 2026-11-03; two parts OpenCode left open (a list under an empty value, a short further token without punctuation) and the fix round by opus. Haiku ran 648 differential inputs and timing up to 2 MB; opus reran them after the fix round. New tests on the old `redact.ts`: 12 fail. Real logs, 40386 texts: 0 changed, 0 non-idempotent. Fuzz: 0 new leaks. One existing expectation moved, by the owner's decision: `password: ""` then `- Changeme123Now` was pinned visible by `redact-known-leaks` and is now hidden.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Major | packages/core/src/redact.ts | `index key createdAt2024Index` hid an identifier | haiku | opus: ran | fixed | `index` added to the blocked words; keep test |
| 2 | Major | packages/core/src/redact.ts | Password column hid hash names `bcrypt12`, `sha256sum` | haiku | opus: ran | fixed | hash names excluded; keep tests |
| 3 | Major | packages/core/src/redact.ts | A short word after the `Authorization` token was hidden: `Version2`, `README1st`, `Changelog2024` | haiku | opus: ran | fixed | further short token needs 12 characters and a letter after its last digit; exact-output tests |
| 4 | Minor | packages/core/src/redact.ts | Still hidden, by design: a long mixed-case identifier after a named key, `the ssh key createdAt2024Index`, `license key: userAccountId123`; `min8chars1` in a password column; `the sort- key ...` | haiku | opus: read | deferred | fails closed; the value has the shape of a credential |
| 5 | Minor | packages/core/src/redact.ts | Still visible, same on main: bare `key is <token>`, `the key is <token>`, `wireguard key` with the value on the next line | haiku | opus: ran | deferred | bare `key` is blocked on purpose; the next-line rule takes secret keys only |
