# Findings: change/archive-consistency

Tier High (node/archive, discovery). Source: Agy read-only archive review: 1, 2, 4, 5, 6, 7, 8 accepted, 3 rejected (lgtm-review is unpublished and the owner has no archive, so no archive under the old dir names exists). Implementer: Agy (Gemini 3.8 Flash). Pre-merge review: Opus + Sonnet subagent (checked size on every SessionFile path, ETag/cache re-stat of the archived path, subagent name pattern vs node/subagents.ts, up-to-date metas counted as copied). New tests fail on the old code 6/6 (the 7th test change only adds a meta file to the symlink-safety input). pnpm check exit 0 (Node 22). Changed inputs of existing tests, expectations unchanged: "live wins" now writes a live file larger than the archive (rule change by design); the invalid-ids test uses `bad@1`/`bad#2` because dotfiles are now skipped silently; the symlink-safety test writes the transcript's meta because a lone transcript is no longer archived.

reviewers: opus, sonnet

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Nit | packages/core/src/node/discover.ts:178 | across roots, a live copy in a later root still replaces an earlier archived entry, even when that entry is the larger copy of a damaged live log | sonnet | opus: confirmed by reading discoverRootSessions | deferred | needs the same session id live in two worktree roots; not seen |
| 2 | Nit | packages/core/src/node/discover.ts | `archived` badge now also shows for sessions that exist live but are served from the larger archived copy | sonnet | opus: agreed, intended | rejected | matches the damaged-live-log rule; field doc stays accurate |
