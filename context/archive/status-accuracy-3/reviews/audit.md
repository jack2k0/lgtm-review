# Real-log audit, status-accuracy-3 (2026-10-26)

Owner's 5 local projects, `node scripts/audit/compare.mjs` (independent truth, `scripts/audit/truth.py` with the phase 6 fixes), counts only. PRE = main 08f8244, POST = this branch at 6f731ab. Rows = tool prompts joined with truth (164; 131 without Agent calls), "unique" counts a prompt uuid once.

| Build | A status (unique) | B status (unique) | C status |
|---|---|---|---|
| PRE (main) | 74.0% (76.7%) | 68.9% (70.5%) | 48.5% |
| phases 1-3 | 85.5% (87.1%) | 83.5% (84.6%) | 75.8% |
| phases 1-3, 5 + truth fixes | 94.7% (96.6%) | 94.5% (96.0%) | 93.9% |
| after review round 1 (fail closed, narrow safe list) | 87.8% (88.8%) | 85.4% (85.9%) | 75.8% |
| **final (safe list widened, round 2 fixes)** | **90.8% (92.2%)** | **90.2% (91.3%)** | **87.9%** |

- PRE→final status transitions over 159 own prompts: 28 unchecked→checked, 7 unchecked→no-changes, 3 checked→no-changes, 1 checked→unchecked, 1 failing→checked, 1 failing→unchecked (manual adjudication rounds 1-2 found no regression caused by the tool; the reviewed fail-closed rules cost about 4 points against the optimistic version).
- The >= 97% target is NOT reached. Remaining 16 status disagreements (B): 11 in mixed git + edit commands where a segment is opaque (cp, rm, scripts, interpreters) and the tool keeps main's conservative all-plain attribution; 3 depend on owner questions (late background checks without a notification; a signal-killed command; git-only merge prompts as no-changes); 2 unexplained.
- Next lever (owner decision): accept per-file git attribution for more opaque segments (e.g. `cp`/`rm` with resolved targets as plain edits), or decide the owner questions in `context/ORCHESTRATION.md`.
