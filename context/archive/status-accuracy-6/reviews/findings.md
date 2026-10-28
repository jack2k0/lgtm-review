# Findings: change/status-accuracy-6

Tier High (status rule). Implementer: Sonnet (subagent). Reviewers: Haiku (subagent; 40,000-command differential fuzz vs main: every difference is a superset of edits/opacity), Opus. One round. Real-log audit: 0 status changes.

reviewers: haiku, opus

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/shell-edits.test.ts:1095 | H2 apostrophe test and H4 dunder test pass on main although the plan lists them as fixes | haiku | opus: H2 was a false finding of status-accuracy-5 row 5; main already strips heredoc bodies | rejected | no fix existed to test; both kept as regression guards; plan corrected ("Correction after review") |
| 2 | Pre-existing | packages/core/src/shell-edits.ts:658 | `<<\EOF` delimiter not recognised (body not literal; quotes in it can hide commands, result opaque) | haiku | same on main | deferred | round 7; HEREDOC_START_RE also lives in check-patterns.ts |
| 3 | Pre-existing | packages/core/src/shell-edits.ts:2011 | a heredoc nested in a substitution inside an unquoted heredoc body is not followed | haiku | same on main | deferred | round 7 |
| 4 | Nit | packages/core/src/shell-edits.ts:640 | an indented delimiter line ends a plain `<<EOF` body early (bash needs an exact match) | haiku | same on main; result opaque | deferred | round 7 |
| 5 | Nit | context/changes/status-accuracy-6/plan.md | H2 claim had no reproducer on main | haiku | — | fixed | plan "Correction after review" |
