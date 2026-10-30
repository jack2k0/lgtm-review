# Review findings: redact-coverage

reviewers: sonnet, haiku

Cross-verification: the orchestrator (opus) reran every accepted finding's input against the fix commit with a probe script. Real-log aggregate (24 logs, 41007 texts, counts only): 31 texts change, no time regression (642 ms vs 697 ms).

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/redact.ts (MYSQL_ATTACHED_P) | `-P` port flag was redacted | sonnet | opus: probe | fixed | `mysql -P3306 -h x` unchanged |
| 2 | Important | redact.ts (CURL_USER) | partial quoting leaked the value | sonnet | opus: probe | fixed | `curl -u bob:'…'`, `'bob':…`, `"bob":…` redacted |
| 3 | Important | redact.ts (CURL_USER) | combined short flags leaked the value | sonnet | opus: probe | fixed | `-su`, `-fsSu` redacted |
| 4 | Important | redact.ts (MYSQL_ATTACHED_P, SSHPASS) | escaped quotes leaked the value | sonnet | opus: probe | fixed | value absent from output |
| 5 | Nit | redact.ts (SSHPASS) | port of the wrapped ssh was redacted | sonnet | opus: probe | fixed | `sshpass -e ssh x -p 22` unchanged |
| 6 | Nit | redact.ts (CURL_USER) | unquoted value stops at `;`, `&`, `\|` | sonnet | opus | rejected | an unquoted metacharacter ends the shell word |
| 7 | Nit | redact.ts (SECRET_WORD) | `PWD=/path` was destroyed | sonnet, haiku | opus: probe | fixed | `PWD=/home/u/app` gives `PWD=~/app` |
| 8 | Important | redact.ts (redactAssign) | unquoted minimum is 4 after `:`, plan says 3 | haiku | opus: probe | deferred | see note; `=` keeps 3, `password: abc` stays unredacted |
| 9 | Nit | redact.ts (SECRET_WORD) | `const pass = foo;` is redacted | haiku | opus | rejected | same as `password = foo`; fails closed |

Note on 8: see the worker's report in the merge body; a 3-character value after `:` is left for a later round because YAML and prose values collide.
