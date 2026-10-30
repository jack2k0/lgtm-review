# One session-analysis path and a smaller `main()` (S-28)

## Cause

`packages/cli/src/cli.ts` has the same load-repo-scripts, analyse, mark-archived, mark-worktree loop twice (in `summary` and at the end of `main`); `main` itself is about 260 lines; `realResolve` and `isInside` are copied in `cli.ts` and `llm.ts`.

## Phase 1: refactor, no behaviour change

Files: `packages/cli/src/cli.ts`, `packages/cli/src/llm.ts`, `packages/cli/src/sessions.ts` (new), `packages/cli/src/paths.ts` (new).

1. `paths.ts` exports `realResolve` and `isInside`. `cli.ts` and `llm.ts` import them; if the two copies differ, stop and report the difference.
2. `sessions.ts` exports `analyzeSessions(files, dir, onError)`: per-root `loadRepoScripts` cache, `analyzeFile`, `archived` and `worktree` flags. `summary` and the `--list`/`--json` branch use it. Warning text and which sessions warn stay exactly as they are: `summary` warns only for sessions in its pool.
3. `main` splits into `parseCli` (parsing and all flag validation, returning either an exit code or the values), `runArchive`, `runListOrJson`, and a short `main` that dispatches. Order of checks and every message stay the same.
4. `packages/cli/src/api.ts` keeps its own cached path: do not touch it.

No test edits and no new tests needed beyond what already covers this; if a test breaks, the refactor is wrong. `pnpm check` is the proof, including `e2e.test.ts`.

## Non-goals

`api.ts`, `export.ts`, help text, flags, behaviour.

## Gate
```gate
allow: ^packages/cli/src/(cli|llm|sessions|paths)\.ts$
allow: ^context/(changes|archive)/cli-dedupe/
deps: no
schema: no
```
