# Review findings: status-accuracy-12

reviewers: haiku, sonnet

Owner-approved option B (2026-10-29): the three no-edit expectations in shell-edits.test.ts (`2> err.txt`, `&> all.txt`, `> "$OUT"`) were changed with the owner's approval. Real-log audit before merge (aggregates only, 164 prompts): 0 status changes, 1 prompt with a changed edited-file count; compare.mjs A/B/C identical to main. OpenCode out of free quota; sonnet is the fallback second reviewer. Two review rounds; the last fix batch (f235cd0) was verified by the orchestrator with tests and probes, no third round.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/shell-edits.ts (redirect section) | `T=$(mktemp); echo > $T` and `${TMPDIR:-/tmp}` targets became false edits under option B | sonnet | haiku: same (Nit 2) | fixed | 2b75b29, tests "sa12 review" |
| 2 | Nit | packages/core/src/shell-edits.ts (redirect section) | dynamic fd-dup `>&$fd` listed as "(shell edit)" | haiku | opus: bash writes nothing for an fd number | fixed | 2b75b29, segment stays opaque |
| 3 | Pre-existing | packages/core/src/check-patterns.ts (splitSegments) | `>|` / `2>|` writes not detected (silent loss) | sonnet | opus: bash writes the file | fixed | 2b75b29, tests |
| 4 | Nit | packages/core/src/shell-edits.test.ts | new tests did not assert `.opaque` | sonnet | opus | fixed | 2b75b29 |
| 5 | Pre-existing | packages/core/src/shell-edits.ts | `(pnpm check) 2>&1 > results.txt` reports the check log as an edit | haiku | opus: same on main, over-report | deferred | round 13 |
| 6 | Pre-existing | packages/core/src/shell-edits.ts (TEMP_PREFIX_RE) | `$S` is scratch by name even when unset | haiku | opus: same on main | deferred | round 13 |
| 7 | Important | packages/core/src/shell-edits.ts (isMktempValue) | round 2: any mktemp args counted as scratch (`-p src`, `--tmpdir=src`, `src/x.XXXX`); segment stayed opaque but the edit was not named | sonnet | haiku: opaque, not fail-open | fixed | f235cd0; orchestrator probes give "(shell edit)" |
| 8 | Nit | packages/core/src/shell-edits.ts (isDirectMktemp) | round 2: direct `"$(mktemp)"` form was dead code | sonnet | opus | fixed | f235cd0; probe `echo > "$(mktemp)"` gives [] |
| 9 | Nit | packages/core/src/check-patterns.ts (splitSegments) | round 2: `echo \>| tee src/a.ts` stayed one segment | sonnet | opus: probe now reports src/a.ts | fixed | f235cd0, test |
| 10 | Nit | packages/core/src/shell-edits.ts | round 2: `local T=$(mktemp)` and `${TMPDIR:=/tmp}` / `${TMPDIR-/tmp}` over-report | haiku | opus: over-report only | deferred | round 13 |
