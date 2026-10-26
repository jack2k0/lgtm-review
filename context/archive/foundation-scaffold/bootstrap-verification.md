# Bootstrap verification

## Hand-off
Stack per context/foundation/tech-stack.md: Turborepo, pnpm workspaces (override of npm), packages core/cli/web.

## Scaffold log
Manual scaffold, no create-turbo. Root: package.json, pnpm-workspace.yaml (allowBuilds esbuild), turbo.json, tsconfig.base.json, .gitignore, .nvmrc, LICENSE (Apache-2.0), README.md.
- packages/core (@lgtm/core, private): zod Story schema, vitest test.
- packages/cli (lgtm-review): bin, tsup bundle (core inlined), LICENSE, README, files set.
- packages/web (@lgtm/web, private): Vite + React, imports core.
No eslint; `lint` script is not defined in packages yet. No git commits made.

## Audit (pnpm audit)
6 findings: 1 low, 3 moderate, 2 critical. All dev-only: vitest, @vitest/mocker, tinypool (via vitest in core, vitest 3.x), esbuild (via tsup). Not shipped. Fix: bump vitest to >=4.1.12.

## Status
`pnpm install` and `pnpm check` (typecheck + test + build) green: 9/9 tasks. `node packages/cli/dist/cli.js` prints "lgtm-review 0.0.0".
