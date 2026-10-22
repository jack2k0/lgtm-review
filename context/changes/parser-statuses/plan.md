# Parser + statuses (S-01) Implementation Plan

## Overview

Turn Claude Code session logs into per-prompt verification statuses (`checked` / `unchecked` / `failing` / `no-changes`) with a reason and changed files with line deltas, and print them from one terminal command. Satisfies US-01 (terminal half), FR-001, FR-002, FR-004 and the NFRs: reproducible statuses, unknown or malformed records skipped and reported as warnings, 20 MB session in < 3 s (streaming read).

Planning ran non-interactively on the orchestrator's delegation. Decisions below are assumptions; the plan-review may override them.

## Current State Analysis

- F-01 merged: pnpm + Turborepo, `@lgtm/core` (private; `Story` zod stub in `src/index.ts`, must stay free of `node:` imports), `lgtm-review` cli (tsup bundle, `core` inlined, smoke test via packed tarball in `pnpm check`), `@lgtm/web`.
- Fixtures: 4 synthetic sessions in `packages/core/fixtures/sessions/` with `.labels.json` and a placeholder `inventory` analyzer in `src/golden.test.ts`; secret-scan test covers all of `fixtures/`. Rules in `fixtures/README.md`.
- Log format facts (`spike-log-format.md`): essentials used here
  - A real prompt = `type:"user"`, not `isMeta`, not `isSidechain`, not `isCompactSummary`, content without `tool_result`, not starting with `<command-name>`, `<local-command`, `<task-notification`, `<system-reminder`, `[Request interrupted`; `origin.kind` absent or `human`; no `scheduledTaskId`.
  - Bash failure = `tool_result.is_error:true` with text `^Exit code (\d+)`; `is_error` without "Exit code" means the command did not run (ignore as a check). Success = no `is_error`.
  - Pair `tool_use` to `tool_result` only by `tool_use_id` (order flips in 11% of parallel calls).
  - Edit tools: `Edit`, `MultiEdit`, `Write`, `NotebookEdit` (`file_path` / `notebook_path`); line delta from `toolUseResult.structuredPatch` (`+`/`-` lines), `Write` with `type:"create"` from `content` line count; Bash edits from `toolUseResult.bashEditDiff.files[].hunks`.
  - Resume copies history into new files with the same `uuid`s: dedupe by `uuid` within a project. `timestamp` is not monotonic (7%): keep file order. Last line may be truncated.
  - Subagent transcripts live in `<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json` (`toolUseId`).
  - Project dir: `~/.claude/projects/<cwd with / and . replaced by ->`.

## Desired End State

- `lgtm-review` run in a repo (or `lgtm-review --dir <path>`, `--projects-dir <path>` for tests) prints, for each session of that repo (newest first): id prefix, title, branch, start time, prompt count and counts per status; then for each prompt: status, reason, and changed files (`M`/`A`/`D` marker + `+N -M`). A trailing `Warnings (N)` section lists skipped records (line number, reason, file), capped at 20 lines plus "… and K more".
- `lgtm-review --json` prints the analysis result as JSON matching the exported zod schema (the S-02 contract).
- `@lgtm/core` exports (node-free from `index.ts`): schemas/types `Analysis`, `SessionSummary`, `PromptAnalysis`, `FileChange`, `Warning`; pure `analyzeSession(lines: Iterable<string>, opts): SessionAnalysis`. Node-only IO (`discoverSessions`, `readSessionLines`) in `src/node/` exposed by a second tsup/exports entry `@lgtm/core/node`.
- Golden test uses the real analyzer; status match on the fixture corpus = 100% on the seed set and the metric (>= 95%) is asserted by a test.

Verify: `pnpm install --frozen-lockfile && pnpm audit && pnpm check`; plus `node packages/cli/dist/cli.js --dir <fixture project>` output shown in the phase 4 report.

## What We're NOT Doing

- No web UI, no HTTP server (S-02). No steps/phases/time split (S-02/S-03). No diff content (only file + line delta). No LLM titles: title = ai-title record if present else first 60 chars of first prompt.
- No git reconciliation; removals/moves via shell only when `bashEditDiff` reports them; otherwise flagged `maybeIncomplete`.
- No config file for check patterns (patterns are a constant list in `check-patterns.ts`); repo script detection reads only root `package.json` `scripts` and root `Makefile` targets, nothing else.
- No Python/Go/Rust-specific work beyond the pattern list. No subagent merging in this slice: subagent files are not read; the sessions' sidechain records are skipped and each prompt that spawned an `Agent` tool call gets `reason` suffix "subagent activity not analysed" (flag `partial: true`).
- No real session logs in the repo or in golden files; new fixtures are synthetic.

