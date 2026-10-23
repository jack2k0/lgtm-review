# Local session archive (S-15, FR-008 second half) Implementation Plan

## Overview

Claude Code deletes session logs older than `cleanupPeriodDays` (default 30). A review "from last month" then disappears. This slice adds an explicit `lgtm-review --archive` command that mirrors the repo's session logs (and subagent transcripts) into a private local archive, and makes every reader (terminal list, summary, export, web) see archived sessions whose originals were deleted, marked "archived".

## Current State Analysis

- Discovery: `packages/core/src/node/discover.ts` `discoverSessions(dir)` lists `*.jsonl` directly in `projectDirFor(cwd, projectsDir)`; callers: `packages/cli/src/cli.ts:203-207`, `packages/cli/src/api.ts:93-98`, `packages/cli/src/export.ts:103-106`.
- Reading: `packages/core/src/node/read.ts` + `lines.ts` stream a file path; subagent transcripts are found relative to the session file (`subagentsDirFor`: `<dir>/<id>/subagents/agent-*.jsonl`), so a mirrored layout needs no reader changes.
- Schema: `SessionSummary` (`packages/core/src/schema.ts:102`) has no origin marker. `SessionFile` = `{ path, id, mtimeMs }`.
- Nothing in the repo writes outside `--out` today (export) — the archive is the second write path; it must be opt-in.

## Desired End State

- `lgtm-review --archive [--dir] [--projects-dir] [--archive-dir <path>]` copies new/changed session files of the repo's project dir into `<archiveRoot>/<project dir name>/` and prints one summary line; exit 0.
- Archive root: `--archive-dir`, else env `LGTM_REVIEW_ARCHIVE`, else `~/.lgtm-review/archive`.
- All readers merge the archive: a session present in the live project dir is read from there (live wins); a session only in the archive is read from the archive and marked `archived: true` (terminal `--list` shows `(archived)`, web list shows an "archived" badge, export/summary work unchanged).
- README section "Archive" with `cleanupPeriodDays` explanation.

## What We're NOT Doing

- No automatic/background archiving, no cron, no hook installation (owner may add a hook later; README shows a one-line example only).
- No compression, no hard links, no deduplication across projects, no pruning/deleting from the archive.
- No archive of analysis JSON (`Story`) — raw logs are archived so future parser improvements re-analyze them.
- No redaction in the archive (it is a private copy of data already on disk, same trust level as `~/.claude`); never uploaded anywhere.
- No archiving of other repos' sessions (only the project dir of `--dir`).

## Design decisions (binding)

D1. Core node module `packages/core/src/node/archive.ts`:
  - `defaultArchiveRoot(env = process.env): string` -> `env.LGTM_REVIEW_ARCHIVE` (non-empty) else `join(homedir(), ".lgtm-review", "archive")`.
  - `archiveDirFor(projectDir: string, archiveRoot: string): string` = `join(archiveRoot, basename(projectDir))`.
  - `archiveSessions(projectDir, archiveDir): Promise<{ copied: number; unchanged: number; bytes: number; warnings: string[] }>`:
    - sources: regular files `*.jsonl` directly in `projectDir` and regular files `<id>/subagents/*.jsonl` for each session id found; use `lstat`, skip symlinks and anything else (warning, not error);
    - skip when the destination exists with the same size and `mtimeMs >= source mtimeMs`; otherwise copy to `<dest>.tmp-<pid>` then `rename` (atomic), then `utimes` dest to the source mtime;
    - create directories with mode `0o700`, files with mode `0o600` (best effort on platforms without POSIX modes);
    - never deletes anything; a file that vanishes mid-copy -> warning;
    - a source file still growing (live session) is fine: the next run copies it again.
