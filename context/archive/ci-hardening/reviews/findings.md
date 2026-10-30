# Review findings: ci-hardening

reviewers: haiku, opus

The workflows have not run on GitHub yet: they run on the owner's next push. Locally: `pnpm check`, `pnpm lint` (0 errors, 150 warnings), `test:coverage` and the audit pass.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | .gitignore | coverage output was not ignored, so `git add -A` would commit it | opus | run | fixed | gate scope failure gone |
| 2 | Important | .github/workflows/ci.yml | gate job without `--plan` skips scope, and it treats any manifest or schema change as a failure | haiku | opus: scripts/gate.mjs read | fixed | the job passes the branch's plan when there is one; label changes fail with or without a plan, so the report's "only up-to-date and committed" was too broad |
| 3 | Nit | .github/workflows/ci.yml:32 | `pnpm lint` added to the `check` job runs on both Node versions | haiku | opus | rejected | costs seconds; plan item 1 asks CI to run it |
