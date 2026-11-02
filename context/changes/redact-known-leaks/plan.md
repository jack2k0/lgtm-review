# Four known redaction leaks

Owner's approval, 2026-11-02, with the warning not to over-hide ordinary text: the entry in `context/ORCHESTRATION.md`, "Otwarte problemy", and findings 2 and 5 of `context/archive/redact-next-line/reviews/findings.md`.

## Strict value

Rules 1 to 3 hide ordinary text more easily than the existing next-line rule, so they share one stricter test, `isStrictValue(word)`, all of:

- at least 8 characters;
- only `A-Za-z0-9` and `_ + / = . ~ ! @ # $ % ^ & * -`;
- `=` only at its end;
- not a placeholder (`isPlaceholder`);
- and either of: (a) at least one digit, one lowercase and one uppercase letter; (b) at least 16 characters, only `A-Za-z0-9_+/=`, at least one digit and one letter.

Revised after review: digit plus letter alone hid `gpt-4o-mini`, `v1.2.3-beta`, `string64`, `varchar255`, `config/db1.yml`, `TOKEN_LIMIT_100` in columns such as `token`. The owner asked not to over-hide. The accepted cost: a short value of one letter case, `| password | hunter2secret |`, stays visible.

The existing rule for a plain next-line value stays as it is. `Important` must stay visible under rules 1 to 3.

## Phase 1: in `redactNextLine`

1. List item. A secret key with nothing after its `:` or `=`, next line `- value` with one `isStrictValue` word: hide the word, keep the indent and the `- `.
2. Empty value. A secret key whose value is exactly `""` or `''`, the next line one `isStrictValue` word: hide it, keep the empty quotes. A next line that is a list item here stays unchanged.

## Phase 2: Markdown tables, a new function `redactSecretTableCells`

Runs right after `redactNextLine`. Returns at once when the text holds no `|`. Linear in the text size. Only lines whose trim starts and ends with `|`, split on `|` with no escape handling; cell whitespace is kept byte for byte.

3a. Same row: a cell that, trimmed, is a secret key (`isSecretKey`), and the next cell is one `isStrictValue` word: hide that next cell.
3b. Header: a row with a secret-key cell, the following row, skipping one separator row of only `|`, `-`, `:` and spaces: in each consecutive row of the table, hide the cell in that column when it is one `isStrictValue` word. Stop at the first line that is not a table row.

The placeholder is `[redacted:secret]`. Already redacted cells fail `isStrictValue` and stay.

## Phase 3: `consumeFurtherAuthTokens`

4. A word that ends in one or more of `,` `;` `.`: test `isAuthCredentialWord` on it without them. If it is a credential, hide the word, keep the punctuation visible, and stop. Consume nothing further on that header.

## Expected output (`\n` is a newline)

| Input | Output |
|---|---|
| `password:\n- Changeme123Now` | `password:\n- [redacted:secret]` |
| `password:\n  - Changeme123Now` | `password:\n  - [redacted:secret]` |
| `\| password \| abcd1234efgh5678ijkl \|` | `\| password \| [redacted:secret] \|` |
| `password: ""\nChangeme123Now` | `password: ""\n[redacted:secret]` |
| `token = ''\nChangeme123Now` | `token = ''\n[redacted:secret]` |
| `\| password \| Changeme123Now \|` | `\| password \| [redacted:secret] \|` |
| `\| password \|\n\| Changeme123Now \|` | `\| password \|\n\| [redacted:secret] \|` |
| `\| user \| password \|\n\|---\|---\|\n\| alice \| Changeme123Now \|\n\| bob \| Other456Value \|` | `\| user \| password \|\n\|---\|---\|\n\| alice \| [redacted:secret] \|\n\| bob \| [redacted:secret] \|` |
| `Authorization: Bearer abc123def456 ZmFrZVNlY3JldFZhbHVlMTIz, see docs` | `Authorization: Bearer [redacted:auth-header], see docs` |
| `Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1 ZmFrZVNlY3JldFZhbHVlMTIz.` | `Authorization: Basic [redacted:auth-header].` |
| `Authorization: Bearer abc123def456ghi789, authentication, and docs` | `Authorization: Bearer [redacted:auth-header], authentication, and docs` |

Unchanged byte for byte, count 0:

- `password:\n- Important`
- `password:\n- item`
- `password:\n- gpt-4o-mini`
- `password:\n- config/db1.yml`
- `token = ''\nv1.2.3-beta`
- `| name | token |\n|---|---|\n| x | v1.2.3-beta |`
- `| field | secret |\n|---|---|\n| size | string64 |`
- `| secret | note |\n|---|---|\n| claude-3-5-sonnet | ok |`
- `| name | token |\n|---|---|\n| x | TOKEN_LIMIT_100 |`
- `password:\n- see the docs here1`
- `password: ""\nImportant`
- `password = ""\ngetPassword1()`
- `password: ""\nusername: alice1234`
- `password: ""\n- Changeme123Now`
- `title: ""\nChangeme123Now`
- `| password | required |`
- `| password | see the vault |`
- `| title | Changeme123Now |`
- `| name | password |\n|---|---|\n| x | required |`
- `| password | notes |\n|---|---|\n| required | Changeme123Now |`
- `| password |\n\nChangeme123Now`
- `Authorization: Bearer xyz for the API`
- `Authorization: Bearer abc def,`


If a row's actual output differs, stop and report it. Do not widen a rule. Tests: every row, exact output, `redact(redact(x)).text === redact(x).text`. In `redact.perf.test.ts`: 1 MB of `| password |\n` repeats, 1 MB of `| a | password |\n|---|---|\n` followed by 1 MB of `| x | y |\n`, each under 500 ms.

Do not change any existing test expectation. Do not open `~/.claude/projects`; the orchestrator measures real logs, aggregates only.

```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^packages/core/src/redact\.perf\.test\.ts$
allow: ^context/(changes|archive)/redact-known-leaks/
deps: no
schema: no
```
