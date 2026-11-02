# Review findings: dev-minimatch

reviewers: haiku, opus

Implemented by Opus, owner's decision, 2026-11-02. Haiku checked the lockfile, eslint globs under minimatch 11 in a scratch copy, a synthetic quadratic probe and the frozen install. `pnpm audit --audit-level=moderate` clean; `eslint .` 101 warnings on both sides; minimatch reaches dev tools only.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Minor | packages/core/src/redact.perf.test.ts:39 | A quadratic case costing under 100 to 240 ms at 1 MB now passes the scaling check | haiku | opus: read | deferred | accepted by the owner's decision to raise the floor |
