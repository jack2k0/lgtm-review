# Foundation Scaffold (F-01) Implementation Plan

## Overview

Finish the foundation roadmap item F-01 so every later slice (S-01..S-03) is verified the same way: a clean dev audit, CI on Node 22 and 24, a packaging smoke test that proves `lgtm-review` still runs from a packed tarball via `npx`, and a seed corpus of anonymized session fixtures with a golden-test harness. The monorepo itself is already scaffolded and green; this plan does not re-scaffold it.

Planning ran non-interactively on the orchestrator's delegation: no user questions were asked; every decision below is an assumption recorded in the Key Decisions table of `plan-brief.md` and may be overridden at plan review.

## Current State Analysis

- pnpm 11.2.2 workspace + Turborepo, packages `@lgtm/core` (private, zod `Story` stub + 1 vitest test), `lgtm-review` (cli, published, tsup bundle with core inlined), `@lgtm/web` (private, Vite + React). `pnpm check` = `turbo run typecheck test build`, green 9/9 (`context/changes/bootstrap-verification/verification.md`).
- `pnpm audit` today (re-run 2026-10-23): 6 findings, all dev-only:
  - tinypool (2 critical), vitest + @vitest/mocker (3 moderate) — all via `packages/core > vitest@3.2.7`; patched by vitest >= 4.1.12.
  - esbuild (1 low, `>=0.27.3 <0.28.1`, patched `>=0.28.1`) — via `tsup@8.5.1 > esbuild@0.27.7` and `tsup > bundle-require > esbuild` in core and cli. **Not fixed by the vitest bump** (the bootstrap log implied it would be).
- No `.github/` directory, no CI. No git remote, and the repo has no commits yet (everything is untracked on `master`).
- No packaging smoke test. `packages/cli/package.json` has `files: ["dist","README.md","LICENSE"]`, `bin: dist/cli.js`, no runtime dependencies (zod and core are bundled into `dist/cli.js` by tsup — confirmed by inlined zod sources in the current build). `src/cli.ts` prints `lgtm-review 0.0.0`.
- No fixtures, no golden tests. `packages/core/tsconfig.json` includes only `src`. No parser exists (that is S-01).
- `context/foundation/lessons.md` does not exist yet — no prior rules to apply.

## Desired End State

- `pnpm audit` exits 0 (no findings at any severity) on a fresh `pnpm install --frozen-lockfile`.
- `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile`, `pnpm audit`, and `pnpm check` on Node 22 and Node 24.
- `pnpm check` additionally packs `lgtm-review` into a tarball, asserts the tarball's contents, and runs the tarball via `npx` from an empty temporary directory; the run must print `lgtm-review <version>` and exit 0.
- `packages/core/fixtures/sessions/` holds 4 synthetic, anonymized Claude Code session fixtures (JSONL) each with a hand-labelled expected-status file; a golden test runs a pluggable analyzer over every fixture and compares to committed golden files; a secret-scan test fails if any fixture contains secret-like strings or real home paths.

Verify with: `pnpm install --frozen-lockfile && pnpm audit && pnpm check` locally (green), plus the CI run once a remote exists.

### Key Discoveries:

