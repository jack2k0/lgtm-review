reviewers: grok-orchestrator, grok-review

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/check-patterns.ts:84 | coloured `ℹ fail N` was not a failure signal | grok-review | grok-orchestrator: confirmed | fixed | analyze.test.ts coloured node:test summary | pre-merge review |
| 2 | Important | packages/core/src/check-patterns-classify.ts:260 | `make -q` matched any token containing q (`make -Iquery`) | grok-review | grok-orchestrator: confirmed | fixed | analyze.test.ts `make -Iquery test` stays a check | pre-merge review |
| 3 | Important | packages/core/src/check-patterns-classify.ts:643 | a later `&` did not mask (`pnpm test && echo ok &`) | grok-review | grok-orchestrator: confirmed | fixed | analyze.test.ts later `&` says exit code not verified | pre-merge review |
| 4 | Nit | packages/core/src/check-patterns-classify.ts:672 | a filter pipe continued across `;` and `\|\|` | grok-review | grok-orchestrator: confirmed | fixed | analyze.test.ts `pnpm test \| grep FAIL; rg x` stays failing | pre-merge review |
| 5 | Nit | packages/core/src/check-patterns-classify.ts:245 | `--print-config` is a no-op on every token, like `--list` | grok-review | grok-orchestrator: same rule as the existing no-op flags | rejected | a token in NO_OP_FLAGS drops the invocation; script files stay exempt | — |

Real-log audit before these fixes: PRE == POST, 10 projects, 71 tool rows, identical aggregates (B status 59/71). The fixes are narrower than that run.
