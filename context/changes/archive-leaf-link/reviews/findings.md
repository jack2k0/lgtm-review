reviewers: opus, haiku

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Pre-existing | packages/core/src/node/archive.ts:102 | lstat-then-mkdir/chmod TOCTOU window in ensureDestDir (and the new leaf check) | haiku | opus: confirmed (read) | deferred | needs a local process racing writes inside the user's own 0700 archive; not introduced here | — |
| 2 | Nit | packages/core/src/node/archive.ts:60 | doc comment does not mention the symlinked leaf | haiku | — | fixed (ca26220) | comment updated | — |

Opus review: diff read, no further findings. Repro failed on main (file written through the link, outside dir chmod-ed 0700).
