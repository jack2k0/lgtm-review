# Plan Review: session-archive (S-15, FR-008 second half)

**Verdict:** approve with changes  
**Target Plan:** `context/changes/session-archive/plan.md`  
**Reviewer:** Antigravity (Claude 3.5 Sonnet)  
**Date:** 2026-10-23  

---

## Executive Summary

The plan for S-15 ("Local session archive") is well-structured, adheres to the established conventions, and builds cleanly on top of `discoverSessions` and `markInherited`. However, there is 1 critical BLOCKER that would break subagent loading for archived sessions, 4 MAJOR defects around schema definitions, server options, timestamp handling in Node.js, and temporary file atomicity, and 2 MINOR improvements.

With the 7 amendments specified below, the plan is approved for implementation.

---

## Findings

### F1 — BLOCKER: Subagent `*.meta.json` files are omitted from copying in D1

- **Location:** `plan.md §Design decisions (binding)` — D1: *"sources: regular files `*.jsonl` directly in `projectDir` and regular files `<id>/subagents/*.jsonl` for each session id found"*.
- **Detail:** In `packages/core/src/node/subagents.ts` (`loadSubagents`, lines 112–118), subagent transcripts are discovered by scanning `<id>/subagents/agent-*.jsonl`, but each transcript requires its corresponding metadata file `join(dir, `${stem}.meta.json`)`. If `meta` is missing or unreadable, `loadSubagents` emits the warning `subagent <agentId>: meta missing or unreadable, transcript skipped` and **drops the subagent transcript entirely**. If D1 only copies `agent-*.jsonl`, every archived session with subagents will lose all subagent transcripts when read from the archive.
- **Fix:** In D1, copy both `agent-*.jsonl` and `agent-*.meta.json` under `<id>/subagents/` (or all regular files matching `agent-*.(jsonl|meta.json)`).

---

### F2 — MAJOR: `SessionAnalysis` schema missing `archived` field

- **Location:** `plan.md §Design decisions (binding)` — D4: *"Schema: `SessionSummary.archived: z.boolean().optional()` (true only for archive-only sessions); API `/api/sessions` and `--list --json` carry it; `--list` text appends ` (archived)`"*.
- **Detail:** 
  1. `--list --json` does not output `SessionSummary`. It outputs `Analysis = z.object({ dir: z.string(), sessions: z.array(SessionAnalysis) })` (`packages/cli/src/cli.ts:241`).
  2. `--list` text output uses `formatText(sessions: SessionAnalysis[])` (`packages/cli/src/format.ts:54`), which operates directly on `SessionAnalysis[]`, not `SessionSummary`.
  3. `packages/cli/src/api.ts` `summarize(s: SessionAnalysis)` constructs `SessionSummary` from `s: SessionAnalysis`. If `SessionAnalysis` does not have `archived`, `summarize()` cannot know whether the session is archived.
  4. `GET /api/sessions/:id` returns `SessionAnalysis`.
  If `archived` is only added to `SessionSummary`, neither `--list --json` nor `formatText` nor `summarize()` nor single-session API responses can carry `archived`.
- **Fix:** Add `archived: z.boolean().optional()` to **both** `SessionAnalysis` and `SessionSummary` in `packages/core/src/schema.ts`. In `discoverAllSessions`, mark `SessionFile.archived = true`. In callers (`cli.ts`, `api.ts`), carry `archived: f.archived` onto `SessionAnalysis` upon analysis. Update `summarize()` in `api.ts` to copy `s.archived` to `SessionSummary.archived`.

---

### F3 — MAJOR: `ServerOptions` in `server.ts` missing `archiveDir`

- **Location:** `plan.md §Design decisions (binding)` — D3: *"Every CLI reader uses D2 with `archiveDirFor(projectDir, archiveRoot)`; `--archive-dir` is accepted by all modes..."*.
- **Detail:** `packages/cli/src/server.ts` defines `ServerOptions` (`dir`, `projectsDir`, `webRoot`, `port`, `token`, `mapCaps`). It does not include `archiveDir` (or `archiveRoot`). When `lgtm-review` starts the web server via `startServer(opts)`, `createApi(opts)` only has access to `ServerOptions`. Without `archiveDir` in `ServerOptions`, the web server API cannot pass `archiveDir` to `discoverAllSessions`, meaning the web UI will never see archived sessions!
- **Fix:** Add `archiveDir?: string` to `ServerOptions` in `packages/cli/src/server.ts`. In `packages/cli/src/cli.ts`'s `serve()` function, pass `archiveDir: archiveDirFor(projectDir, archiveRoot)` to `startServer`.

---

### F4 — MAJOR: Node.js `fs.utimes` milliseconds pitfall and filesystem timestamp granularity

