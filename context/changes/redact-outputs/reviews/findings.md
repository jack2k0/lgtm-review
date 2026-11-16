reviewers: opus, haiku

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Nit | packages/cli/src/format.ts:53 | same spread-over-default pattern as summary.ts (explicit `usernames: undefined` wipes the default) | haiku | opus: confirmed (read) | fixed (59d4ed5) | spread moved first in both option merges; no caller passes undefined today | — |
| 2 | Pre-existing | packages/cli/src/export.ts:260 | prints the absolute output path | haiku | — | rejected | user's own chosen path on their terminal, not log content | — |
| 3 | Nit | packages/core/src/redact.ts:99 | PEM body lines become bare `[redacted]`, not in README | haiku | — | deferred | core docs; next redaction slice (S-34) | — |

Opus review: diff read, no further findings. Implementer noted: `--list` empty-case message prints the raw dir on the user's terminal (not an export) — deferred.
