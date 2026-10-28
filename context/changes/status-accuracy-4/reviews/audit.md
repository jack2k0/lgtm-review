# Real-log audit, status-accuracy-4 (2026-10-28)

Owner's projects (3 after Claude Code's cleanup removed old sessions; new sessions added today), `node scripts/audit/compare.mjs`, counts only. PRE = main 09286dc, POST = branch after phase 2 (580fbcd). Truth unchanged (main truth.py).

| Build | A status (unique) | B status (unique) | C status |
|---|---|---|---|
| PRE (main) | 85.3% (86.1%) | 84.8% (85.3%) | 83.3% |
| POST phase 2 | 91.4% (91.1%) | 90.5% (90.2%) | 88.1% |

Adjudication 2 (Sonnet, aggregates): 0 regressions (no prompt matched in PRE and not in POST); 14 status changes, 10 correct, 4 wrong before and after. Remaining 15 mismatches: 7 branch bug (GATEREAD refused after an absolute `cd` into a sibling worktree), 1 C12 too strict (read-only `open(p).read()` + `str.replace` made `-c` opaque), 2 S-20 scratch worktrees (tool no-changes by S-20; truth lacks cd tracking — owner question), 1 red mutation probe (by design), 1 opaque agent launches, 1 opaque read-only repo script, 2 truth errors (empty diff, late subagent events). Expected after C13/C14: B 151/158; with phase-4 truth fixes 156/158.
