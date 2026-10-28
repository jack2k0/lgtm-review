# Real-log audit, status-accuracy-5 (2026-10-28)

Counts only. PRE = main (after status-accuracy-4), POST = this branch. Truth: scripts/audit/truth.py as merged in status-accuracy-4 (it assumes a cd succeeded and has no R1-R3 rules), 158 B rows.

| Build | A status (unique) | B status (unique) | C status |
|---|---|---|---|
| PRE (main) | 96.6% (96.0%) | 97.5% (97.2%) | 100.0% |
| POST | 83.6% (85.1%) | 84.8% (86.0%) | 88.1% |

PRE->POST: 0 fixed, 20 changed away from truth, all in the cautious direction: no-changes->unchecked 11, no-changes->checked 6 (merge files now counted as code, a check passed after them), checked->unchecked 4.
Attribution (Sonnet, rules switched off one at a time): R4 (owner decision Q3, full caution for cd) 14 rows; R3 (opaque command next to a history git op is not git-only) 6 rows; R1, R2 0 rows. No row hid a real code edit; 3 rows were "justified in principle" (a repo script that rewrites a lock file, a `node` run next to a merge, a test edit in a scratch worktree).
Rejected narrowings: a doc name after an unknown directory kept as a doc (would recover 4 rows) conflicts with existing C18 expectations on main; exempting scratchpad scripts from R3 (4 rows) would reopen the hole. Accepted: `seq` as a read-only head (0 rows, less false opacity).
The PRD >= 97% target is no longer met; this is the owner's choice of full caution (Q3, 2026-10-28) plus R3.
