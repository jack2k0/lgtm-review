# pnpm check in a shallow clone; duplicate lint step in CI (script-tests-in-check ledger #1, #2)

## Cause

1. `scripts/gate.test.mjs` Case 8 runs `git diff 21416d7^ 21416d7`. In a shallow local clone that history is missing, so `pnpm check` fails with a raw git error that says nothing about the cause.
2. `.github/workflows/ci.yml`, job `check`, runs `pnpm lint` and then `pnpm check`, which already starts with `eslint .`.

## Phase 1

Files: `scripts/gate.test.mjs`, `.github/workflows/ci.yml`.

1. `scripts/gate.test.mjs`: Case 8 is skipped through the `node:test` `skip` option only when both hold: the history is missing, and `process.env.CI` is not set. The history check is `git rev-parse --verify --quiet "21416d7^^{commit}"` through `execFileSync` with fixed arguments, in a small helper that returns false on a non-zero exit (stdio must not print git's error). The skip message says: commit 21416d7 is missing, this looks like a shallow clone, run `git fetch --unshallow` to run this test. In CI the test always runs, so a missing `fetch-depth: 0` still fails loudly. Do not change the test's name, body or assertions.
2. `.github/workflows/ci.yml`, job `check` only: delete the step `- run: pnpm lint`. Keep `pnpm audit` and `pnpm check`, and keep the root `lint` script.

## Non-goals

`scripts/gate.mjs`, `package.json`, other tests, other CI jobs, `fetch-depth`, lint warnings.

## Gate
```gate
allow: ^scripts/gate\.test\.mjs$
allow: ^\.github/workflows/ci\.yml$
allow: ^context/(changes|archive)/shallow-clone-check/
deps: no
schema: no
```
