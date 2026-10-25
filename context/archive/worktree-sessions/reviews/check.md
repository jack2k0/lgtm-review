# Check, S-19 worktree-sessions (2026-10-25)

**Browser: not viewed** (no browser tool in the orchestrator session). Owner to-do: Worktree column, worktree filter combined with Needs attention, session header, map of a worktree session.

Covered without a browser: synthetic git repos with linked worktrees in `packages/core/src/node/worktrees.test.ts` (listing, roots, discovery), `packages/cli/src/worktrees.e2e.test.ts` (list/json/summary/export/archive across worktrees, `--no-worktrees`), `packages/cli/src/api.worktrees.test.ts` (labels, map on the worktree's tree, ETag/304, server without roots), web `viewmodel`/`worktree` tests (routes, filter, column). `pnpm check` green on the merged branch. Real data: the owner's projects dir had no worktree project folders at plan time, so no real-log run.
