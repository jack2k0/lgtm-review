# Review findings: status-accuracy-8

reviewers: haiku, opus

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/check-patterns.ts (parseHeredocStart) | the global `<<` scan treated an arithmetic shift (`x=$((1<<2))`, `(( x = 1 << 2 ))`, `(( x <<= 2 ))`, `let "x = 1 << 2"`) as a heredoc, hiding a later `sed -i` | haiku | opus: verified with bash | fixed | shell-edits.test.ts "sa8 review: an arithmetic << is a shift, not a heredoc" fails without the fix |
| 2 | Nit | packages/core/src/shell-edits.test.ts | `<<'E-1'`, `<<\E-1`, `<<"a b"` tests pass on main although the plan lists them as failing | haiku | opus: the blocks still fail on main via `E'-'1`, `E.x`, `END-1` | rejected | kept as regression guards |
| 3 | Pre-existing | packages/core/src/check-patterns.ts | `# cat <<EOF` in a comment started a heredoc (also on main) | haiku | opus: bash ignores it | fixed | shell-edits.test.ts "sa8 review: << in a comment is not a heredoc" |
| 4 | Pre-existing | packages/core/src/check-patterns.ts | `x=$((a<<b))` started a heredoc on main too | haiku | opus: same cause as row 1 | fixed | fixed by row 1 |
