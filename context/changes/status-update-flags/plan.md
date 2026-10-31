# Snapshot updates and `cargo clippy --fix` are edits, not checks

Open from `status-script-autofix` (non-goal there).

## Cause

Probed on `main`: `vitest -u`, `jest -u`, `pnpm test -u`, `npm test -- --updateSnapshot`, `turbo run test -- -u` and `cargo clippy --fix` give `isCheck: true`, `opaque: false`. A snapshot update rewrites the expected result so the run passes, and `clippy --fix` rewrites source. Neither verifies the edit before it, yet both give `checked`. `playwright test -u` and `cargo fix` are already not checks.

## Phase 1

Files: `packages/core/src/check-patterns-classify.ts`, next to `isScriptAutofix` and reusing its helpers; tests in `packages/core/src/check-patterns.test.ts`, `packages/core/src/analyze.test.ts`.

1. Update flags, exact tokens only: `-u`, `--update`, `--update=...`, `--updateSnapshot`, `--updateSnapshot=...`, `--update-snapshots`, `--update-snapshots=...`.
2. Not a check when a simple command has an update flag and is one of: `vitest` or `jest`, direct or through `pnpm`, `npm`, `yarn`, `bun`, `npx`, `bunx`, including `vitest run`; or a runner (`pnpm`, `npm`, `yarn`, `bun`, `turbo`) with script `test` or `test:<anything>`, including runner options, `run` and `--`.
3. `cargo clippy` with `--fix` is not a check.
4. These stay checks: `pnpm test`, `vitest`, `cargo clippy`, `pnpm test -- --testNamePattern u`, `pytest -u`, `git add -u && pnpm test`. In `pnpm test -u && pnpm test` the second test is still a check.
5. Each such command gives `classifyShellMutation(...).opaque === true`.
6. Tests that fail on the old code: every form above in the tables, the opaque result, and one session through `analyze`: Edit, then `pnpm test -u` with exit 0, does not give `checked`.

## Non-goals

Other tools' update flags, other script names, `pnpm - lint --fix`, existing expectations, labels, goldens. If a label, a golden or an existing expectation disagrees, stop and report it.

## Audit

The orchestrator runs `scripts/audit/compare.mjs` before and after, and a differential on real logs. Do not open `~/.claude/projects`.

## Gate
```gate
allow: ^packages/core/src/check-patterns-classify\.ts$
allow: ^packages/core/src/check-patterns\.test\.ts$
allow: ^packages/core/src/analyze\.test\.ts$
allow: ^context/(changes|archive)/status-update-flags/
deps: no
schema: no
```
