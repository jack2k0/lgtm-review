# Review findings: gate-each

reviewers: haiku, opus

Owner (2026-10-29): Haiku reviews; the orchestrator (opus) is the second check: verified the fix commit 96c4062 by rerunning Haiku's 23-case harness (all previously missed cases now reported), node --test 13/13, and the real-history check (merge 4f936a6 shows exactly the 3 approved rows; a759f85, 277ac51, c0984e9 none removed). No second Haiku round.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | scripts/gate.mjs (table detection) | `test.each(cases)` with a named array was not detected as a table | haiku | opus: harness case N reported 0 before, 4 after | fixed | 96c4062, node:test case |
| 2 | Important | scripts/gate.mjs (E3 moves) | moves were excused per file, so a row or `expect(` moved to another table or test went unreported | haiku | opus: cases Q, R now 1 | fixed | 96c4062, moves only within the same table or test block |
| 3 | Important | scripts/gate.mjs (diff header parse, comment skip) | a removed `-- x` line was read as a file header; `//` lines inside a table were skipped | haiku | opus: cases M3, P2 now 1 | fixed | 96c4062, headers only at `diff --git` |
| 4 | Important | scripts/gate.mjs (template scanners) | a `\` line continuation did not advance the line counter, shifting table ranges | haiku | opus: case L3 now 5 | fixed | 96c4062 |
| 5 | Nit | scripts/gate.mjs (removedLines) | a removed `// expect(...)` line was no longer reported (behaviour change vs main) | haiku | opus: case S now 1 | fixed | 96c4062 |
