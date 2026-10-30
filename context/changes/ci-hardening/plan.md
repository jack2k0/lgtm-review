# CI hardening (S-26)

## Cause

`.github/workflows/ci.yml` is install, audit and `pnpm check` on Ubuntu. The code has macOS and Windows branches nobody runs, `pnpm lint` has no implementation, there is no coverage figure, and `scripts/gate.mjs` runs only locally, so a rule changed together with its labels goes green.

## Phase 1

Files: `.github/workflows/ci.yml`, root `package.json`, `turbo.json`, `pnpm-lock.yaml`, `eslint.config.mjs` (new), `packages/core/package.json`, `packages/cli/package.json`, `packages/web/package.json`.

1. Lint: add `eslint`, `typescript-eslint` at the root; flat config with `recommended` (not type-checked) over `packages/*/src` and `scripts`, ignoring `dist`, fixtures and `__golden__`. Every rule with an existing violation is set to `warn` with no source edits; `pnpm lint` exits 0 on warnings and non-zero on errors. Each package gets a `lint` script, or the root runs it once, whichever fits `turbo.json`. Not part of `pnpm check`; CI runs `pnpm lint` as its own step.
2. Coverage: add `@vitest/coverage-v8` at the version matching vitest; a `test:coverage` script in core and cli (the perf exclusion stays); a CI job on Ubuntu Node 22 that runs it and uploads the reports with `actions/upload-artifact`. No thresholds.
3. Other systems: a job `other-os` with a matrix of `macos-latest` and `windows-latest` on Node 22 that runs `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm test`, with `continue-on-error: true`, because these systems have never been run. A comment says the flag goes when the job is green.
4. Gate: a job on `pull_request` only, with `fetch-depth: 0`, that runs `node scripts/gate.mjs --base origin/${{ github.base_ref }}`; exit 1 fails the job, exit 2 passes (`|| [ $? -eq 2 ]`).
5. `permissions: contents: read` stays. Existing jobs do not change.

Done when `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm lint`, `pnpm --filter @lgtm/core test:coverage` and the gate pass locally. Report the number of warnings per rule.

## Non-goals

Fixing lint warnings, source edits of any kind, thresholds, pinning actions, release.yml.

## Gate
```gate
allow: ^\.github/workflows/ci\.yml$
allow: ^package\.json$
allow: ^turbo\.json$
allow: ^pnpm-lock\.yaml$
allow: ^eslint\.config\.mjs$
allow: ^packages/(core|cli|web)/package\.json$
allow: ^context/(changes|archive)/ci-hardening/
deps: yes
schema: no
```
