# Honest `checked`: autofix, file scope, relative gate `cd` (S-24)

## Causes (reproduced)

1. A session with an Edit and then `pnpm eslint --fix .` is `checked`. `classifyCommand` says `isCheck: true` for `eslint --fix` and `biome check --write`; `isExcludedForm` (`packages/core/src/check-patterns.ts:878`) only knows `ruff --fix` and `deno lint --fix`.
2. `scopeCovers("/repo/packages/core/src/node/lines.ts", "/repo/packages/core/src/text/lines/formatter.ts")` is `true` (`packages/core/src/scope.ts:146`), contradicting `scope.test.ts:82`: a non-test file only covers itself.
3. `classifyShellMutation("cd ../lgtm-review-x && node scripts/gate.mjs --base main && git merge --no-ff change/x", null, ["/home/jack/git/lgtm-review"])` is `opaque: true`; the absolute `cd` form is `opaque: false` (`packages/core/src/shell-edits.ts:1356`).

## Phase 1

Files: `packages/core/src/check-patterns.ts`, `check-patterns.test.ts`, `scope.ts`, `scope.test.ts`, `shell-edits.ts`, `shell-edits.test.ts`, `analyze.test.ts` (all under `packages/core/src/`), and `scripts/audit/compare.mjs`, `scripts/audit-status.mjs`.

Tests first; each must fail on main.

1. `isExcludedForm` also excludes `eslint` with `--fix` or `--fix-type…`, and `biome` with `--write`, `--fix`, `--apply`, `--apply-unsafe`, or `--unsafe`, direct and through a package manager (`pnpm`, `npx`, `yarn`, `bun`). `eslint .`, `eslint --fix-dry-run .` and `biome check .` stay checks. End-to-end in `analyze.test.ts`: Edit then `pnpm eslint --fix .` is not `checked`.
2. `scopeCovers`: the directory-segment rule on the last line applies only to roots that are not files with an extension, or are test roots as they are today. Existing expectations stay as they are.
3. `isGateScript`: a relative `cd` starting with `../` is resolved against each repo root and accepted only when `gateDirTrusted` accepts the result, then checked with `isScriptsGateFile`. `cd ../other-repo && node scripts/gate.mjs` and `cd ../lgtm-review-x/sub && node scripts/gate.mjs` stay opaque.
4. The two audit scripts call the CLI with `--raw`: `--list --json` redacts by default since S-23, and they classify reason text. They still print aggregates only.

If an existing expectation or label disagrees, do not edit it: stop and report. Never open `~/.claude/projects`; the orchestrator runs the real-log audit.

## Non-goals

Other linters and formatters, redaction, other scope rules, new statuses, schema.

## Gate
```gate
allow: ^packages/core/src/(check-patterns|scope|shell-edits|analyze\.test)(\.test)?\.ts$
allow: ^scripts/audit/compare\.mjs$
allow: ^scripts/audit-status\.mjs$
allow: ^context/(changes|archive)/status-autofix/
deps: no
schema: no
```
