---
change_id: doc-edits
title: Documentation-only edits do not require a check
status: planned
created: 2026-10-25
updated: 2026-10-25
archived_at: null
---

## Notes

Roadmap S-16 (v0.3 extension, wave 1, parallel with S-17 prompt-triage), PRD v3 FR-015 and the Business Logic decision (S-16). Core-only change of the status rule and the hints: no schema change, no web or CLI rendering change.

Motivation: in the owner's agent workflow an implementation phase ends by ticking `context/changes/<id>/plan.md` after `pnpm check` (phase commits 2e8588a, 655e616, 576ca8b, 4555a16 all carry a `plan.md` change), so the prompt that did the work ends `unchecked` ("1 edit after last check") although its code was checked; prompts that only update docs are `unchecked` ("no checks ran") although no check can verify prose. Real-log baseline (2026-10-23): 50 of 130 own prompts `unchecked`.

Process: plan Opus (2026-10-25); plan-review by a different model (Agy or OpenCode) before phase 1; implementation per phase (phases 1 and 3 fit Haiku, phase 2 Sonnet); verification, real-log audit (local Claude only, aggregate counts only) and docs by the orchestrator.
