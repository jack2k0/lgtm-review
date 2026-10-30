# Review findings: py-map-strings

reviewers: haiku

Implementation OpenCode (quota ran out during the fix round); review fixes finished by Agy from OpenCode's uncommitted diff. Two Haiku rounds. Round 2: 4 fuzz seeds, 13,027 valid snippets vs CPython 3.14 ast: HEAD 0 missed / 0 invented imports (main 183 / 59); no throw up to 20,000 nesting levels; 1 MB not slower than main.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/map-extract-py.ts (isFstring) | only one prefix char checked: `rf"`/`Rf"` not treated as f-strings (missed and invented imports) | haiku | round 2 repro | fixed | test; fuzz 0 / 0 |
| 2 | Important | packages/core/src/map-extract-py.ts (blankFstringBody, blankField) | escaped backslash ate the closing quote (`f"""C:\\"""`): imports after it lost (regression vs main) | haiku | round 2 repro | fixed | test |
| 3 | Important | packages/core/src/map-extract-py.ts | unterminated field in a triple-quoted f-string dropped back to code state (invented import, regression) | haiku | round 2 repro | fixed | test |
| 4 | Important | packages/core/src/map-extract-py.ts (blankField) | unbounded recursion: RangeError on deep nesting could abort a map build (regression) | haiku | round 2: no throw to 20,000 levels | fixed | depth cap 200, test |
| 5 | Nit | packages/core/src/map-extract-py.test.ts | tests did not cover findings 1-3 | haiku | round 2 | fixed | 4 new tests |
| 6 | Nit | packages/core/src/map-extract-py.ts:79,99 and test:288 | comments said CPython rejects nesting "far below" the cap; the limit is 150 | haiku | opus | fixed | comments corrected |
| 7 | Nit | packages/core/src/map-extract-py.ts:178 | at the cap a closed inner string is reported unterminated (only at >= 200 levels, invalid Python) | haiku | opus: no output difference found | rejected | invalid input only |
