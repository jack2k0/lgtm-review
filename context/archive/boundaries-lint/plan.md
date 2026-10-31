# Enforce AGENTS.md boundaries with ESLint; mark PROPOSAL as historical (review B6, B7)

## Cause

1. AGENTS.md says `packages/core/src` outside `src/node/` and `src/testing/` imports nothing from `node:`, and that git goes only through `execFile`/`spawn`. Only review enforces this. `eslint.config.mjs` has no such rule, although `pnpm check` runs ESLint since `ci-red-fix`. Current code has no violation outside test files.
2. `docs/PROPOSAL.md` still says `npx strata` and `@strata/*`. It is the dated seed of the PRD, so rewriting its 34 mentions would falsify history. It needs a clear label instead.

## Phase 1

Files: `eslint.config.mjs`, `packages/core/src/boundaries.test.ts` (new), `docs/PROPOSAL.md`.

1. `eslint.config.mjs`, all new rules at level `error`, all with `ignores` for `**/*.test.{ts,tsx,mjs}` and `**/*.perf.test.ts`:
   - `packages/core/src/**` except `packages/core/src/node/**` and `packages/core/src/testing/**`, plus `packages/web/src/**`: `no-restricted-imports` bans every Node builtin, both `node:x` and bare `x` (build the list from `builtinModules` of `node:module`). The same files ban `@lgtm/core/node` and any other subpath the core package exposes for its Node code (read `packages/core/package.json` exports). `no-restricted-syntax` bans dynamic `import("node:...")`. The messages cite AGENTS.md.
   - `packages/cli/src/**`, `packages/core/src/node/**`, `packages/core/src/testing/**`, `scripts/**`: `no-restricted-imports` bans `exec` and `execSync` from `node:child_process` and `child_process`.
   - ESLint replaces a rule when a later block sets it for the same file, so make sure no file needs both blocks in a way that drops one. Do not change or relax any existing rule or the existing `ignores`.
2. `packages/core/src/boundaries.test.ts`: run the repo's real config through the `ESLint` class (`cwd` = repo root, `lintText` with a virtual `filePath`) and read `ruleId` from the messages. `eslint` resolves from the root `node_modules`; do not change a manifest. Cases:
   - error: `packages/core/src/x.ts` with `import "node:fs"`, with `import "fs"`, with `await import("node:fs")`; `packages/web/src/x.tsx` with `import "node:path"`; web importing the core Node subpath; `packages/cli/src/x.ts` and `scripts/x.mjs` with `import { exec } from "node:child_process"`, and with `execSync`.
   - no such error: `packages/core/src/node/x.ts` with `import "node:fs"`; `packages/core/src/testing/x.ts` with `import "node:fs"`; `packages/core/src/x.test.ts` with `import "node:fs"`; `packages/cli/src/x.ts` with `import { execFile } from "node:child_process"`.
3. `docs/PROPOSAL.md`: set the frontmatter `status:` to `historical (superseded by context/foundation/prd.md)`. Directly under the frontmatter add one blockquote, in Polish like the document: this is the historical proposal from 2026-10-22, "Strata" was the working name, the product is now `lgtm-review`, the commands and package names below are not current, and the current sources are `context/foundation/prd.md` and `README.md`. Change nothing else in the file.

## Non-goals

Editing AGENTS.md, banning `shell: true`, lint warnings, package manifests, CI, any product code. If a real violation shows up outside tests, stop and report it; do not exempt it and do not change it.

## Gate
```gate
allow: ^eslint\.config\.mjs$
allow: ^packages/core/src/boundaries\.test\.ts$
allow: ^docs/PROPOSAL\.md$
allow: ^context/(changes|archive)/boundaries-lint/
deps: no
schema: no
```
