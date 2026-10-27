# Findings: change/play-fixes

Tier High (cli API/map). Source: Agy read-only Play review, findings 1-3 accepted (verified by Opus), 4 rejected (same as web review 1), 5-6 deferred (Nits). Implementer: Agy (Gemini 3.8 Flash; OpenCode ran out of its daily limit before starting). Pre-merge review: Opus + Sonnet subagent; Sonnet checked per-file diff merging (`diffFor`), moved imports, Python relative imports, symlinked --dir and the session-wide union. New tests fail on the old code (2 tests; the map test holds the reformat and playable assertions). pnpm check exit 0 (Node 22). Opus withdrew a wording note for the truncation message: an existing test pins it and it stays true.

reviewers: opus, sonnet

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Nit | packages/cli/src/map.ts:401 | an import added in one edit and reformatted in a later edit of the same prompt is hidden (merged "-" set) | sonnet | opus: confirmed by reading diffFor merge | deferred | rare false negative; per-file merge is by design |
| 2 | Nit | packages/cli/src/map.ts:415 | TS and Python branches duplicate the remove-then-add logic | sonnet | opus: agreed | deferred | style only |
