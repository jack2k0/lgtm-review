# Perf noise floor and dev minimatch

Owner's approval, 2026-11-02: findings B1 and B4 of `docs/review-2026-11-02.md`.

## Phase 1: B1

In `packages/core/src/redact.perf.test.ts`, `NOISE_FLOOR_MS` goes from 25 to 100. Under load a run measured 33 ms at 1 MB against 3 ms at 256 KB and failed `pnpm check`. Quadratic growth at 1 MB costs far more than 100 ms, so it is still caught; the hard ceiling and the ratios stay.

## Phase 2: B4

`overrides: minimatch: ">=11.0.1"` in `pnpm-workspace.yaml`, lockfile regenerated. `minimatch` reaches only the eslint dev tools; `eslint` asks for `^10.2.5`, so this crosses a major version on purpose. Done when `pnpm audit --audit-level=moderate` is clean and `eslint .` reports the same 101 warnings.

```gate
allow: ^packages/core/src/redact\.perf\.test\.ts$
allow: ^pnpm-workspace\.yaml$
allow: ^pnpm-lock\.yaml$
allow: ^context/(changes|archive)/dev-minimatch/
deps: yes
schema: no
```
