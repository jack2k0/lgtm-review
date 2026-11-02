# Subagent transcripts: do not follow symlinks

Finding A5 of `docs/review-2026-11-02.md`. Agreed next open item, delegated 2026-11-02. No real log holds a symlink (`find ~/.claude/projects -type l`: 0), so no real session changes.

## Cause

`loadSubagents` in `packages/core/src/node/subagents.ts` reads `agent-*.jsonl` and `agent-*.meta.json` through symlinks, so content from outside the session tree enters the analysis with no warning. A symlinked `<sessionId>` or `subagents` directory does the same.

## Phase 1

In `loadSubagents` only, using `lstat`:

1. If `<sessionId>` or `<sessionId>/subagents` is a symlink, read nothing and return one warning: `subagent directory is a symlink, skipped`. No other warnings, no transcripts. A missing directory stays as it is today: no warning.
2. For each stem, before reading the meta: if `agent-<id>.jsonl` or `agent-<id>.meta.json` is a symlink, push `subagent <id>: symlink, transcript skipped` and continue, reading neither file. Such a stem does not register its `toolUseId`, so it cannot make a later stem a duplicate and is not reported as unmatched.
3. A missing file keeps today's behaviour and today's warning. An `lstat` error other than a symlink result counts as "not a symlink": the existing read path reports it.
4. Regular files behave byte for byte as today. `subagentStamp`, `listAgentFiles` and the cap on files stay unchanged.

Tests in `packages/core/src/node/subagents.test.ts`, each failing on the old code, each with the target holding a transcript with a recognisable line outside the session tree: a symlinked `.jsonl`; a symlinked `.meta.json`; a symlinked `subagents` directory; a symlinked `<sessionId>` directory. Assert the exact warning and that the transcript map is empty. Also one test with a symlinked stem next to a regular one: the regular transcript still loads. Create symlinks with `symlinkSync`; do not skip on Linux or macOS.

Do not change any existing test expectation. Do not open `~/.claude/projects`.

```gate
allow: ^packages/core/src/node/subagents\.ts$
allow: ^packages/core/src/node/subagents\.test\.ts$
allow: ^context/(changes|archive)/subagent-symlink/
deps: no
schema: no
```
