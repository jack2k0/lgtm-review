# Findings: change/export-out-guard

Tier High (export). Source: read-only export review by OpenCode (1 Important: `--out <session log> --force` replaced the log with HTML), verified by Opus in export.ts. Implementer: OpenCode (GLM-5.3-Flash). Pre-merge review: Opus (round 1) + Agy (Gemini 3.8 Flash, round 2, no findings; checked relative paths, missing parent dirs, --out in the repo, missing projectsDir, prefix siblings). New tests fail on the old export.ts 7/8 (the 8th is the positive case). pnpm check exit 0 (Node 22).

reviewers: opus, agy

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Important | packages/cli/src/export.ts:168 | only roots[0]'s archive dir was protected; other worktree roots' project and archive dirs were not | opus | agy: confirmed fixed (all roots collected) | fixed (893f3c9) | test "refuses --out inside another root's archive dir when several roots are read" |
| 2 | Nit | packages/cli/src/export.ts:95 | `rel.startsWith('..')` treated a child named `..foo` as outside | opus | agy: confirmed fixed | fixed (893f3c9) | test "refuses --out inside the projects dir even when the file name starts with '..'" |