D2. Discovery merge `discoverAllSessions(projectDir, archiveDir | null, warnings?)` in `discover.ts`: live `discoverSessions(projectDir)` (missing project dir -> empty list, not a throw, when an archive exists) + archive `discoverSessions(archiveDir)` (missing -> empty); archive entries whose `id` is in the live list are dropped; result sorted like today. `SessionFile` gains `archived?: true`. If both dirs are missing, behave exactly as today (same error message).
D3. Every CLI reader uses D2 with `archiveDirFor(projectDir, archiveRoot)`; `--archive-dir` is accepted by all modes (so a custom root is also read), env/default otherwise. The archive is read-only for readers.
D4. Schema: `SessionSummary.archived: z.boolean().optional()` (true only for archive-only sessions); API `/api/sessions` and `--list --json` carry it; `--list` text appends ` (archived)`; web `SessionList` shows a small "archived" badge with `title="Original log deleted by Claude Code; read from the lgtm-review archive"`.
D5. ETag/stamp: the list stamp already derives from discovered files' size+mtime; archive-only files take part like live ones (no special casing). Test: deleting a live file that is archived keeps the session listed with `archived: true` and changes the list ETag.
D6. CLI flag validation: `--archive` cannot be combined with `--list`, `--json`, `--summary`, `--export`, `--session`, `--out`; prints `archived N new or updated, M unchanged (X.Y MB) -> <archiveDir>` and warnings to stderr; exit 1 only when the project dir cannot be read at all.
D7. Security: archive dir path comes only from flag/env/default (never from log content); source files are only those directly under the project dir and its `<id>/subagents/`; the server never writes to the archive.

## Implementation Approach

### Phase 1: Core node (archive + discovery merge)
**Files**: `packages/core/src/node/archive.ts` (new), `packages/core/src/node/discover.ts`, `packages/core/src/node/index.ts`, `packages/core/src/schema.ts` (SessionSummary.archived), `packages/core/src/node/archive.test.ts` (new).
- D1, D2, D4 (schema only). Tests in temp dirs: first copy, unchanged second run, grown file recopied, symlink skipped, subagent transcripts mirrored, modes 0700/0600 (skip on win32), merge: live wins, archive-only marked, both missing -> throws as before, project dir missing but archive present -> archive sessions.
#### Success Criteria
- `pnpm check` green.

### Phase 2: CLI + web + docs
**Files**: `packages/cli/src/{cli.ts,api.ts,export.ts,format.ts}`, their tests (`e2e.test.ts`, `api.test.ts` or new `archive.test.ts`), `packages/web/src/SessionList.tsx` (+ test), `packages/cli/README.md` (section "Archive").
- D3, D4 (surfaces), D5, D6, D7. E2E: run `--archive` against a temp projects dir, delete the live file, `--list` shows `(archived)`, `--export` of the archived session works, `/api/sessions` returns `archived: true`, analysis of an archived session with subagents still merges the subagent transcript.
#### Success Criteria
- `pnpm check` green; `scripts/smoke-pack.mjs` untouched and green.

### Phase 3: Roadmap/PRD (orchestrator)

## Progress

### Phase 1: Core node
- [x] 1.1 `archive.ts` copy with tests
- [x] 1.2 discovery merge + `archived` marker with tests

### Phase 2: CLI + web + docs
- [ ] 2.1 `--archive` / `--archive-dir` flags, readers use the merge
- [ ] 2.2 list/API/web marker, README "Archive"

### Phase 3: Docs
- [ ] 3.1 roadmap, PRD

## Orchestrator review amendments (Opus, 2026-10-23, from Agy plan-review F1-F7) — override the sections above

- C1 (F1, blocker) Copy EVERY regular file directly under `<id>/subagents/` (covers `agent-*.jsonl` and `agent-*.meta.json`); the subagent loader drops transcripts without meta. Test: an archived session with a subagent still merges the subagent after the live copy is deleted.
- C2 (F2) `archived: z.boolean().optional()` on BOTH `SessionAnalysis` and `SessionSummary`; `SessionFile.archived` -> `SessionAnalysis.archived` where callers analyze files (cli.ts, api.ts, export.ts) -> `summarize()` copies it. `--list` text (`formatText`) appends ` (archived)`; `--list --json` and `GET /api/sessions/:id` carry it.
- C3 (F3) `ServerOptions.archiveDir?: string`; `cli.ts` serve passes `archiveDirFor(projectDir, archiveRoot)`.
- C4 (F4) `utimes(dest, new Date(src.atimeMs), new Date(src.mtimeMs))` (never raw ms numbers); skip when `dest.size === src.size && dest.mtimeMs >= src.mtimeMs - 1000`.
- C5 (F5) temp name `${dest}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`, unlinked in `finally` on failure; stale `*.tmp-*` files are ignored by discovery (they do not end in `.jsonl`).
- C6 (F6) Readers using `discoverAllSessions`: `cli.ts` (list/json/summary/serve), `api.ts`, `export.ts` (`ExportCommand.archiveDir`).
- C7 (F7) `--archive` excludes `--list --json --summary --export --session --out --force --no-diffs --no-titles --port --no-open`; empty `--archive-dir` -> `lgtm-review: --archive-dir needs a directory path`, exit 2 (same style as other flag errors).
