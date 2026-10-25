---
change_id: scoped-checks
title: Scoped checks flagged — "partially checked" as a check-scope hint
status: done
created: 2026-10-25
updated: 2026-10-25
archived_at: 2026-10-25
---

## Notes

Roadmap S-18 (v0.3 extension, wave 2, runs in parallel with S-19 worktree-sessions), PRD v3 FR-017 (the "partially checked" idea of FR-002's Socrates note, as a hint, never a status).

A `checked` prompt can rest on a check that ran on only part of the repository (`cd packages/web && pnpm test`, `pytest tests/test_cart.py`, `go test ./internal/foo/...`). This change works out where each check ran and adds a `check-scope` hint (warn) to every edited code file that no later passing check covered, plus "(scoped to <scope>)" in the reason. Core-only, deterministic, no Node IO.

Wave 2 coordination: the schema additions of both wave-2 slices (S-18 `HintRule` `check-scope`; S-19 `worktree` fields) are landed once on main by the orchestrator before either branch starts (plan section "Schema pre-commit"); implementers of S-18 and S-19 never edit `schema.ts`. S-18 is the only wave-2 slice that adds golden files; existing goldens must not change. The README text is pasted by the orchestrator after the merge.

Process: plan Opus (2026-10-25); plan-review by a different model before phase 1; phases for Sonnet/Haiku/OpenCode as marked; real-log audit (local Claude only, counts only), README and archive by the orchestrator.
