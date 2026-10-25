---
change_id: worktree-sessions
title: Sessions of all git worktrees of the repository in one list
status: done
created: 2026-10-25
updated: 2026-10-25
archived_at: 2026-10-25
---

## Notes

Roadmap S-19 (v0.3 extension, wave 2, runs in parallel with S-18 scoped-checks), PRD v3 FR-018 and the v0.3 "git is only read" NFR.

Claude Code stores a session under the project dir named after its working directory, so sessions started in a linked worktree (`git worktree add`, `claude --worktree`, which puts worktrees under `<repo>/.claude/worktrees/<name>`) are invisible from the main checkout today. This change lists the repository's worktrees with one read-only `git worktree list`, reads every worktree's project dir (and archive), labels sessions with their worktree when more than one worktree contributed, and runs per-session work (repo scripts, map, play, export redaction) in that session's own directory. `--no-worktrees` keeps today's behaviour.

Real-data note (2026-10-25): the owner's `~/.claude/projects` holds no worktree project dirs yet (directory names checked only, no log content read); implementation phases so far ran in other agents or as subagents. The feature is built and verified on synthetic layouts; its value on real data depends on starting Claude Code sessions inside worktrees.

Wave 2 coordination: the `worktree` schema fields come from the orchestrator's schema pre-commit (see `context/changes/scoped-checks/plan.md`, section "Schema pre-commit"); this branch never edits `schema.ts`, never writes golden files and never touches S-18's files. README text is pasted by the orchestrator after the merge.

Process: plan Opus (2026-10-25); plan-review by a different model before phase 1; phases for Sonnet/Haiku/OpenCode as marked; synthetic-layout check, README and archive by the orchestrator.
