<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Foundation Scaffold (F-01)

- **Plan**: context/changes/foundation-scaffold/plan.md
- **Mode**: Quick (independent reviewer, non-interactive; author Opus, reviewer Sonnet)
- **Date**: 2026-10-23
- **Verdict**: REVISE
- **Findings**: 1 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | FAIL |
| Plan Completeness | WARNING |

## Grounding
7/7 paths ✓ (packages/*/package.json, tsconfig, turbo.json, pnpm-workspace.yaml, no .github, no fixtures), Progress<->Phase consistency ✓, brief<->plan not deeply checked. Two Current State claims are stale (see F2).

## Findings

### F1 — @lgtm/core has no @types/node; Phase 4 breaks `pnpm check` typecheck

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 4 items 3-5 (fixtures.ts, golden.test.ts, fixtures-secrets.test.ts)
- **Detail**: These files use node:fs, node:path, import.meta.url, process. packages/core/package.json has no @types/node (only cli has it), tsconfig.base has lib ES2022 only, and core tsconfig includes `src`, so `tsc --noEmit` will fail with "Cannot find module 'node:fs'". Plan never mentions this.
- **Fix**: Add `@types/node: ^22.0.0` to core devDependencies and `"types": ["node"]` to packages/core/tsconfig.json (index.ts stays free of node: imports; the web package imports core via built dist so it is unaffected). Add to Phase 4 changes and a Progress/verify line (typecheck green).
- **Decision**: PENDING

### F2 — Current State is stale: repo has a commit, `main` branch and remote

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Current State Analysis; Phase 2 manual check; "NOT doing" remote/rename
- **Detail**: `git` shows branch `main`, commit 263ca9a, and origin https://github.com/jack2k0/lgtm-review.git. Plan says no commits, `master`, no remote, and defers CI verification until a remote exists. Phase 2 manual check 2.3 is therefore actionable after push; the "master" trigger is harmless but dead.
- **Fix**: Correct the Current State lines; keep push as orchestrator's job but drop "deferred until remote exists" wording.
- **Decision**: PENDING

### F3 — Phase 1 has no tolerance for vitest 4 / pnpm audit network dependence

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1; Phase 2 (`pnpm audit` as CI gate)
- **Detail**: `pnpm audit` in CI fails the whole matrix whenever a new advisory lands in any dev dependency, unrelated to the PR, making CI flaky/red on main. Also vitest 3->4 under NodeNext/ESM and `toMatchFileSnapshot` (Phase 4) behaviour is assumed, not verified.
- **Fix**: Set `pnpm audit --audit-level=high` (or run audit as a separate non-matrix job) in CI while the local goal stays "zero findings"; note vitest 4 compatibility check in Phase 1 report.
- **Decision**: PENDING

### F4 — Smoke test `tar` / `npx --yes <tarball>` portability

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3
- **Detail**: Relies on system `tar` and npx resolving a local tarball offline-ish; fine on ubuntu/macOS. Also the smoke task does not depend on `typecheck`/`test`, which is fine.
- **Fix**: None required; optionally fail with a clear message when `tar` is missing.
- **Decision**: PENDING
