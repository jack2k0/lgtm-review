# S-31 option A: Linux and macOS only; macOS test expectation

Owner decisions (2026-10-31): option A of S-31, and the expectation in `worktrees.test.ts:75` may change. The owner also named the removal of the win32 branch in `open.ts`, so its test case goes with it.

## Cause

`windows-latest` has 15 failing tests and nobody has run the product on Windows. On macOS, `worktrees.test.ts:75` hard-codes `../../elsewhere/wt`, which depends on the depth of the temp directory (`/private/tmp/...` adds a level).

## Phase 1

Files: `.github/workflows/ci.yml`, `packages/cli/src/open.ts`, `packages/cli/src/open.test.ts`, `packages/core/src/node/worktrees.test.ts`, `README.md`, `packages/cli/README.md`.

1. `ci.yml`, job `other-os`: `os: [macos-latest]` only. Keep `continue-on-error` and its comment; the job must first prove itself green on GitHub.
2. `open.ts`: remove the `win32` line in `openCommand`. `open.test.ts`: remove only the win32 case at line 22.
3. `worktrees.test.ts:75`: compute the expected worktree label with `relative(<the main directory of this test>, "/elsewhere/wt")` from `node:path`, in place of the hard-coded string. Read the test and `sessionRoots` to pick the same base directory the code uses. Everything else in the expectation stays.
4. Both READMEs: one plain sentence in the install or requirements section saying Linux and macOS are supported and Windows is not.

## Non-goals

`process.platform === "win32"` guards in `archive.ts` and in tests, redaction of Windows paths, `engines`/`os` in manifests, other tests. No other test expectation changes.

## Verify

`TMPDIR=$(mktemp -d)/a/b/c` (created first), then the core test for `worktrees.test.ts` must pass; on `main` the same run fails.

## Gate
```gate
allow: ^\.github/workflows/ci\.yml$
allow: ^packages/cli/src/open(\.test)?\.ts$
allow: ^packages/core/src/node/worktrees\.test\.ts$
allow: ^README\.md$
allow: ^packages/cli/README\.md$
allow: ^context/(changes|archive)/linux-macos-only/
deps: no
schema: no
```
