# Review findings: release-path

reviewers: haiku, opus

Deviation from the plan: `--tag next` is dropped (finding 2) and the workflow uses `pnpm publish`, not `npm publish` (finding 1).

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | .github/workflows/release.yml | `npm publish` would keep `workspace:*` in the published manifest | opus | code read | fixed | now `pnpm publish` |
| 2 | Important | .github/workflows/release.yml | `--tag next` may leave `npx lgtm-review` without a `latest` version | haiku | opus: code read | fixed | tag removed: the first release is `latest` |
| 3 | Nit | .github/workflows/release.yml:6 | `v*` also matches `vfoo` | haiku | opus | rejected | the tag/version check stops it before publish |