## Implementation Approach

Four sequential phases, each one worker brief. Pure analysis in core first (testable on fixtures), then the status rule, then Node IO, then CLI. All code strictly tolerant: every field access defensive, unknown things become `Warning`s, never throws.

## Critical Implementation Details

- **Status rule (per prompt)**: collect, in file order within the prompt's turn (from the prompt record up to the next real prompt or end): edits (successful) and checks (completed, executed commands). `no-changes` if no successful edits. Else if no check after the last edit: `unchecked`, reason `"N edit(s) after last check"` or `"no checks ran"`. Else the last check after last edit: exit 0 -> `checked` ("<command> passed after last edit"), exit != 0 -> `failing` ("<command> failed: <first 200 chars of output, single line>"). A check without a result (interrupted / background pending) is treated as not completed => `unchecked` with reason "check did not complete". `failing` also wins when a check failed and no later check passed even if edits came earlier than the failure (last check failed).
- **Check detection**: split command on `&&`, `;`, `||`, `|` (outside quotes, best-effort); strip prefixes `cd X &&`, `VAR=v`, `time`, `timeout N`, `env`, `sudo`, `uv run`, `npx`, `pnpm exec`; match the START of a segment against the pattern list from spike section 8; plus repo scripts detected from root `package.json` scripts named test/lint/typecheck/check/build and Makefile targets test/check/lint/build, `scripts/(check|test|lint|ci)*.sh`. A pipe that ends in `tail|head|cat|tee` after a check makes the exit unreliable: mark the check `unreliable` and still count it (documented limitation). `|| true` / trailing `; echo` => segment ignored as not a check. `echo`/`grep` segments never match.
- **Edit counting** includes Bash-detected edits only via `bashEditDiff`. A failed edit tool call (`is_error`) is not an edit.
- **Determinism**: output sorted (sessions by start time desc then id; files by path); no `Date.now()`, no random, no locale-dependent formatting in the analysis.
- **Node-free core**: `src/index.ts` and everything it imports must not import `node:*`; keep `src/node/*` out of `index.ts`; a test greps for this.

## Phase 1: Record model and prompt segmentation

### Overview

Pure, tolerant parsing of lines into a normalized event stream and prompt segmentation.

### Changes Required:

#### 1. Schemas and types

**File**: `packages/core/src/schema.ts` (new), re-export from `src/index.ts`

**Contract**: zod schemas + inferred types: `Warning {file?, line, reason}`, `FileChange {path, kind: "M"|"A"|"D", added, removed, maybeIncomplete}`, `PromptAnalysis {index, uuid, text (first 200 chars), status, reason, files[], partial}`, `SessionAnalysis {sessionId, title, branch, startedAt, prompts[], warnings[]}`. Keep the existing `Story` export untouched.

#### 2. Normalizer

**File**: `packages/core/src/parse.ts` (new)

**Contract**: `parseLines(lines: Iterable<string>): { events: Event[]; warnings: Warning[] }`. Event union: `prompt {uuid, text, ts}`, `tool_use {id, name, input}`, `tool_result {toolUseId, isError, text, structuredPatch?, bashEditDiff?, createContent?}`, `boundary {kind: "compact"|"interrupt"}`. Skips (silently): known metadata types (spike section 10), sidechain, compact summaries, meta. Warns (with line number): invalid JSON (except a truncated last line, which warns once with reason "truncated last line"), a message record lacking `message`, a `tool_use` without `id`. Dedupes by `uuid` within one call. Holds only truncated fields (never keeps `originalFile` or full `content`).

#### 3. Tests

**File**: `packages/core/src/parse.test.ts`, new synthetic fixtures `packages/core/fixtures/sessions/{parallel-reordered,compact-resume,interrupted}.jsonl` + labels + goldens

**Contract**: cases: tool_result order reversed vs tool_use; duplicate uuid ignored; compact summary and `<command-name>` user records not prompts; `[Request interrupted by user]` not a prompt; unknown `type` skipped without warning; malformed line warns. Fixtures follow `fixtures/README.md` anonymization rules; secret scan still green.

### Success Criteria:

#### Automated Verification:

- `pnpm --filter @lgtm/core test` passes; `pnpm check` green
- `grep -rn "node:" packages/core/src/index.ts packages/core/src/schema.ts packages/core/src/parse.ts` returns nothing

