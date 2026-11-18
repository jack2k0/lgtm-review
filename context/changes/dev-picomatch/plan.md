# dev-picomatch (S-41)

Owner decision 2026-11-18: yes. CI `pnpm audit --audit-level=high` fails on GHSA-fc5q-39xc-vjpf (`picomatch` <= 4.0.7), dev-only via typescript-eslint.

## Phase 1

The advisory GHSA-fc5q-39xc-vjpf says patched versions are `>=4.0.8`. npm has no such release (latest `picomatch` is 4.0.7, checked 2026-11-18), so an override cannot be installed. The finding is dev-only (typescript-eslint → tinyglobby/fdir). `pnpm@11.2.2` reads `auditConfig.ignoreGhsas` (what `pnpm audit --ignore` writes); `audit.ignore` is the newer spelling, kept so a later pnpm still ignores the same id. Delete both and add `picomatch: ">=4.0.8"` next to `minimatch` when that version exists. `npx pnpm@11.2.2 audit --audit-level=high` exits 0. No lockfile change.

```gate
allow: ^pnpm-workspace\.yaml$
allow: ^context/(changes|archive)/dev-picomatch/
deps: yes
schema: no
```
