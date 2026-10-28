# Findings: change/status-accuracy-7

Tier High (status rule; check-patterns.ts, shell-edits.ts). Implementer: Sonnet (subagent). Reviewers: Haiku (subagent; probes checked against real bash), Opus. One round. Real-log audit: 0 status changes, 0 regressions.

reviewers: haiku, opus

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/check-patterns.ts:63 | a CRLF heredoc never closed on `EOF\r` under strict matching, so a later write was swallowed (main recorded it) | haiku | opus: reproduced, test fails without the fix | fixed | heredocEnds drops one trailing CR; shell-edits.test.ts "a CRLF heredoc closes on EOF\r and the next command is seen" |
| 2 | Pre-existing | packages/core/src/check-patterns.ts:60 | a delimiter like `END-1` is cut at `-`, so the body never closes (branch now opaque, main silent) | haiku | same on main for edits | deferred | round 8 (take the delimiter word up to a shell metachar) |
| 3 | Nit | packages/core/src/shell-edits.test.ts | three D3 rows pass on main although the plan lists them as failing | haiku | — | rejected | they are regression guards for exact-match closing; the stripHeredocs D3 tests do fail on main |
| 4 | Nit | packages/cli/src/llm.perf.test.ts | moved timing assertion: same 400 ms threshold and 200 ms timeout, functional checks kept | haiku | — | rejected | nothing weakened (reviewer's own conclusion) |
