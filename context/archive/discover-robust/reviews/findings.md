# Findings: change/discover-robust

Tier High (node discovery, cli api). Brief by Opus (discover-robust-brief.md): defaults chosen without the owner, reversible — (1) unreadable live project dir + archive -> archived sessions and a warning; (2) across roots the larger copy wins, equal size live beats archived, else earlier root; (3) discovery warnings printed once per server run to stderr. Sources: agy-discover-review items 5 and 8, archive-consistency ledger row 1. Implementer: Agy (Gemini 3.8 Flash). Pre-merge review: Opus + Sonnet subagent (checked size on every SessionFile, root/worktree/cache consistency in api.ts, root 0 handling, bounded warning set, no session content in the warning). New tests fail on the old code 3/3. pnpm check exit 0 (Node 22).

reviewers: opus, sonnet

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Nit | packages/core/src/node/archive.test.ts:283 | chmod-000 tests fail when run as root (reads are not blocked) | sonnet | opus: confirmed | fixed (root guard commit) | `skipIf(win32 \|\| getuid() === 0)` in archive.test.ts and api.test.ts |
| 2 | Nit | packages/cli/src/api.test.ts:102 | console.error spy filters on `warning:` and cleans up in finally | sonnet | opus: agreed | rejected | not a defect; noted as robust |
