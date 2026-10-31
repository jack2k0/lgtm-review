# Run the script self-tests in pnpm check and CI

## Cause

`scripts/gate.test.mjs` and `scripts/audit/audit.test.mjs` use `node:test`. No package, root script or workflow runs them, so a broken merge gate or audit script passes `pnpm check` and CI. Both pass when run by hand (13 and 6 tests).

`scripts/gate.test.mjs` reads commit `21416d7` with `git show`. The CI `check` job uses the default shallow checkout, so that test would fail there once wired in.

## Phase 1

Files: `package.json`, `.github/workflows/ci.yml`.

1. Root `check` script: after `eslint .` and before `turbo`, add `node --test scripts/gate.test.mjs scripts/audit/audit.test.mjs`. Change nothing else in the script.
2. `.github/workflows/ci.yml`, job `check` only: give `actions/checkout@v7` the `with: fetch-depth: 0`, as job `gate` already has.

## Non-goals

Any test file or expectation, `scripts/gate.mjs`, the `other-os` job (it stays on `pnpm test`; S-31 is the owner's decision), the redundant `pnpm lint` CI step, lint warnings.

## Gate
```gate
allow: ^package\.json$
allow: ^\.github/workflows/ci\.yml$
allow: ^context/(changes|archive)/script-tests-in-check/
deps: yes
schema: no
```
