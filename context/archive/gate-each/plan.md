# gate-each: removed-expectations sees test.each table rows

The `removed-expectations` check in `scripts/gate.mjs` said "none removed" on commit `21416d7` (status-accuracy-12) even though three rows of a `test.each([...])` table were deleted from `packages/core/src/shell-edits.test.ts`. `EXPECT_RE` only looked for `expect(`, `assert`, `it(`, `test(`, or `^\s*\[`, missing table rows like `"echo hi 2> err.txt",`. This check is a main safeguard (AGENTS.md: never change or delete an existing test expectation), so it must fail closed.

## Rules
- E1: A removed line in a test file counts when it matches `EXPECT_RE` OR lies inside a parameter table of `test.each` / `it.each` / `describe.each` (any of `.each([`, `.each```, `.each(` with an array/table argument) in the OLD version of the file (`git show <base>:<path>`), not from the diff alone. Determine table extent from the old file.
- E2 (fail closed): When unsure (cannot read the old file, unbalanced brackets/quotes, cannot find where the table ends), count EVERY removed non-blank, non-comment line of that file.
- E3: A removed line that is re-added byte-identical (after trim) in the same file in the same diff is a move, not a removal (keeps reorders quiet). Do NOT treat an edited row as a move.
- Keep output format, the EYES verdict, and every other check unchanged.

## Gate
```gate
allow: ^scripts/gate(\.test)?\.mjs$
allow: ^context/(changes|archive)/gate-each/
labels: none
deps: no
schema: no
```

## Phase 1 (E1, E2, E3)
- Unit tests in `scripts/gate.test.mjs` using `node:test` (no new deps; run with `node --test scripts/gate.test.mjs`):
  1. Exact sa12 diff shape (rows deleted from `test.each` table -> 3 removals; fails on old code).
  2. `it.each` with template-literal table (row deleted -> removal).
  3. Row moved within the table (0 removals).
  4. Row edited (counted as removal).
  5. Removed `expect(` line still counted.
  6. Removed plain helper line outside any table not counted.
  7. Unreadable old file -> fail closed (helper line counted).
  8. Check against real history: running the new logic on diff `21416d7^..21416d7` reports the 3 rows.
- Implementation in `scripts/gate.mjs`:
  - `findTableLines(content)` parses the old file to locate line ranges of `.each(...)` / `.each`...`` tables, tracking bracket / quote balance, and returns `{ lines: Set<number>, unsure: boolean }`.
  - `removedLines(diff, getOldFile)` accepts `getOldFile` resolver, identifies moves (byte-identical after trim in same file), checks old file table lines, and applies E1/E2 fail-closed.
- Done: `node --test scripts/gate.test.mjs` green; `corepack pnpm check` green; `node scripts/gate.mjs --base main --plan context/changes/gate-each/plan.md --run-check` exit 0/2.

## Review fixes
- F1: `.each(` with named array resolves same-file `const|let <name> = [` table extent, else fails closed.
- F2: E3 moves are scoped to the same enclosing unit (same table or same `test`/`it` block by title).
- F3: Diff headers are parsed only at `diff --git` boundaries; comment skip applies only on E2 fail-closed path.
- F4: Backslash newline continuations in template and string scanners advance the line counter.
- F5: Removed commented expectations matching EXPECT_RE are reported (EXPECT_RE checked before comment skip).
