# Foundation Scaffold (F-01) — Plan Brief

> Full plan: `context/changes/foundation-scaffold/plan.md`

## What & Why

Finish roadmap item F-01: clean dev audit, CI on Node 22 and 24, a pack + `npx` smoke test inside `pnpm check`, and a seed corpus of anonymized session fixtures with a golden-test harness. Every later slice (S-01..S-03) is verified against these: fixtures back the >= 95% status-match criterion, and the smoke test proves the CLI still ships as one `npx` command.

## Starting Point

pnpm + Turborepo monorepo (core / cli / web) is scaffolded and `pnpm check` is green. `pnpm audit` shows 6 dev-only findings (5 via vitest 3.x, 1 low via tsup's esbuild). No CI, no smoke test, no fixtures, no git commits or remote.

## Desired End State

`pnpm install --frozen-lockfile && pnpm audit && pnpm check` is green with zero audit findings; `pnpm check` packs the CLI and runs it from a tarball via `npx`; a CI workflow runs the same on Node 22 and 24; `packages/core/fixtures/sessions/` holds 4 labelled synthetic sessions with golden files and a secret-scan guardrail.

## Key Decisions Made

All decided by the orchestrator's delegate without user questions; override at plan review.

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| esbuild finding | Newer tsup -> workspace override -> `ignoreGhsas` (last resort, documented) | vitest bump does not fix it; low, dev-only, but "audit clean" is the F-01 outcome. |
| CI shape | One job, ubuntu-latest, matrix Node 22/24, steps install -> audit -> check | CI calls `pnpm check`, so later phases are covered without editing the workflow. |
| pnpm version in CI | Read from root `packageManager` | One source of truth; no drift between local and CI. |
| Smoke wiring | Turbo task `smoke` (dependsOn build, cache false) in `check` | Ordering enforced by turbo, runs every check. |
| Smoke isolation | `npx --yes <tarball>` from an empty temp dir | Workspace `node_modules` cannot mask a missing bundled dependency. |
| Fixture source | Hand-written synthetic JSONL, 4 files | No real-log secret risk; real anonymized sessions come from S-01's spike. |
| Fixture location | `packages/core/fixtures/sessions/` | Already inside turbo's default test inputs. |
| Golden mechanism | vitest `toMatchFileSnapshot`, placeholder "record inventory" analyzer | S-01 swaps in the real analyzer; harness, labels and determinism check exist now. |
| Labels | `<name>.labels.json` with expected status per prompt | Ground truth for the >= 95% match metric. |
| Secret guardrail | Regex scan test over `fixtures/` | Enforces the PRD guardrail at the source. |

## Scope

**In scope:** vitest bump + esbuild fix + lockfile; `.github/workflows/ci.yml`; `scripts/smoke-pack.mjs` + turbo wiring; 4 fixtures, labels, golden harness, secret scan, fixture README.

**Out of scope:** parser / status rule / Story changes (S-01); real session logs; publish/release workflow; lint setup; web tests; non-Linux CI; creating the remote, first commit, branch rename.

## Architecture / Approach

Four independent phases, each one worker brief. The gate is a single command: `pnpm check` = `turbo run typecheck test build smoke`; CI = install + audit + check on two Node majors. Fixtures live next to `@lgtm/core` tests; `node:`-using helpers stay under `src/testing/` and are never imported by `src/index.ts`, so the browser-safe core entry is unaffected.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Clean dev audit | `pnpm audit` exit 0 | esbuild 0.28 may break tsup 8.5 builds -> fallback to documented ignore |
| 2. CI Node 22+24 | `.github/workflows/ci.yml` | Cannot run until a remote exists; only local YAML lint now |
| 3. Pack + npx smoke | `smoke` task inside `pnpm check` | `npx` on tarball needs network for its own resolution; flaky offline |
| 4. Fixtures + golden | 4 labelled fixtures, golden + secret tests | Synthetic records may drift from the real log format |

**Prerequisites:** Plan review accepted. For worktree-based workers: an initial commit must exist (`git worktree add` fails on a repo with no commits).
**Estimated effort:** ~2 sessions (phases 1-3 small, phase 4 medium).

## Open Risks & Assumptions

- Repo has zero commits and no remote: worktrees for workers and the CI run both need the orchestrator to make the initial commit (and `master` -> `main` rename) first.
- tsup 8.5.x vs esbuild >= 0.28.1 compatibility is unverified; the plan carries a documented fallback.
- Synthetic fixtures are modelled on `docs/PROPOSAL.md` §7.1, not on real logs; S-01 must validate and grow the corpus after its log-format spike.
- Host runs Node 26; local checks do not prove Node 22/24 — only CI does.

## Success Criteria (Summary)

- A clean clone passes `pnpm install --frozen-lockfile && pnpm audit && pnpm check` with zero findings.
- Breaking the package contents (e.g. dropping `dist` from `files`) or adding a secret to a fixture makes `pnpm check` fail.
- S-01 can plug its analyzer into the golden harness and compute status match against the labels without new scaffolding.
