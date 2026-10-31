# Review findings: boundaries-lint

reviewers: opus

Diff read, and a mutation run: with `main`'s `eslint.config.mjs`, 9 of the 13 original test cases fail.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | eslint.config.mjs | A relative `./node/x.js` from core bypassed the ban on `@lgtm/core/node` | opus | test case added | fixed | new case in `boundaries.test.ts`; the plan had not listed it |
| 2 | Minor | eslint.config.mjs | Dynamic `import("fs")` was allowed, only `node:` was matched | opus | test case added | fixed | new case in `boundaries.test.ts`; the plan had not listed it |
