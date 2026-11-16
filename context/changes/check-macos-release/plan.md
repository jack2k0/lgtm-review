# check-macos-release (S-36)

Roadmap S-36, F8 + F9 (verified). NFR packaging: `pnpm check` green on macOS, and a `v*` tag can publish.

## Phase 1 (only phase)

1. macOS `/var` → `/private/var`: wrap every `mkdtempSync(...)` in `realpathSync(...)` in `scripts/smoke-pack.mjs` and `packages/cli/src/llm.perf.test.ts`. Run `corepack pnpm check` on this Mac and fix any other temp-path mismatch the same way, only in test/scripts setup code; list each.
2. `.github/workflows/release.yml`: the release job runs `pnpm check`, which runs `scripts/gate.test.mjs`; its history case fails on a shallow checkout. Add `fetch-depth: 0` to the checkout step.
3. `.github/workflows/ci.yml` job `other-os` (macOS): replace `pnpm build` + `pnpm test` with `pnpm check`, and add `fetch-depth: 0` to its checkout.
4. No test expectation changes. Done = full `corepack pnpm check` green locally on macOS (quote the last lines) and gate exit 0/2.

Non-goals: no Windows support, no change to product code.

```gate
allow: ^scripts/smoke-pack\.mjs$
allow: ^packages/cli/src/llm\.perf\.test\.ts$
allow: ^packages/[a-z]+/src/.*\.(test|perf\.test)\.ts$
allow: ^scripts/[a-z-]+\.test\.mjs$
allow: ^\.github/workflows/(ci|release)\.yml$
allow: ^context/(changes|archive)/check-macos-release/
deps: no
schema: no
```
