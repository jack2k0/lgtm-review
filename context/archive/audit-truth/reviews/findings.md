# Findings: change/audit-truth

Tier Medium (scripts/audit/**). Implementer: Sonnet. Manual adjudication of the measurement: Sonnet (separate agent). Code review: Haiku. One round.

reviewers: haiku

| # | Tag | file:line | Finding | Reviewer | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|
| 1 | Important | scripts/audit/truth.py:975 | `--out` accepted a path inside the repo (private ids could be committed) | haiku | fixed | refuses with exit 2; audit.test.mjs "refuses --out inside the repository" fails on the old code |
| 2 | Nit | scripts/audit/truth.py:976 | `--out` file created with the umask mode | haiku | fixed | created 0600; same test |
| 3 | Nit | scripts/audit/compare.mjs:182 | missing projects dir crashed with a stack; missing python3 printed "exit null" | haiku | fixed | clean message, exit 2 |
| 4 | Important | scripts/audit/truth.py | masked-exit evidence matched expected-failure output | adjudication | fixed (6d8b2c5) | fixture case "went RED (exit 1)" |
| 5 | Important | scripts/audit/truth.py | subagent events ordered by file, not time | adjudication | fixed (6d8b2c5) | fixture case with two concurrent subagents |
