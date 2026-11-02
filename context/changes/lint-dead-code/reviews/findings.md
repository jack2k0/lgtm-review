# Review findings: lint-dead-code

reviewers: haiku, opus

Implemented by Agy (Gemini 3.8 Flash), 2026-11-02. `eslint .` from 101 warnings to 70. Opus read the whole diff; Haiku checked each rewritten assignment and `read.ts`, and ran the core and cli tests and typecheck. No test expectation changed.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Minor | packages/cli/src/llm.ts:441 | `let timer = undefined` only silences `prefer-const`; same runtime value | haiku | opus: read | deferred | harmless |
| 2 | Minor | packages/core/src/redact.ts:977 | `prefer-const` and `no-useless-assignment` (line 1001) remain in the table code added by `redact-known-leaks` | opus | haiku: n/a | deferred | the plan excludes `redact.ts` |