- esbuild finding comes from tsup, not vitest (`pnpm audit` paths: `packages__cli>tsup>esbuild`, `packages__core>tsup>bundle-require>esbuild`) — needs a separate fix.
- `packages/cli/tsup.config.ts:6` `noExternal: ["@lgtm/core"]` + cli having no `dependencies` means the packed CLI is self-contained; the smoke test is what keeps it that way when S-01/S-02 add deps.
- `packages/core/src/index.ts` must stay free of `node:` imports (ORCHESTRATION stack note: schema exported without `node:` imports, web imports core) — fixture helpers that use `node:fs` must never be imported from `index.ts`.
- Record shape for synthetic fixtures: `docs/PROPOSAL.md` §7.1 (fields `type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `message.content` blocks `text` / `tool_use` / `tool_result` with `is_error`, `toolUseResult.structuredPatch`).
- `turbo.json` `test` task has default inputs (all package files), so fixtures under `packages/core/` already invalidate the test cache — no turbo `inputs` change needed.

## What We're NOT Doing

- No session-log parser, status rule, or `Story` schema changes (S-01).
- No real session logs in the corpus; no anonymization tool. Real anonymized sessions are added by S-01 after its log-format spike.
- No npm publish, release workflow, changesets, provenance (post-MVP; manual promotion).
- No lint/eslint setup (`lint` task stays undefined in packages).
- No web tests, no browser smoke test.
- No Windows/macOS CI matrix — ubuntu-latest only.
- No creating the git remote, initial commit or `master` -> `main` rename (orchestrator's job; see Risks in brief).
- No README / CONTRIBUTING changes beyond the fixture-rules README in Phase 4.

## Implementation Approach

Four independent, small phases, each one worker brief, in the order roadmap F-01 lists them. Phase 2 (CI) only calls `pnpm audit` and `pnpm check`, so later phases are picked up by CI automatically without editing the workflow. Phase 3 hooks the smoke test into `pnpm check` through a Turborepo task so ordering (after `build`) is enforced by `dependsOn`, not by script chaining.

## Critical Implementation Details

- **esbuild vs tsup peer range.** Forcing esbuild to `>=0.28.1` crosses a 0.x minor, which tsup 8.5.x may not declare support for. Order of preference: (1) a newer tsup release whose own esbuild range is already `>=0.28.1`; (2) a workspace `overrides` entry pinning esbuild to the patched range, accepted only if `pnpm check` (incl. the cli build output) stays green; (3) only if both fail: `auditConfig.ignoreGhsas` for that single low-severity, dev-only advisory, with a comment naming the GHSA id, the reason, and "revisit when tsup supports esbuild >= 0.28.1". Whatever path is taken, `pnpm audit` must exit 0.
- **npx on a local tarball.** Run `npx` with `--yes` from a fresh empty temp directory (not the repo), so the workspace `node_modules` cannot satisfy imports and a missing bundled dependency fails the smoke test. Clean the temp directory on success and failure.

## Phase 1: Clean dev audit

### Overview

Bump the test runner and resolve the tsup/esbuild finding so `pnpm audit` reports zero findings.

### Changes Required:

#### 1. Core dev dependencies

**File**: `packages/core/package.json`

**Intent**: Raise vitest to a patched release so tinypool, vitest and @vitest/mocker advisories are gone.

**Contract**: `devDependencies.vitest` = `^4.1.12` (or newer 4.x). Existing `index.test.ts` must pass unchanged; if vitest 4 needs a config change, add the minimum (no new `vitest.config.ts` unless required).

#### 2. esbuild advisory

**File**: `packages/cli/package.json`, `packages/core/package.json` (tsup version) and/or `pnpm-workspace.yaml` (`overrides` or `auditConfig`)

**Intent**: Remove the esbuild `<0.28.1` finding using the preference order in Critical Implementation Details.

**Contract**: After the change, `pnpm why esbuild` shows only `>=0.28.1`, or the single GHSA is listed in `auditConfig.ignoreGhsas` with a justification comment. pnpm 11 reads `overrides` / `auditConfig` from `pnpm-workspace.yaml`.

#### 3. Lockfile

**File**: `pnpm-lock.yaml`

**Intent**: Regenerated by `pnpm install`; must be consistent so `--frozen-lockfile` works in CI.

**Contract**: `pnpm install --frozen-lockfile` succeeds with no changes.

### Success Criteria:

#### Automated Verification:

- `pnpm install --frozen-lockfile` succeeds
- `pnpm audit` exits 0 with no findings
- `pnpm check` is green (typecheck, test, build for all packages)
- `node packages/cli/dist/cli.js` prints `lgtm-review 0.0.0`

#### Manual Verification:

- If the `auditConfig.ignoreGhsas` fallback was used, the reviewer accepts the written justification

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 2.

---

## Phase 2: CI workflow on Node 22 and 24

### Overview

Add a GitHub Actions workflow that runs the repo check on both supported Node majors.

### Changes Required:

#### 1. Workflow

**File**: `.github/workflows/ci.yml`

**Intent**: Run the same gate a developer runs locally, on every push and pull request, for Node 22 and 24.

**Contract**:
- Triggers: `push` (branches `main`, `master`) and `pull_request`.
- `permissions: contents: read`; `concurrency` group per ref with `cancel-in-progress: true`.
- One job, `runs-on: ubuntu-latest`, `strategy.matrix.node: [22, 24]`, `fail-fast: false`.
- Steps: checkout -> `pnpm/action-setup` (version taken from root `packageManager`, no hardcoded pnpm version) -> `actions/setup-node` with `node-version: ${{ matrix.node }}` and `cache: pnpm` -> `pnpm install --frozen-lockfile` -> `pnpm audit` -> `pnpm check`.
- Actions pinned to their current major version tag (implementer checks each action's README at implementation time).

### Success Criteria:

#### Automated Verification:

- Workflow YAML parses: `node -e "require('node:fs').readFileSync('.github/workflows/ci.yml','utf8')"` plus `actionlint .github/workflows/ci.yml` when actionlint is installed (skip if not installed, note it in the phase report)
- `pnpm check` still green locally

#### Manual Verification:

- After the orchestrator creates a remote and pushes, both matrix jobs (Node 22, Node 24) are green on GitHub Actions

**Implementation Note**: The manual check is deferred until a remote exists; record it as pending, do not block Phase 3 on it.

---

## Phase 3: Pack + npx smoke test in `pnpm check`

### Overview

Prove on every check that the published package works as an end user runs it: packed tarball, `npx`, no workspace.

### Changes Required:

#### 1. Smoke script

**File**: `scripts/smoke-pack.mjs` (new, plain Node ESM, no dependencies)

**Intent**: Pack `packages/cli`, verify tarball contents, run it via `npx` in isolation, fail loudly on any deviation.

**Contract**:
- Creates a temp dir (`fs.mkdtemp` under `os.tmpdir()`), runs `pnpm pack --pack-destination <tmp>` in `packages/cli`.
- Lists tarball entries (`tar -tzf`) and asserts: contains `package/package.json`, `package/dist/cli.js`, `package/README.md`, `package/LICENSE`; contains no `package/src/` entries and no `.test.` files.
- Asserts the packed `package.json` has no `workspace:` specifier in `dependencies` (devDependencies are ignored by consumers).
- Runs `npx --yes <abs path to tarball>` with `cwd` = a second empty temp dir; asserts exit code 0 and stdout matches `/^lgtm-review \d+\.\d+\.\d+/m`.
- Removes temp dirs in a `finally`; exits non-zero with a one-line reason on failure.

#### 2. Wiring into the check

**File**: `packages/cli/package.json`, `turbo.json`, root `package.json`

**Intent**: Run the smoke script after the cli build as part of `pnpm check`.

**Contract**: cli script `"smoke": "node ../../scripts/smoke-pack.mjs"`; turbo task `"smoke": { "dependsOn": ["build"], "cache": false }`; root `check` = `turbo run typecheck test build smoke`; root script `"smoke": "turbo run smoke"` for standalone use.

### Success Criteria:

#### Automated Verification:

- `pnpm check` is green and its output shows the `lgtm-review#smoke` task passing
- Negative check: temporarily removing `"dist"` from cli `files` makes `pnpm smoke` fail (revert after)

#### Manual Verification:

- Reviewer confirms no temp dirs are left behind after a failing and a passing run

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 4.

---

## Phase 4: Fixture corpus + golden harness

### Overview

Create the seed fixture corpus and the harness S-01 will use to measure the >= 95% status-match criterion and reproducibility, plus a guardrail that fixtures contain no secrets.

### Changes Required:

#### 1. Seed fixtures

**File**: `packages/core/fixtures/sessions/<name>.jsonl` (4 new files)

**Intent**: Small, hand-written synthetic sessions (not copied from real logs) covering each status the S-01 rule must produce, and one tolerance case.

**Contract**: Records follow the `docs/PROPOSAL.md` §7.1 shape. Anonymization rules: `cwd` = `/home/user/project`, `sessionId`/`uuid` = obviously fake UUIDs, `gitBranch` = `main`, no real names, emails, tokens, hostnames. Fixtures:
- `checked-basic` — one prompt: read, edit, passing test command.
- `unchecked-edit-after-check` — one prompt: edit, passing check, another edit.
- `failing-check` — one prompt: edit, Bash check with `is_error: true` and `Exit code 1` output.
- `mixed-unknown-records` — two prompts (one `no-changes`, one `checked`) plus one unknown `type` record and one malformed (non-JSON) line.

#### 2. Hand labels

**File**: `packages/core/fixtures/sessions/<name>.labels.json` (one per fixture)

**Intent**: Ground truth for the status-match metric S-01 will compute.

**Contract**: `{ "fixture": "<name>", "source": "synthetic", "prompts": [ { "index": 0, "expectedStatus": "checked" | "unchecked" | "failing" | "no-changes", "note": "<why>" } ] }`.

#### 3. Fixture helpers

**File**: `packages/core/src/testing/fixtures.ts` (new; never imported from `src/index.ts`)

**Intent**: Shared loader for tests: list fixtures, read JSONL lines, load and zod-validate labels.

**Contract**: `listFixtures(): string[]` (sorted names), `readFixtureLines(name): string[]`, `readLabels(name): Labels`; paths resolved relative to the package via `import.meta.url`. Not exported from the package entry; not bundled (tsup entry is `src/index.ts`).

#### 4. Golden harness

**File**: `packages/core/src/golden.test.ts` (new)

**Intent**: For every fixture, run an analyzer and compare its output to a committed golden file; prove determinism. F-01 ships a placeholder analyzer (record inventory: total lines, malformed-line count, count per `type`, keys sorted) that S-01 replaces with the real analyzer.

**Contract**: Golden files at `packages/core/fixtures/sessions/__golden__/<name>.<analyzer>.json`, compared with vitest `toMatchFileSnapshot` (update via `pnpm --filter @lgtm/core test -- -u`). Each fixture is analyzed twice and both outputs must be identical. Also asserts: every `.jsonl` has a matching `.labels.json` and vice versa; labels parse; analyzer never throws on malformed lines.

#### 5. Secret guardrail

**File**: `packages/core/src/fixtures-secrets.test.ts` (new)

**Intent**: Enforce the PRD guardrail "no secret from test fixtures appears in anything the product outputs" at the source.

**Contract**: Scans every file under `packages/core/fixtures/` and fails on: `sk-ant-`, `sk-[A-Za-z0-9]{20,}`, `ghp_`/`github_pat_`, `AKIA[0-9A-Z]{16}`, `-----BEGIN .*PRIVATE KEY-----`, `(?i)(token|secret|password)\s*[=:]\s*\S{8,}`, `/Users/`, and `/home/` followed by anything other than `user/`. Failure message names file and line.

#### 6. Fixture rules

**File**: `packages/core/fixtures/README.md` (new)

**Intent**: Tell S-01 (and contributors) how to add a fixture: anonymization rules, labels format, how to update golden files.

**Contract**: Under 40 lines.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green; `@lgtm/core` test count includes golden + secret-scan tests
- Golden files exist for all 4 fixtures and `pnpm --filter @lgtm/core test` passes twice in a row without `-u`
- Negative check: inserting `sk-ant-test` into a fixture makes the secret-scan test fail (revert after)
- `grep -r "node:" packages/core/src/index.ts` returns nothing

#### Manual Verification:

- Reviewer reads the 4 labels files and agrees each expected status follows the PRD rule (checked = last check after last edit passed)

**Implementation Note**: After automated verification passes, pause for manual confirmation.

---

## Testing Strategy

### Unit Tests:

- Golden harness and secret scan in `@lgtm/core` (Phase 4).
- Existing `Story parses` test keeps passing after vitest 4 bump (Phase 1).

### Integration Tests:

- Pack + `npx` smoke test of the published CLI (Phase 3), run inside `pnpm check` and therefore in CI.

### Manual Testing Steps:

1. `pnpm install --frozen-lockfile && pnpm audit && pnpm check` on a clean clone.
2. Once a remote exists: push and confirm both CI matrix jobs are green.
3. Read the 4 fixture label files against the PRD Business Logic.

## Performance Considerations

The smoke test adds a pack + `npx` install of a dependency-free tarball (seconds). `cache: false` on the smoke task means it runs every check; acceptable at this size.

## Migration Notes

Not applicable.

## References

- Roadmap item: `context/foundation/roadmap.md` F-01
- PRD: `context/foundation/prd.md` (NFR reproducible statuses, NFR unknown records, Guardrail fixture secrets, Success Criterion >= 95% status match)
- Bootstrap log: `context/changes/bootstrap-verification/verification.md`
- Stack notes: `context/foundation/tech-stack.md`, `context/ORCHESTRATION.md` (Uwagi do F-01)
- Log format: `docs/PROPOSAL.md` §7.1

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Clean dev audit

#### Automated

- [x] 1.1 `pnpm install --frozen-lockfile` succeeds
- [x] 1.2 `pnpm audit` exits 0 with no findings
- [x] 1.3 `pnpm check` is green (typecheck, test, build for all packages)
- [x] 1.4 `node packages/cli/dist/cli.js` prints `lgtm-review 0.0.0`

#### Manual

- [ ] 1.5 If the `auditConfig.ignoreGhsas` fallback was used, the reviewer accepts the written justification

### Phase 2: CI workflow on Node 22 and 24

#### Automated

- [x] 2.1 Workflow YAML parses (actionlint when installed)
- [x] 2.2 `pnpm check` still green locally

#### Manual

- [ ] 2.3 Both matrix jobs (Node 22, Node 24) green on GitHub Actions after a remote exists

### Phase 3: Pack + npx smoke test in `pnpm check`

#### Automated

- [x] 3.1 `pnpm check` is green and shows the `lgtm-review#smoke` task passing
- [x] 3.2 Negative check: removing `"dist"` from cli `files` makes `pnpm smoke` fail (reverted)

#### Manual

- [x] 3.3 No temp dirs left behind after a failing and a passing run

### Phase 4: Fixture corpus + golden harness

#### Automated

- [x] 4.1 `pnpm check` green; core tests include golden + secret-scan tests
- [x] 4.2 Golden files exist for all 4 fixtures and core tests pass twice without `-u`
- [x] 4.3 Negative check: `sk-ant-test` in a fixture fails the secret scan (reverted)
- [x] 4.4 `packages/core/src/index.ts` has no `node:` imports

#### Manual

- [x] 4.5 Reviewer agrees each fixture's expected status follows the PRD rule

## Plan-review amendments (accepted by orchestrator)

- F1 (blocking, Phase 4): add `@types/node` ^22 to `packages/core` devDependencies and `"types": ["node"]` to `packages/core/tsconfig.json`, otherwise typecheck fails.
- F2: Current State is stale. Repo is on `main`, commit 263ca9a, origin `https://github.com/jack2k0/lgtm-review.git` (public). Worktrees and CI are available.
- F3 (Phase 2): CI audit step uses `pnpm audit --audit-level=high` to avoid red CI on new low/moderate dev advisories.
