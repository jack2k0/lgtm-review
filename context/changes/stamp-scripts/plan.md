# Repo scripts in the project stamp and cache keys

## Cause Analysis

In `packages/cli/src/api.ts`, the project stamp (`projectStamp`/`versionOf` lines ~186-204) and the per-session analysis cache keys (`cache` in `analysisFor` and `detailCache` in `detailFor`) only include session log path, mtime, size, and `subagentStamp`. They do not include the repo scripts read by `loadRepoScripts(root)` (`package.json`, `Makefile`, and `scripts/`).

Because command classification and prompt statuses depend on these repo scripts (e.g. check scripts like `pnpm verify` or `make ci`), editing `package.json`, `Makefile`, or `scripts/` leaves the project stamp and cache keys identical to their previous values. Consequently:
1. Conditional requests with `If-None-Match` receive stale `304 Not Modified` responses.
2. Even on an uncached request, `analysisFor` and `detailFor` hit their in-memory caches, retaining the old analysis and old statuses until a session log file itself is modified.

Additionally, in `packages/core/src/node/discover.ts`, `PKG_SCRIPTS` was limited to `test, lint, typecheck, check, build`, which are already in `CHECK_SCRIPT_NAMES` in `check-patterns.ts`. Check patterns also support check names like `verify` and `ci` (as tested in `check-patterns.test.ts` with `packageScripts: ["verify"]`); adding `verify` and `ci` to `PKG_SCRIPTS` allows `package.json` scripts named like a check to be extracted and toggle prompt status.

## Rules

1. In `packages/cli/src/api.ts`, compute a cheap fingerprint of the exact inputs `loadRepoScripts` reads for a root directory (`package.json`, `Makefile`, and `scripts/`) using `access(R_OK)` + `stat` (`${st.mtimeMs}:${st.ctimeMs}:${st.size}`).
2. Keep it cheap: no re-reading of file contents beyond `stat`.
3. Fail closed: if a file or directory is unreadable (`EACCES` or non-ENOENT error), return a unique changing value (`err:${Date.now()}:${Math.random()}`) so the stamp changes and never produces a stale hit.
4. Include the repo scripts stamp of all project roots (`opts.dir`, `roots`, and session `f.root`) in `projectStamp(files)` so all project ETags flip on script changes.
5. Include the root's repo scripts stamp in the cache keys of `analysisFor` and `detailFor` so analyses are refreshed on script changes.

## Review fixes

- G1: Revert `packages/core/src/node/discover.ts` to leave `PKG_SCRIPTS` unchanged on main (`["test", "lint", "typecheck", "check", "build"]`). In `packages/cli/src/api.test.ts`, use a script name from `PKG_SCRIPTS` (`check`) rather than modifying core discover logic.
- G2: Include `ctimeMs` in `statFingerprint` (`${st.mtimeMs}:${st.ctimeMs}:${st.size}`). A same-size rewrite with restored `mtime` (e.g. `touch -r` / `fs.utimesSync`) changes `ctimeMs`, invalidating 304 and serving 200 with the new ETag.
- G3: Compute `repoScriptsStamp` once per distinct root per request in `projectStamp` and pass the root stamps map into `allAnalyses`, `detailFor`, and `promptRoute`/`mapRoute`/`playRoute`/`titlesRoute` instead of re-statting across session files.
- Haiku Nits 3 and 5 left as they are per instructions.

## Gate
```gate
allow: ^packages/cli/src/(api|api\.test)\.ts$
allow: ^context/(changes|archive)/stamp-scripts/
deps: no
schema: no
```
