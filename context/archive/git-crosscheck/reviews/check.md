# Check, S-21 git-crosscheck (2026-10-25)

**Browser: not viewed** (no browser tool in the orchestrator session). Owner to-do: Git cross-check link next to Map, both lists, Refresh, the unavailable state.

Covered without a browser: `packages/core/src/node/git.test.ts` (runner, porcelain/log parsers, window, caps, synthetic temp repos), `packages/cli/src/api.git.test.ts` (route, token/Host/Origin as for other routes, ETag), web `git.test.tsx` and `viewmodel` route tests (jsdom). Git paths and notes render as text only. `pnpm check` green on the branch merged with main.