- **Location:** `plan.md §Design decisions (binding)` — D1: *"skip when the destination exists with the same size and `mtimeMs >= source mtimeMs`... then `utimes` dest to the source mtime"*.
- **Detail:**
  1. In Node.js, `fs.utimes(path, atime, mtime)` interprets numerical arguments as **seconds**, not milliseconds. Passing `st.mtimeMs` as a number sets the mtime ~50,000 years into the future. It must be passed as `new Date(st.mtimeMs)`.
  2. Filesystems (FAT32, exFAT, or certain ext4/NTFS mount configurations) have coarse timestamp granularity (e.g. 1–2 seconds, or sub-millisecond truncation). Setting `utimes` and then re-reading `mtimeMs` may result in `dest.mtimeMs` being slightly lower than `source.mtimeMs` (by a fraction of a second or up to 1s). Under a strict `dest.mtimeMs >= source.mtimeMs` check, unchanged files would be recopied on every archive run.
- **Fix:** In `archive.ts`, call `utimes` with `new Date(sourceSt.mtimeMs)`. For the skip check on append-only session files, check `destSt.size === sourceSt.size && destSt.mtimeMs >= sourceSt.mtimeMs - 1000` (or `Math.abs(destSt.mtimeMs - sourceSt.mtimeMs) < 1000`).

---

### F5 — MAJOR: Temporary file naming collision and atomic rename

- **Location:** `plan.md §Design decisions (binding)` — D1: *"otherwise copy to `<dest>.tmp-<pid>` then `rename` (atomic)"*.
- **Detail:** If a prior `lgtm-review --archive` run was killed or crashed, `<dest>.tmp-<pid>` might remain on disk. Furthermore, on Windows (`win32`), `fs.rename` across an existing destination file can fail with `EPERM` or `EEXIST` depending on filesystem state.
- **Fix:** Generate a unique temporary path using `${dest}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`. Ensure temporary files are unlinked in a `finally` block if copying fails.

---

### F6 — MINOR: Direct reader callers in `export.ts` and `cli.ts` missing `discoverAllSessions`

- **Location:** `plan.md §Design decisions (binding)` — D2, D3; `packages/cli/src/export.ts:106`, `packages/cli/src/cli.ts:207`.
- **Detail:** `export.ts` (`runExport`) calls `discoverSessions(projectDir)` directly without reading the archive. If an archived session is requested via `lgtm-review --export <id>`, it would fail with "no Claude Code sessions found". `ExportCommand` must accept `archiveDir?: string`, and `runExport` must call `discoverAllSessions(projectDir, cmd.archiveDir)`. Similarly, `cli.ts` `--summary` and `--list` must use `discoverAllSessions`.
- **Fix:** Update `runExport` in `packages/cli/src/export.ts` and `cli.ts` to take `archiveDir` and use `discoverAllSessions`.

---

### F7 — MINOR: Flag validation mutual exclusion completeness in D6

- **Location:** `plan.md §Design decisions (binding)` — D6.
- **Detail:** D6 mentions `--archive` cannot be combined with `--list`, `--json`, `--summary`, `--export`, `--session`, `--out`. To avoid contradictory states, it should also be disallowed with `--port`, `--no-open`, `--force`, and `--no-diffs`. In addition, `--archive-dir ""` (empty string) should produce a clean error message (`lgtm-review: --archive-dir needs a directory path`), consistent with `--out`.
- **Fix:** Specify the complete exclusion list in D6 and error message for empty `--archive-dir`.

---

## Actionable Amendments for `plan.md`

1. **(B1 - Subagents)**: Update D1 so source files include regular files `*.jsonl` in `projectDir` AND `agent-*.jsonl` and `agent-*.meta.json` in `<id>/subagents/`.
2. **(B2 - Schema & Propagation)**: Update D4 to add `archived: z.boolean().optional()` to both `SessionAnalysis` and `SessionSummary`. Document that `SessionFile.archived` propagates to `SessionAnalysis.archived` in `cli.ts` / `api.ts`, and to `SessionSummary.archived` in `summarize()`.
3. **(B3 - ServerOptions)**: Update D3 to explicitly include `archiveDir?: string` in `ServerOptions` in `server.ts`.
4. **(B4 - Utimes & Skip Check)**: In D1, mandate `new Date(st.mtimeMs)` for `fs.utimes`, and use a 1000ms timestamp tolerance (`dest.size === source.size && dest.mtimeMs >= source.mtimeMs - 1000`) for the skip condition.
5. **(B5 - Temp File Naming)**: In D1, specify unique temp file names (`${dest}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`) with cleanup in `finally`.
6. **(B6 - Readers)**: In D3, explicitly list `packages/cli/src/export.ts` (`ExportCommand.archiveDir`) and `packages/cli/src/cli.ts` as consumers of `discoverAllSessions`.
7. **(B7 - Flag Validation)**: In D6, include `--port`, `--no-open`, `--force`, `--no-diffs` in the exclusion check, and validate non-empty `--archive-dir`.

## Phase Sizing Evaluation

- **Phase 1 (Core node)**: `archive.ts`, `discover.ts` (`discoverAllSessions`), schema updates, and unit tests (`archive.test.ts`). Fits comfortably in a single implementation brief (~250-300 lines of code + tests).
- **Phase 2 (CLI + web + docs)**: `cli.ts`, `server.ts`, `api.ts`, `export.ts`, `format.ts`, `SessionList.tsx`, tests, README. Fits comfortably in a single implementation brief.
