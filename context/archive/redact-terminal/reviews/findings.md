# Review findings: redact-terminal

reviewers: haiku, opus

Opus reviewed the worker's diff and fixed one finding of its own (branch name in `--list`).

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | packages/cli/src/format.ts (formatText) | branch name printed raw in `--list` | opus | test | fixed | test in format.test.ts |
| 2 | Important | packages/cli/src/format.ts (EXEMPT_KEYS) | `startedAt` and `uuid` come raw from the log and skipped redaction | haiku | opus: test | fixed | tests in format.test.ts; normal values stay readable |
| 3 | Pre-existing | packages/core/src/parse.ts:11 | core cuts prompt text at 200 characters before any redaction, so a token across the cut leaves a short prefix | haiku | opus: code read | deferred | also affects `--summary`; not introduced here; tracked in ORCHESTRATION open problems |
| 4 | Nit | packages/cli/src/cli.ts | `--raw` silently ignored with `--json --summary` or `--json --export` | haiku | opus | fixed | now exit 1 |
| 5 | Nit | packages/cli/src/format.ts (formatText) | `--list` relativises worktree paths with `dir` only | haiku | opus | rejected | no leak: user names and home paths are still removed |
| 6 | Nit | packages/cli/src/format.ts | truncation can cut a `[redacted…` marker | haiku | opus | rejected | cosmetic, nothing leaks |
