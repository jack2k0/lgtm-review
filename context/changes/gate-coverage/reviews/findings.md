reviewers: opus, haiku

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Important | scripts/gate.mjs:838 | path lists read without `-z`: non-ASCII paths are C-quoted and miss TEST_RE/FIXTURE_RE/LABELS_RE, so removed expectations or changed fixtures pass silently | haiku | opus: confirmed (read) | fixed (bd7e0e1) | `-z` everywhere + `core.quotePath=false` on the `-U0` diff; gate.test.mjs cases `café.test.ts`, `café.jsonl` fail on the old gate | — |
| 2 | Nit | scripts/gate.mjs:889 | every test path in argv; E2BIG on huge sets | haiku | — | rejected | fails closed (exit 1), not a silent pass | — |
| 3 | Nit | REVIEW.md:24 | High row omits `security`, `export-html`, `cli/llm` | haiku | — | fixed (bd7e0e1) | row updated | — |
| 4 | Pre-existing | scripts/gate.mjs:52 | FIXTURE_RE/LABELS_RE cover only the top level of `sessions/` | haiku | — | deferred | no nested fixture dirs exist today | — |

Opus review: round-1 diff read (NUL parsing incl. porcelain renames), no further findings. REVIEW.md change: owner approves at push (High).
