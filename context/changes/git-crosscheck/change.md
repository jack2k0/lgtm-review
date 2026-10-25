---
change_id: git-crosscheck
title: Git cross-check — what git shows for a session's directory next to what its prompts edited
status: planned
created: 2026-10-25
updated: 2026-10-25
archived_at: null
---

## Notes

Roadmap S-21 (v0.3 extension, wave 3, runs in parallel with S-20 status-accuracy-2), PRD v3 FR-019 and the "git is only read" NFR. FR-004's Socrates note deferred git reconciliation; this adds it as an explicitly labelled cross-check that never changes statuses or hints.

For one session the new view lists files git reports for the session's directory (uncommitted changes, and files changed by non-merge commits of the session's branch between its start and its log's last write, ±10 min) that no prompt of the session edited ("not in the log"), and files the session edited that git shows neither way ("not in git"). Read-only git with fixed arguments (`rev-parse`, `status`, `check-ref-format`, `log`), run in the session's own directory (S-19 roots), on request only (no live polling: git runs when the view opens or on Refresh).

Wave 3 coordination: the response schema is landed on main by the orchestrator before both branches start (plan section "Schema pre-commit"); implementers never edit `schema.ts` or `packages/core/src/index.ts`. S-21 writes no golden files (S-20 is the wave's golden writer). README text is pasted by the orchestrator.

Process: plan Opus (2026-10-25); plan-review by a different model before phase 1; worker phases written for OpenCode/DeepSeek; browser check, README and archive by the orchestrator.
