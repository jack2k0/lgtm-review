# Real-log audit, status-accuracy-4 (2026-10-28)

Owner's projects (3 after Claude Code's cleanup removed old sessions; new sessions added today), `node scripts/audit/compare.mjs`, counts only. PRE = main 09286dc, POST = branch after phase 2 (580fbcd). Truth unchanged (main truth.py).

| Build | A status (unique) | B status (unique) | C status |
|---|---|---|---|
| PRE (main) | 85.3% (86.1%) | 84.8% (85.3%) | 83.3% |
| POST phase 2 | 91.4% (91.1%) | 90.5% (90.2%) | 88.1% |

Adjudication 2 (Sonnet, aggregates): 0 regressions (no prompt matched in PRE and not in POST); 14 status changes, 10 correct, 4 wrong before and after. Remaining 15 mismatches: 7 branch bug (GATEREAD refused after an absolute `cd` into a sibling worktree), 1 C12 too strict (read-only `open(p).read()` + `str.replace` made `-c` opaque), 2 S-20 scratch worktrees (tool no-changes by S-20; truth lacks cd tracking — owner question), 1 red mutation probe (by design), 1 opaque agent launches, 1 opaque read-only repo script, 2 truth errors (empty diff, late subagent events). Expected after C13/C14: B 151/158; with phase-4 truth fixes 156/158.

## Phase 4 (truth fixes)

`scripts/audit/truth.py` changed (independent code), tool unchanged. PRE = main build (`/home/jack/git/lgtm-review` dist), POST = this branch after phase 2 + C13/C14. Same 3 projects, 158 tool rows (143 unique prompts), 4 tool rows of the session being written excluded. Counts only.

Truth changes: (a) empty/unavailable `bashEditDiff` is no edit; (b) a subagent run continued by `SendMessage` belongs to the prompt of that send, late events without a send stay with the spawning prompt; (c) quoted strings with `://`, whitespace or query/format characters are not paths; (d) Q4 and Q5 (signal exits 130/137/143/144 and stop notifications = did not complete); (e) `cd` tracking with known variables and subshell scope, unknown directory after `cd -`/`~`/unresolved variable, `npm ci` not a check, `python -c` allow-list analysis (opaque counts as an edit only with a write API). `corepack`, `env $E` and gate-script reads were already handled by truth (non-writing); fixtures document them.

(b) measurement: 7 late agent groups on 6 prompts. Tool attribution: 2 groups are continued by a `SendMessage` issued after the next prompt began and are moved to that send's prompt; 5 groups have no send and stay with the spawning prompt. The PRD says nothing about late events, so truth follows the tool's split (C4). Under the broad reading (everything after the next prompt's first timestamp moves to that prompt) truth would change on 3 of 162 prompts (1 status). No change to the tool requested.

| Build, truth after phase 4 | A status (unique) | B status (unique) | C status |
|---|---|---|---|
| PRE (main) | 85.3% (86.1%) | 86.1% (86.7%) | 88.1% |
| POST | 97.4% (97.0%) | 98.1% (97.9%) = 155/158 | 100% (42/42) |

B with the old truth was 151/158 for POST (134/158 PRE). Reason class B POST: 81.6%.

PRE -> POST status transitions (B rows): 20 (checked->no-changes 5, unchecked->no-changes 11, unchecked->checked 2, unchecked->failing 2). 19 of them turn a mismatch into a match, 1 stays wrong. Prompts that matched in PRE and not in POST: 0.

Remaining 3 mismatching rows (3 prompts, no fork copies):
- tool `unchecked` ("no checks ran"), truth `no-changes`: an opaque writer in the same command as a history git operation; the logged writes are documentation, scratch and git only. Tool is conservative (cannot prove it); truth is probably right. No safe rule.
- tool `failing` (masked failure text), truth `checked`: a mutation probe that prints expected red lines and is followed by a revert. By design (no rule, it could hide a real red). Truth is right on intent; PRE said `unchecked` here (status changed, still wrong).
- tool `checked`, truth `no-changes`: an opaque writer in a merge command where the logged writes are documentation, scratch and git only. Same judgement as the first.

Target >= 97% (PRD, C11): A 97.4% rows / 97.0% unique, B 98.1% / 97.9%: met.

## Final (after review rounds, C16-C19b), 2026-10-28

New truth (phase 4), same log set (158 B rows), counts only. PRE = main, POST = branch 811e4c7.

| Build | A status (unique) | B status (unique) | C status |
|---|---|---|---|
| PRE (main) | 85.3% (86.1%) | 86.1% (86.7%) | 88.1% |
| POST | 96.6% (96.0%) | 97.5% (97.2%) | 100.0% |

PRE->POST: 18 prompts fixed, 0 regressions (no prompt matched with PRE and not with POST). Status transitions: unchecked->no-changes 10, checked->no-changes 5, unchecked->checked 2 (truth checked), unchecked->checked 1 (truth no-changes, opaque python -c blocks the git split), unchecked->failing 1 (truth failing), unchecked->failing 1 (red mutation probe, by design).
Cost of the fail-closed narrowing (C16-C19b) against the optimistic phase-4 build: B 98.1% -> 97.5% (python -c relaxation withdrawn). C19 as first written (cd trusted only inside its && chain) measured 88.6% with 3 regressions and was narrowed to the deterministic cases (C19b).
PRD target >= 97%: met for B (97.5%); A 96.6% (unique 96.0%) is 0.4 points short.
Accepted risk (owner question): in `cd X && a; b`, `b` is resolved under X; if the cd failed, `b` ran in the old directory.
