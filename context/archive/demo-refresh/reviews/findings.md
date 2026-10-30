# Review findings: demo-refresh

reviewers: haiku, opus

Owner: Haiku reviews; the orchestrator (opus) is the second check (read the diff; fixed row 1 with a test that failed before). Haiku rebuilt the demo twice from a clean archive: byte-identical, equal to the committed file, banner 2026-03-02.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Nit | packages/cli/src/export.ts:75 | the cap compared ms with 8.64e12, so a valid epoch after ~2243 fell back to today | haiku | opus: test "a date after year 2243" failed before | fixed | cap is now 8.64e15 ms |
| 2 | Pre-existing | docs/demo/index.html | title change ("...our p" to "...our") comes from the word-boundary rule already on main; the committed demo was stale | haiku | opus: expected refresh | rejected | intended by this change |
