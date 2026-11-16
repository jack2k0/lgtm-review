# git-no-locks (S-35)

Roadmap S-35, finding F7 (verified). NFR: git stays read-only. `git status` refreshes the index stat cache and may take `.git/index.lock`; `--no-optional-locks` (git >= 2.15) turns that off.

## Phase 1 (only phase)

1. `packages/core/src/node/git.ts` `runGit`: call `git --no-optional-locks -C <dir> <args>`. Update its doc comment.
2. `packages/core/src/node/worktrees.ts` `listWorktrees` and `packages/cli/src/map.ts` `listFiles`: add `--no-optional-locks` as the first git argument. Keep their own timeouts, buffers, `cwd` and the injectable `exec`. Do not reroute them through `runGit`.
3. Tests (each must fail on the old code):
   - `packages/core/src/node/git.test.ts`: a temp repo with one committed file; rewrite the file with the same content and bump its mtime (so plain `git status` would rewrite the index). Record `.git/index` bytes and mtime, run `gitCrosscheck` (and `runGit(dir, ["status","--porcelain=v1","-z"])`). Assert bytes and mtime unchanged and no `.git/index.lock`. Verify first that the test fails with the flag removed, and say so in the report.
   - `packages/cli/src/map.test.ts` (or the existing test of `listFiles`): the injected `exec` receives `--no-optional-locks` first.
   - `packages/core/src/node/worktrees.test.ts`: if `listWorktrees` args are not observable, skip; say so.
4. A boundary test is optional: if `packages/core/src/boundaries.test.ts` (or similar) already scans for `execFile("git"`, extend it to require `--no-optional-locks`; otherwise skip.

Done: `pnpm check` green; gate exit 0 or 2 with each item explained.

Non-goals: no other git behaviour change, no new git commands, no API route changes.

```gate
allow: ^packages/core/src/node/(git|worktrees)(\.test)?\.ts$
allow: ^packages/cli/src/map(\.test)?\.ts$
allow: ^packages/core/src/boundaries\.test\.ts$
allow: ^context/(changes|archive)/git-no-locks/
deps: no
schema: no
```
