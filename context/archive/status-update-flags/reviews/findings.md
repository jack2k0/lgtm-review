# Review findings: status-update-flags

reviewers: haiku, opus

Implemented by OpenCode. Real logs (aggregates only): status audit byte-identical to `main`; differential on 4487 unique commands: 0 `isCheck` and 0 `opaque` changes, so the rule is proven by tests and probes only.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Minor | packages/core/src/check-patterns-classify.ts:357 | `npm --prefix -u test` is not a check, because `-u` is read as a flag although it is the option's value | haiku | opus: read | deferred | needs a directory named `-u`, 0 uses in real logs; the error side is the safe one, no false `checked` |
