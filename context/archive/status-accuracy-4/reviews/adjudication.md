# Adjudication of the status mismatches (2026-10-28, Sonnet, real logs, aggregates only)

Population B, truth variant `main`. 24 mismatching rows = 21 unique prompts (3 fork copies). During the run Claude Code's log cleanup removed old sessions (5 -> 3 projects); all 24 rows were in the private snapshot (158 rows).

Confusion (tool -> truth): checked->no-changes 6; unchecked->no-changes 10; unchecked->checked 5; unchecked->failing 2; checked->unchecked 1.

| Rule | Rows fixed | Prompts changed alone (status / reason only) | Fail-closed |
|---|---|---|---|
| CD + VARCHAIN (relative targets after a known `cd`) | 5 (+2 to no-changes) | 8 / 2 | yes |
| GATEREAD (`node scripts/gate*.mjs` non-writing, not a check) | 6 (+1 with COREPACK) | 6 / 0 | mostly (name-based, repo `scripts/` only) |
| SPLIT-OPAQUE (+ PYC + NPMCI) in the no-diff path | 4 | 4 / 0 | yes |
| COREPACK prefix | 1 | 1 / 7 | yes (exposes one by-design red probe) |
| ENVVAR (`env $E git …`) | 1 | 1 / 0 | yes |
| Q4 | 2 (redundant after CD) | 2 / 0 | by decision |
| truth.py fixes (empty diff, subagent time split, quoted strings) | 4 | — | — |

All rules together (tool side): 18 of 24 rows match, 0 previously matching prompts changed, 24 of 158 prompts touched. Unfixable safely: 2 rows (opaque writers such as agent launches or repo scripts in the merge command), 1 row (red mutation probe).
Q5: 58 results with exit 137/144; 1 prompt has a signal-killed check and it already matches.
Policy note for the owner: with CD, implementing in a scratch-dir worktree and merging reads as `no-changes` for the orchestrator's prompt (S-20 + Q1 as decided).
