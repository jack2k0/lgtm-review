# Value after any key name, and the A7 gaps

Owner's approval, 2026-11-03: A6 and A7 of `docs/review-2026-11-02.md`, together. Owner's warning: do not over-hide ordinary text.

All work in `packages/core/src/redact.ts`. `isStrictValue` below is the existing function of that name.

## Phase 1: A6, `<name> key`

`the api key <token>` is hidden through the context rule (`CTX_WORDS`, `CONTEXT`, entropy check with `ENT_MIN_CTX`). Extend that same context, and only it, so that `<name> key` opens it for any name word: one word of letters, digits, `_` or `-`, then a space, `_` or `-`, then `key`, case-insensitive, then the separators the context already accepts (`:`, `=`, spaces, `is`). The value test stays the existing entropy test, unchanged.

The name word must not be one of: `a an the this that my your our their its his her primary foreign unique composite sort partition hash cache lookup map dict object registry hot shortcut keyboard press` (case-insensitive). With such a word, `key` alone does not open the context.

## Phase 2: A7

1. Table cell with a short one-case value. In `redactSecretTableCells`, for a column or cell whose key is a password word (`password`, `passwd`, `pwd`, `pass`, `passphrase`, any case, `_`/`-` variants allowed), also hide a value that is 8 or more characters of only `A-Za-z0-9`, with at least one digit and one letter, and does not match `^(var)?char\d+$|^n?varchar\d+$|^string\d+$|^u?int\d+$|^float\d+$|^bytes?\d+$|^text\d+$` (case-insensitive). Other key columns keep `isStrictValue` only.
2. Second `Authorization` token under 16 characters. In `consumeFurtherAuthTokens`, a further word also counts as a credential when, after stripping trailing `,` `;` `.`, it passes `isStrictValue` and is at least 8 characters. Everything else unchanged.
3. Quoted list item. In the list rule of `redactNextLine`: `- "value"` or `- 'value'` with matching quotes: test the inner value with the list rule's test; hide only the inner value, keep both quotes.
4. List under an empty value. `password: ""` (or `''`) with the next line `- value`: apply the list rule (including 3), keep the empty quotes.

## Expected output (`\n` is a newline)

| Input | Output |
|---|---|
| `the wireguard key S3cr3tVpnToken0123456789 in config` | `the wireguard key [redacted:secret] in config` |
| `wireguard key: S3cr3tVpnToken0123456789` | `wireguard key: [redacted:secret]` |
| `the ssh key S3cr3tVpnToken0123456789` | `the ssh key [redacted:secret]` |
| `signing_key = S3cr3tVpnToken0123456789` | `signing_key = [redacted:secret]` |
| `\| password \| hunter2secret \|` | `\| password \| [redacted:secret] \|` |
| `\| user \| pwd \|\n\|---\|---\|\n\| alice \| hunter2secret \|` | `\| user \| pwd \|\n\|---\|---\|\n\| alice \| [redacted:secret] \|` |
| `Authorization: Bearer abc123def456 Changeme123Now, see docs` | `Authorization: Bearer [redacted:auth-header], see docs` |
| `password:\n- "Changeme123Now"` | `password:\n- "[redacted:secret]"` |
| `password: ""\n- Changeme123Now` | `password: ""\n- [redacted:secret]` |
| `password: ''\n- 'Changeme123Now'` | `password: ''\n- '[redacted:secret]'` |

If a placeholder kind differs, stop and report the actual output.

Unchanged byte for byte, count 0:

- `the key point is S3cr3tVpnToken0123456789`
- `primary key UserAccount2024IdValue`
- `press the key Ctrl1Shift2P`
- `the wireguard key is described in the docs`
- `the ssh key file is ~/.ssh/id_ed25519`
- `the monkey Abcdefghijklmnop1234`
- `| password | varchar255 |`
- `| password | string64 |`
- `| password | required |`
- `| token | hunter2secret |`
- `| name | token |\n|---|---|\n| x | gpt-4o-mini |`
- `| password | v1.2.3-beta |`
- `Authorization: Bearer abc123def456 for the API`
- `Authorization: Bearer xyz for the API`
- `Authorization: Bearer abc123def456 Important, see docs`
- `password:\n- "item"`
- `password:\n- "Important"`
- `password: ""\n- Important`
- `password: ""\n- gpt-4o-mini`
- `title: ""\n- Changeme123Now`

Every existing test keeps passing; do not change any existing expectation. Tests: every row, exact output, `redact(redact(x)).text === redact(x).text`. In `redact.perf.test.ts`: 1 MB of `the ssh key ` repeats, 1 MB of `wireguard key: ` repeats, each under 500 ms.

Do not open `~/.claude/projects`; the orchestrator measures real logs, aggregates only.

```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^packages/core/src/redact\.perf\.test\.ts$
allow: ^context/(changes|archive)/redact-key-names/
deps: no
schema: no
```
