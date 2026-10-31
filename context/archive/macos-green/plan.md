# macOS job: test setup paths and slow-runner timeouts

CI run 41206448166, job `other-os (macos-latest)`: 6 of 671 cli tests fail. No product code is wrong.

## Cause

1. `archive.test.ts` "archive dir inside the repository..." and `api.titles.test.ts` "two CLI runs match...": the setup builds the project dir from the temp path as given, and the CLI looks it up by the real path. On macOS the temp dir is behind a symlink (`/var` to `/private/var`, `/tmp` to `/private/tmp`), so the CLI exits 1 with "no Claude Code sessions found". The `EnvHttpProxyAgent` warning in the titles failure is only the stderr shown as the assertion message; no test counts stderr lines there. Reproduced on Linux with `TMPDIR` pointing at a symlink: exactly these two fail.
2. `api.test.ts` (2 tests) and `e2e.test.ts` (2 tests) hit the default 5 s timeout. The runner is slow: neighbouring tests took 3.7 to 4.5 s and each CLI spawn about 1 s. Timing assertions are not involved.

## Phase 1

1. In the setup of those two tests only, wrap the temp dir: `realpathSync(mkdtempSync(...))`, importing `realpathSync` as other cli tests do. Change nothing else in those tests.
2. Add `packages/cli/vitest.config.ts` with `defineConfig` from `vitest/config` and `test: { testTimeout: 30000 }`, nothing more. Do not change package.json.
3. In `packages/core/src/boundaries.test.ts`, give the outer `describe` `{ timeout: 30000 }`; its first ESLint load took 3955 ms on macOS.

No new tests: the check is the symlinked `TMPDIR` run below plus the macOS job after a push.

## Non-goals

`.github/workflows/ci.yml` (`continue-on-error` stays), product code, any expectation, labels, goldens. If a test still fails for another reason, stop and report it.

## Gate
```gate
allow: ^packages/cli/src/archive\.test\.ts$
allow: ^packages/cli/src/api\.titles\.test\.ts$
allow: ^packages/cli/vitest\.config\.ts$
allow: ^packages/core/src/boundaries\.test\.ts$
allow: ^context/(changes|archive)/macos-green/
deps: no
schema: no
```