#### Manual Verification:

- Reviewer reads the new fixtures against the spike facts

---

## Phase 2: Status rule, check detection, file changes

### Overview

Compute per-prompt status, reason and file list from events; replace the placeholder analyzer.

### Changes Required:

#### 1. Check detection

**File**: `packages/core/src/check-patterns.ts` (new)

**Contract**: `classifyCommand(command: string, repo?: RepoScripts): {isCheck: boolean; label: string; unreliable: boolean}`; `RepoScripts = {packageScripts: string[]; makeTargets: string[]; scriptFiles: string[]}` (plain data, no fs). Behaviour per Critical Implementation Details. Table-driven unit tests >= 25 command strings (positives and negatives from the spike pitfalls).

#### 2. Analyzer

**File**: `packages/core/src/analyze.ts` (new)

**Contract**: `analyzeSession(lines: Iterable<string>, opts?: {repo?: RepoScripts; title?: string}): SessionAnalysis` using `parseLines`, the status rule and file aggregation (per file: kind `A` if first successful touch is a create, `D`/`M` per bashEditDiff/patch, summed deltas). Title: opts.title else first 60 chars of first prompt. `partial` true when a prompt contains an `Agent` tool_use.

#### 3. Golden and metric

**File**: `packages/core/src/golden.test.ts`, regenerate goldens as `*.analysis.json`

**Contract**: golden analyzer = `analyzeSession`; remove the `inventory` placeholder and its goldens; add a test computing status match against `.labels.json` over all fixtures and asserting >= 0.95; determinism test (twice => identical JSON).

### Success Criteria:

#### Automated Verification:

- `pnpm check` green; status-match test passes (expected 100% on the seed set)
- Negative check: temporarily flipping the order of an edit and its check in a fixture changes the golden and fails the test (revert)

#### Manual Verification:

- Reviewer reads the goldens and the reasons text for sensible wording

---

## Phase 3: Node IO (discovery, streaming, repo scripts)

### Overview

Find sessions for a repo directory and stream them without loading whole files.

### Changes Required:

#### 1. Node module

**Files**: `packages/core/src/node/discover.ts`, `packages/core/src/node/read.ts`, `packages/core/src/node/index.ts`; `packages/core/package.json` `exports` `./node`; tsup config entry for cli bundles it (cli imports `@lgtm/core/node`; core stays private and inlined)

**Contract**:
- `projectDirFor(cwd: string, projectsDir = ~/.claude/projects): string` (replace `/` and `.` with `-`).
- `discoverSessions(dir): Promise<SessionFile[]>` — `*.jsonl` directly in the project dir (not subagents), sorted by mtime desc; ignores unreadable entries with a warning.
- `readSessionLines(file): Iterable<string>` via `readline`/stream over file contents, line by line, never `readFileSync` of the whole file. (Async generator variant acceptable if `analyzeSession` accepts `AsyncIterable` too; then add `analyzeSessionAsync`.)
- `loadRepoScripts(cwd): RepoScripts` reading root `package.json` and `Makefile` only; missing files => empty.
- Cross-file dedupe by `uuid` within the project: process sessions oldest-first sharing one seen-set so resumed copies are not double counted.

#### 2. Tests

**File**: `packages/core/src/node/node.test.ts`

**Contract**: temp-dir based tests (cleaned in `finally`): path encoding, discovery order, truncated last line, cross-file dedupe, performance test generating a ~20 MB synthetic session in a temp dir and asserting `analyze` < 3000 ms (skip assertion on CI if `process.env.CI` and machine slow? No: keep assertion at 3000 ms, it must hold).

### Success Criteria:

#### Automated Verification:

- `pnpm check` green
- `grep -n "node:" packages/core/src/index.ts` returns nothing (node code only under `src/node/`)

#### Manual Verification:

- none

---

## Phase 4: CLI output

### Overview

Wire discovery + analysis into the `lgtm-review` command.

### Changes Required:

#### 1. CLI

**Files**: `packages/cli/src/cli.ts`, `packages/cli/src/format.ts`, `packages/cli/src/format.test.ts`, `packages/cli/package.json` (test script)

**Contract**: flags `--dir <path>` (default cwd), `--projects-dir <path>` (default `~/.claude/projects`), `--json`, `--version`, `--help`. Default text output as in Desired End State; no ANSI colors when stdout is not a TTY or `NO_COLOR` is set. Exit 0 even with warnings; exit 1 only for unreadable projects dir / no sessions found (message "No Claude Code sessions found for <dir>"). Output never prints prompt text beyond the 200-char truncation and never prints file contents. `--version` still prints `lgtm-review <version>` (smoke test keeps working).

