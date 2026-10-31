# A fixer behind a script name is an edit, not a check

Deferred in `status-autofix` (#3); the owner asked for it on 2026-10-31.

## Cause

`isExcludedForm` in `packages/core/src/check-patterns-classify.ts` recognises `eslint --fix` and `biome --write` only when the tool is named. Probed on `main`: `pnpm lint --fix`, `npm run lint -- --fix`, `pnpm lint:fix` and `turbo run lint -- --fix` give `isCheck: true`, `opaque: false`. A session that edits and then runs one of these gets `checked`, although the command changed files and verified nothing about the result.

## Phase 1

Files: `packages/core/src/check-patterns-classify.ts` and, only if the opaque result does not follow from it, `packages/core/src/shell-edits*.ts`; tests in `packages/core/src/check-patterns.test.ts`, `packages/core/src/shell-edits.test.ts`.

1. Rule, per simple command: the runner is `pnpm`, `npm`, `yarn`, `bun` or `turbo`, and the script is `lint`, `lint:<anything>` or `check`, and an argument is a fixer flag: `--fix`, `--fix=...`, `--fix-type...`, `--fix-only`, `--write`, `--apply`, `--apply-unsafe`, `--unsafe`. Runner options and a `run` word may stand between (`pnpm -r lint --fix`, `pnpm --filter x lint --fix`, `npm run lint -- --fix`, `turbo run lint -- --fix`). Then `isCheck` is false.
2. The script names `lint:fix`, `lint-fix`, `fix:lint` through the same runners are also not checks, with no flag.
3. `--fix-dry-run` stays a check: `npm run lint -- --fix-dry-run` and `pnpm lint --fix-dry-run`.
4. The rule works on one simple command: in `pnpm lint --fix && pnpm test` the test is still a check. `pnpm lint`, `npm run lint`, `pnpm check`, `pnpm test` keep their results.
5. Each such command gives `classifyShellMutation(...).opaque === true`, like `pnpm exec eslint . --fix` already does.
6. Tests that fail on the old code: every form above in the `classifyCommand` tables, the opaque result, and one session through `analyze`: Edit, then `pnpm lint --fix` with exit 0, does not give `checked`.

## Non-goals

`pnpm test -u`, `cargo clippy --fix`, other runners such as `make`, other script names, existing expectations, labels, goldens. If a label, a golden or an existing expectation disagrees, stop and report it; do not adjust it.

## Audit

The orchestrator runs `scripts/audit/compare.mjs` before and after, and a differential on real logs. Do not open `~/.claude/projects`.

## Gate
```gate
allow: ^packages/core/src/check-patterns-classify\.ts$
allow: ^packages/core/src/shell-edits[a-z-]*\.ts$
allow: ^packages/core/src/check-patterns\.test\.ts$
allow: ^packages/core/src/analyze\.test\.ts$
allow: ^context/(changes|archive)/status-script-autofix/
deps: no
schema: no
```
