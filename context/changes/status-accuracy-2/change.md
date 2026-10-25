---
change_id: status-accuracy-2
title: Status accuracy, round 2 — scratch files, call working directory, Python comments, pinned notification cases
status: planned
created: 2026-10-25
updated: 2026-10-25
archived_at: null
---

## Notes

Roadmap S-20 (v0.3 extension, wave 3, runs in parallel with S-21 git-crosscheck), PRD FR-002/FR-004/FR-013 and the v3 success criterion (>= 97% status match on the owner's real prompts; 95.3% on 2026-10-23).

Re-check of the 2026-10-23 audit categories against today's code (synthetic probes, 2026-10-25): the in-command order shapes (`cat > f <<EOF … EOF` then a check; `sed -i` in a `( … )` or `{ … }` group after a check), status-less task notifications, and background notifications across the parent and subagent files already give the expected statuses. They are pinned by tests here, not changed. Real changes in this slice: Write/Edit to temporary scratch files outside the work tree need no check (like documentation, S-16); shell-heuristic edit targets resolve against the tool call's recorded working directory (S-18 added it to events); the Python import extractor no longer loses imports after a `#` comment containing `"""` or after a string containing `#`.

Real logs are read only by the orchestrator, in phase 0 (baseline) and phase 5 (after), through local Claude subagents, and only counts are written down. Workers never touch `~/.claude`.

S-20 is the only wave-3 slice that writes golden files (new `scratch-edits.*` only). It needs no schema change.

Process: plan Opus (2026-10-25); plan-review by a different model before phase 1; worker phases written for OpenCode/DeepSeek; baseline/after audits, README and archive by the orchestrator.
