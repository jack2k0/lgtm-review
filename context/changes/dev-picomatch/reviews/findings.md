reviewers: grok-orchestrator, grok-review

findings: none

`picomatch` >=4.0.8 is not on npm (latest 4.0.7, 2026-11-18). The advisory is dev-only (typescript-eslint → tinyglobby/fdir). `auditConfig.ignoreGhsas` is what pnpm 11.2.2 reads; `audit.ignore` is kept for a newer pnpm. `pnpm audit --audit-level=high` exits 0 and still prints "1 high (1 ignored)".
