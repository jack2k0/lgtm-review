# First CI run: lint error and macOS test (S-26 follow-up)

## Cause

1. `packages/web/e2e/walk.spec.ts:222` has an empty block, a `no-empty` error in `pnpm lint`. S-29 added the file; `pnpm check` and the gate do not run lint, so nothing local caught it.
2. On macOS, `worktrees.test.ts` "labels a subfolder of main as main" fails in `sessionRoots`.

## Phase 1

Files: `packages/web/e2e/walk.spec.ts`, `package.json`, and for the macOS test only the source file behind it (find it from the test) if the cause is in the code.

1. Fix the empty block with a comment saying why the error is ignored, or real handling. Do not relax the lint rule.
2. Root `check` script also runs `eslint .` first, so `pnpm check` and `gate --run-check` catch lint errors locally.
3. macOS test: likely `/tmp` being a symlink to `/private/tmp` (path comparison without realpath). This machine is Linux, so reproduce it with a symlinked temp directory. Fix the code if a real user can hit this; the test expectation is not edited. If it cannot be reproduced on Linux, leave the code alone and say so in the report.

## Non-goals

Windows failures (a separate plan for the owner), lint warnings, `continue-on-error`.

## Gate
```gate
allow: ^packages/web/e2e/walk\.spec\.ts$
allow: ^package\.json$
allow: ^packages/core/src/node/
allow: ^context/(changes|archive)/ci-red-fix/
deps: yes
schema: no
```
