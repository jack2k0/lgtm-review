# Findings: change/status-accuracy-5

Tier High (status rule). Implementer: Sonnet (subagent; Grok stopped at its usage limit before writing code). Reviewers: Haiku (subagent), Opus. One round. Real-log audit: reviews/audit.md (B 97.5% -> 84.8%, all 20 changes cautious; 14 from the owner's Q3 decision, 6 from R3).

reviewers: haiku, opus

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | Pre-existing | packages/core/src/shell-edits.ts:1749 | unquoted heredoc bodies are stripped before R1, so a substitution inside one is not seen | haiku | same on main | deferred | round 6 (heredoc expansion) |
| 2 | Pre-existing | packages/core/src/shell-edits.ts:329 | R2 surface list misses `posix`, `_posixsubprocess`, `execv`, dict-built `__import__` | haiku | same on main | deferred | round 6 (heredoc python: consider an allow-list or always opaque) |
| 3 | Pre-existing | packages/core/src/shell-edits.ts:1300 | a `case` pattern `)` inside a substitution closes the body early | haiku | same on main | deferred | round 6 |
| 4 | Nit | packages/core/src/shell-edits.test.ts | seq test asserted only `not.toBe(true)` | haiku | — | fixed | test now asserts opaque falsy and no edits |
| 5 | Pre-existing | packages/core/src/shell-edits.ts:1251 | an apostrophe in a heredoc body (prose) opens a single quote in substitutionBodies and hides a later substitution | opus | same on main | deferred | round 6 (scan heredoc bodies separately) |