#### 2. End-to-end test

**File**: `packages/cli/src/e2e.test.ts` (or in smoke script)

**Contract**: run the built `dist/cli.js` against a temp projects dir seeded with copies of the core fixtures; assert exit 0, expected status words, `--json` parses with the core schema.

### Success Criteria:

#### Automated Verification:

- `pnpm check` green (including pack smoke test)
- `node packages/cli/dist/cli.js --projects-dir <tmp> --dir /home/user/project` prints the 4+ fixture sessions with expected statuses

#### Manual Verification:

- Orchestrator runs the CLI on one real session of this repo and checks that statuses look plausible (output reviewed locally, not committed)

## Testing Strategy

Unit: parse, check-patterns (table), analyze (golden + metric), node IO (temp dirs), cli format. Integration: built CLI e2e + pack smoke. Manual: real-session sanity check by the orchestrator.

## Performance Considerations

Streaming reads; cheap substring prefilter before `JSON.parse` for `api-request*`, `file-history-*`, `attachment`, `queue-operation`; truncate large fields immediately after parse.

## References

- `context/changes/parser-statuses/spike-log-format.md`, `context/foundation/prd.md`, `docs/PROPOSAL.md` §7.1, `packages/core/fixtures/README.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Record model and prompt segmentation

#### Automated

- [x] 1.1 `pnpm check` green with new parse tests — 4fb0851
- [x] 1.2 No `node:` imports in index.ts, schema.ts, parse.ts — 4fb0851

#### Manual

- [ ] 1.3 New fixtures read against spike facts

### Phase 2: Status rule, check detection, file changes

#### Automated

- [x] 2.1 `pnpm check` green; status match >= 95% test passes
- [x] 2.2 Negative check on edit/check order (reverted)

#### Manual

- [ ] 2.3 Goldens and reason wording reviewed

### Phase 3: Node IO

#### Automated

- [x] 3.1 `pnpm check` green incl. 20 MB < 3 s test
- [x] 3.2 No `node:` imports in index.ts

### Phase 4: CLI output

#### Automated

- [x] 4.1 `pnpm check` green incl. pack smoke and CLI e2e
- [x] 4.2 CLI prints expected statuses for fixture sessions

#### Manual

- [ ] 4.3 Real-session sanity run reviewed

## Plan-review amendments (accepted by orchestrator, 2026-10-23)

- A1 (finding 1, blocking): analyzer is push-based so sync and streaming share one core: `createAnalyzer(opts)` returns `{push(line: string): void; finish(): SessionAnalysis}`; `analyzeSession(lines: Iterable<string>)` is a thin wrapper. `parseLines` becomes `createParser()` with `push(line)`; no AsyncIterable anywhere in core. Phase 3 streams with `readline` and calls `push` per line. Supersedes the async-variant wording in Phase 3.
- A2 (finding 2, blocking): dedupe by `uuid` only WITHIN one session file. No cross-file seen-set; `discoverSessions` stays independent per session (newest first). A resumed session therefore shows its copied history as its own prompts; merging is S-02+ scope.
- A3 (finding 3): unknown top-level `type` values (not in the spike section 10 list) produce one aggregated Warning per distinct type per file ("unknown record type X (N records)"). Known metadata types stay silent. Update the Phase 1 test accordingly.
- A4 (finding 4): rule clarified, no behaviour change: any successful edit after the last completed check => `unchecked`; `failing` only when the last completed check is after the last edit and failed, or when the last check failed and no edits occurred after it.
- A5 (finding 5): performance assertion 3000 ms locally, 6000 ms when `process.env.CI`; the measured time is logged.
- A6 (finding 6): `branch` = first non-empty `gitBranch` of a message record in the session, else `"unknown"`.
- A7 (finding 7): `Write` without `type:"create"` and without patch => `added = content line count`, `removed = 0`, `maybeIncomplete = true`.
- A8 (finding 8): node-free assertion is `grep -rn "node:" packages/core/src --exclude-dir=node --exclude=*.test.ts --exclude-dir=testing` returns nothing; use it in Phases 1-3.
- A9 (finding 9): no sessions found => message on stdout and exit 0; exit 1 only for unreadable dir or bad flags.
- A10 (finding 10): a chained command counts as a check if any segment is a check; exit code is that of the whole chain; mark `unreliable` when the check segment is followed by a pipe or `|| true`/`; <anything>`.
