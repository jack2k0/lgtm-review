# Redaction edges: a secret across a text cut; a 3-character secret after `:`

Deferred in `redact-terminal` (#3) and `redact-coverage` (#8); the owner asked for both on 2026-10-31.

## Cause

1. `parse.ts` cuts display text before any redaction runs. A token across the cut leaves a prefix shorter than its pattern's minimum, so `redact` no longer sees a token. Same for `password=hu`.
2. `redactAssign` needs 4 characters after `:`, so `password: abc` stays. The existing expectation `["key value short", "token: abc"]` in `redact.test.ts` stays unchanged, so only password-like keys get the lower minimum.

## Phase 1

Files: `packages/core/src/redact.ts`, `packages/core/src/parse.ts`, `packages/core/src/redact.test.ts`, `packages/core/src/parse.test.ts` (use the existing test file for each; say so if a name differs).

1. `redact.ts`: new export `trimPartialSecret(cut: string): string`. It looks at the last whitespace-delimited run of `cut` and removes that run, plus the whitespace before it, when any of these holds:
   - the run starts with a token prefix the token rules in this file already know (reuse their data; do not keep a second list that can drift);
   - the run is `key=value` or `key:value`, optionally quoted, where `isSecretKey(key)` is true;
   - the word before the run is a secret flag or key (`isSecretKey` after stripping dashes and a trailing `:` or `=`), or `Bearer`, `Basic`, `-p`, `-u`, `--user`.
   Otherwise it returns `cut` unchanged. It must be linear in the length of `cut`.
2. `parse.ts`: new internal `truncateText(s, max)`: when `s.length <= max` return `s`; take `s.slice(0, max)`; when `s[max]` is not whitespace, return `trimPartialSecret` of it. Use it at the sites whose limit is `PROMPT_TEXT_MAX`, `QUOTE_MAX` or `HINT_MAX`, including the shared content helper when called with those limits. `truncate` stays as it is for commands, paths and results, because those feed status rules.
3. `redactAssign`: the unquoted minimum after `:` is 3 when the key, lowercased without dashes, contains `password`, `passwd`, `passphrase`, or equals `pass`, `pwd` or `secret`. Other keys keep 4. The `.`, `~`, `/` rule for `pwd` stays.
4. Tests that fail on the old code: a 300-character prompt through the parser with a real-shaped token across character 200 (prompt, then `redact`, leaves no part of the token); the same for `password=hunter2xyz` and `--password hunter2xyz`; ordinary prose over the limit keeps exactly the first 200 characters; `password: abc` is redacted; `token: abc` is unchanged.

## Non-goals

`COMMAND_MAX`, `RESULT_TEXT_MAX`, secrets with no recognisable shape, changes to other redaction rules, existing expectations, labels, goldens. If a golden or an existing expectation changes, stop and report it.

## Gate
```gate
allow: ^packages/core/src/(redact|parse)(\.test)?\.ts$
allow: ^context/(changes|archive)/redact-edges/
deps: no
schema: no
```
