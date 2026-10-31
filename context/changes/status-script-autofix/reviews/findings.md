# Review findings: status-script-autofix

reviewers: haiku, opus

Implemented by OpenCode, taking over Agy's uncommitted work after its quota ran out. Real logs (aggregates only): status audit identical to `main` when run back to back (an earlier difference was one new row from the live session); differential on 4479 unique commands: 0 `isCheck` and 0 `opaque` changes, so no real command uses these forms yet and the rule is proven by tests and probes only.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Minor | packages/core/src/check-patterns-classify.ts | `pnpm - lint --fix` stays a check, because `-` is taken as the script name | haiku | opus: read | deferred | not a realistic command; 0 uses in real logs |
