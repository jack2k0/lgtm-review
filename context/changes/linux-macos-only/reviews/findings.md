# Review findings: linux-macos-only

reviewers: opencode, opus

Removed expectations (gate EYES): both named by the owner's decisions of 2026-10-31. Verified on Linux with a deep `TMPDIR`: `worktrees.test.ts` passes here and fails on `main`. Not yet run on macOS.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Minor | packages/cli/src/open.ts:34 | On Windows `openBrowser` tries `xdg-open`, does nothing and returns `true` | opencode | opus: read | deferred | no crash; Windows is declared unsupported, and the owner asked for this branch to go |
