# Findings: change/map-fingerprint

Tier Medium (cli map, core map-extract). Source: OpenCode read-only import-map review, findings 1-3 accepted (1 verified by Opus: the fingerprint hashed only tsconfig/package.json/pnpm-workspace files), 4 deferred. Implementer: OpenCode (GLM-5.3-Flash; lost its context once, re-briefed). Pre-merge review: Opus, diff-only. Tests for fixes 1 and 3 fail on the old code; fix 2 keeps output identical (existing tests) and has a perf test. pnpm check exit 0 (Node 22).

reviewers: opus

| # | Tag | file:line | Finding | Reviewer | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|
| 1 | Nit | packages/core/src/map-extract.ts:292 | a `baseUrl` set only in the extending config should also anchor `paths` declared in the extended base (TypeScript takes the effective `baseUrl`) | opus | deferred | rare layout; current change only fixes the no-`baseUrl` case it was asked to |
