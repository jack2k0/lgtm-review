# Review findings: rule-files-split

reviewers: haiku, opus

Proof of no behaviour change, by Opus: a line-multiset comparison with main shows one comment lost and only import/export lines added; 2209 commands taken from the test files give identical `classifyCommand` and `classifyShellMutation` results on both builds; `scripts/audit/compare.mjs --json` on the real logs is identical (195 rows, aggregates only). Haiku: no import cycles, no `node:` import in new files, all public names still exported.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Nit | packages/core/src/shell-edits.ts:8 | a doc comment stayed above the re-export block | haiku | opus | rejected | cosmetic; keeping the slice move-only |
| 2 | Nit | packages/core/src/shell-edits-dir.ts:12 | two imports from one module | haiku | opus | rejected | cosmetic; keeping the slice move-only |
