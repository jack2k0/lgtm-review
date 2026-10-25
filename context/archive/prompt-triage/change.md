---
change_id: prompt-triage
title: Triage in the browser — "needs attention" filters, counts and keyboard navigation
status: done
created: 2026-10-25
updated: 2026-10-25
archived_at: 2026-10-25
---

## Notes

Roadmap S-17 (v0.3 extension, wave 1; its wave-1 partner S-16 is already merged), PRD v3 FR-016 and the v0.3 keyboard NFR; serves the primary success criterion (find all unchecked/failing prompts of a real session in < 2 minutes).

Scope: the web UI (filters, counts, keys) plus the smallest server support the PRD wording needs: one optional field `SessionSummary.attentionCount` computed by the API with a shared core rule `needsAttention` (the rule of the summary's "Needs attention" section, which `--summary` then reuses with byte-identical output). First DOM test environment for `packages/web`: jsdom 30.1.2, dev-only, pinned exact (spike and advisory check in the plan).

Do-not-touch guard: S-16 (doc-edits) was merged on main at ab9f9c9 while this plan was written, so S-17 branches from there. The plan lists the files this change must not touch (core `analyze.ts`/`hints.ts`/`check-patterns.ts`, fixtures and goldens, the audit script, S-16's README sections), which also keeps it disjoint from S-18 (scoped-checks) if that starts in parallel; both add a schema member, so the schema-first rule applies then.

Process: plan Opus (2026-10-25); plan-review by a different model before phase 1; phases 1-5 by Sonnet/Haiku-class workers (Gemini/OpenCode fine for phases 2, 3 and 5); manual browser check, docs and archive by the orchestrator.
