# Review findings: status-autofix

reviewers: haiku, opus

Status-rule audit, PRE (main) and POST (branch), `scripts/audit/compare.mjs --json`: identical aggregates, no status change on the real logs. Haiku ran a main-vs-branch differential on 79 commands; every difference matched the plan apart from the two below. Opus read the diff.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/core/src/scope.ts:136 | a dotted directory root (`api.v2`) loses the directory-segment rule | haiku | opus: code read | rejected | a path cannot show whether `api.v2` is a file; `keyOf` already treats it as one, and the error only adds a `check-scope` hint; pinned by a new test |
| 2 | Important | packages/core/src/shell-edits.ts:2173 | autofix forms are now `opaque` | haiku | opus: code read | rejected | intended: an autofix writes files the log does not name; pinned by a new test |
| 3 | Pre-existing | packages/core/src/check-patterns.ts | `pnpm lint --fix` still counts as a check, because the fixer is behind a script name | haiku | opus | deferred | not in this diff; open problem in ORCHESTRATION |
