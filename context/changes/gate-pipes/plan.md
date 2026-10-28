# gate-pipes: ledger cells may contain `|`

`scripts/gate.mjs --merge` splits ledger rows on every `|`, so a finding text with `||` or a backticked `|` shifts the columns and the verdict reads as empty (status-accuracy-4, rows 24 and 30; worked around by rewording). Fix at the source.

```gate
allow: ^scripts/gate\.mjs$
allow: ^packages/cli/src/gate\.test\.ts$
allow: ^REVIEW\.md$
allow: ^context/(changes|archive)/gate-pipes/
labels: none
deps: no
schema: no
```

## Phase 1
- Row parsing: a `|` inside backticks, or escaped as `\|`, is not a column separator. The verdict column is located by position from the row's END (the table has a fixed 8 columns: #, Tag, file:line, Finding, Reviewer, Cross-check, Verdict, Evidence) so extra separators in the Finding text cannot shift it; a row whose column count cannot be reconciled is reported as malformed (FAIL with the line number), never as "verdict empty".
- REVIEW.md: one sentence in the ledger format section: escape a literal pipe as `\|` or keep it in backticks.
- Tests in `packages/cli/src/gate.test.ts`, failing on main: a row with `` `||` `` in Finding and verdict `fixed` -> PASS; a row with `a \| b` -> PASS; a row with an unescaped `a || b` in Finding -> PASS (end-anchored); a row with only 5 cells -> malformed FAIL naming the line.
- Done: `pnpm check` green; gate exit 0/2.
- [ ] Phase 1 done
