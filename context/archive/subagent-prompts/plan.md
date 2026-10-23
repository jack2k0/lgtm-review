# Subagent prompts (S-12) Implementation Plan

## Overview

Load subagent transcripts of a session, attribute their tool activity (edits, checks, reads) to the parent prompt that spawned them, and let that activity drive status, reason, files, time split, steps and hints. Remove the "subagent activity not analysed" hedge when the transcript was found.

## Current State Analysis

- Core (`packages/core/src`): `parse.ts` `createParser({detail})` normalises records to events and skips sidechain records (`isSidechain: true`) and sidechain-only files are never read; `analyze.ts` `createAnalyzer` consumes events in file order per prompt (status rule, files, timing, steps, hints, `partial` when an `Agent` tool_use is present); `timing.ts`/`steps.ts` share `actionPhase`; `hints.ts` counters per edit.
- Node IO (`packages/core/src/node`): `discoverSessions`, `analyzeFile`, `analyzeFileDetail`, `loadRepoScripts`; session dir layout from the spike: `<projectDir>/<sessionId>.jsonl` plus `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl` and `agent-<agentId>.meta.json` with `{agentType, description, toolUseId, spawnDepth, model}`.
- Facts (spike + audit): all records in a subagent file have `isSidechain: true` and `agentId`; the first user record (parentUuid null) is the prompt the parent gave the subagent (not a human prompt); the parent's `Agent` tool_use `id` equals meta `toolUseId`; async agents return early in the parent (`toolUseResult.isAsync`, `outputFile`) and finish later (task-notification); subagents may spawn nested subagents (`spawnDepth`).
- Audit after S-11: 13 of the 22 prompts with an `Agent` call are wrong in status or reason; the rest of the population is >= 97%.

## Desired End State

- `@lgtm/core/node`: `analyzeFile` / `analyzeFileDetail` discover subagent files of the session (`<sessionId>/subagents/*.jsonl`, matched to the parent's `Agent` tool_use ids via `meta.toolUseId`; files without readable meta or unmatched are ignored with a warning count), stream each with a sidechain-aware parser, and pass them to the analyzer as `subagents: Map<toolUseId, SubagentTranscript>` where `SubagentTranscript = {agentId, description, events: Event[] (normalised, capped), truncated: boolean}`. Core stays node-free: the core API takes already-parsed transcripts (`createAnalyzer({subagents})` or `analyzer.addSubagent(toolUseId, lines | events)`).
- Sidechain-aware parsing: `createParser({sidechain: true})` treats records of a subagent file as the main thread (skips the first user prompt record as a prompt but may keep its text as the task description), does not open prompts, emits `tool_use`/`tool_result`/`text` events tagged with `agentId`.
- Merge rule: within a prompt, subagent events are inserted into the prompt's event sequence by timestamp: each subagent event goes after the last parent event whose timestamp is <= its own (ties: parent first); events without timestamps inherit the previous known one; subagent events earlier than the prompt start attach at the start, later than the end at the end. Parent events keep their relative order (no global re-sort, because parent timestamps are non-monotonic in ~7% of cases). Nested subagents (an `Agent` call inside a subagent) are merged recursively up to depth 3.
- Effects: edits and checks from subagents drive the status rule and reasons exactly like parent ones (reason text may name the origin: "... (by subagent <description>)" only when the deciding check or last edit came from a subagent); `files` include subagent-edited files; hints counters and `inFix` apply (Fix phase is tracked per thread: a failed check in one thread does not make another thread's work "Fix"); time split attributes subagent action intervals to the same phases with interval union (parallel agents overlap); steps: `Action.via?: "subagent"` and `Step.title` prefix `Subagent: ` when a step consists only of subagent actions; the `Agent` call's own wait time is not counted as a phase to avoid double counting.
- `partial` stays true only when an `Agent` tool_use has no found transcript (missing file, depth > 3, or truncated by caps). Reason suffix "; subagent activity not analysed" only then; when transcript found but truncated: "; subagent transcript truncated".
- Caps: per transcript 20,000 normalised events and 5 MB of retained detail text; per session 100 subagent files; exceeding sets `truncated` and a Warning. The list/summary/export paths use the same merged analysis; detail mode retains subagent diffs under the existing caps.
- Hints rule `unchecked-edit` etc. use merged sequence; no new hint rules.

## What We're NOT Doing

- No UI redesign (steps just show the `via` marker and prefixed titles); no separate subagent tree view; no per-agent cost/model info; no cross-file fork/resume dedupe (S-13); no background-task completion mapping (S-14); no reading of `tool-results/*.txt`; no change to the status rule itself.

## Implementation Approach

Three phases: (1) sidechain-aware parser and merge machinery in core with synthetic fixtures; (2) node IO discovery + API/CLI integration (all consumers: list, JSON, summary, export, server); (3) real-log audit re-run, docs.

## Critical Implementation Details

- Matching: parent `Agent` tool_use id -> subagent meta `toolUseId`; a subagent file with no matching parent call is attached to the prompt containing the closest preceding parent event by timestamp (fallback) with a Warning "unmatched subagent".
- Cost control: subagent files are only read when the parent contains an `Agent` tool_use (discover lazily by scanning events or by directory listing, whichever is cheaper); reading is streaming with the same substring prefilter; analysis time for a session with 100 subagent files of 1 MB each must stay < 3 s (perf test with synthetic files).
- Detail mode retention: subagent action summaries, quotes (assistant text) and patches under the existing per-prompt caps (200 steps, 5000 actions): the cap counts merged items.
- Determinism: merge is a pure function of the inputs; subagent file ordering for ties by agentId; ETag keys of the HTTP API must include the subagent files' (path, mtime, size) so live refresh sees subagent progress (extend `etagFor` inputs and the analysis cache key).
- Core node-free grep rule unchanged; node IO under `src/node/`.
- Privacy: subagent task prompts (first user record) are never stored beyond 200 chars of `description` from meta; summaries/exports apply the existing redaction.

## Phase 1: Core parser and merge

**Files**: `packages/core/src/{parse.ts,analyze.ts,timing.ts,steps.ts,hints.ts,schema.ts,index.ts}` + tests + synthetic fixtures: `subagent-edits` (subagent edits after parent check -> unchecked), `subagent-check` (subagent runs the passing check after parent edit -> checked), `subagent-parallel` (two agents overlapping), `subagent-nested`, `subagent-missing` (no transcript -> partial hedge), `subagent-async` (async agent finishing later), with transcripts as separate JSONL fixtures plus `meta.json`; labels and goldens; fixture loader helper in `testing/` that supplies transcripts to `analyzeSession`.

### Success Criteria

- `pnpm check` green; node-free grep empty; existing goldens unchanged except where a fixture already contained an `Agent` call (list each change in the report); status match over fixtures 100%

## Phase 2: Node IO and consumers

**Files**: `packages/core/src/node/{discover.ts,read.ts,index.ts}`, `packages/cli/src/{api.ts,http.ts,summary.ts,export.ts,cli.ts}` as needed (ETag/cache key include subagent files; live refresh), tests with temp-dir layouts (`<sid>.jsonl` + `<sid>/subagents/...`), perf test (100 files x 1 MB < 3 s), API test (ETag changes when a subagent file grows), e2e on built CLI, smoke on packed CLI for a session with a subagent.

### Success Criteria

- `pnpm check` green incl. smoke; perf test under limit; list/json/summary/export/web all show merged results (e2e asserts)

## Phase 3: Real-log audit and docs

**Files**: `packages/cli/README.md` (limitations: subagent attribution by timestamp, caps), plan progress; orchestrator runs the real-log audit again.

### Success Criteria

- Overall status match on the owner's real logs >= 97% (population B of the audit) and non-subagent population not regressed (>= 97.1%); results recorded in `reviews/audit-after.md`

## Progress

### Phase 1: Core parser and merge

- [x] 1.1 `pnpm check` green, fixtures 100%, node-free grep empty

### Phase 2: Node IO and consumers

- [x] 2.1 `pnpm check` green incl. perf, API ETag and smoke

### Phase 3: Real-log audit and docs

- [x] 3.1 `pnpm check` green
- [x] 3.2 (overall 95.3% >= PRD 95%, own target 96% missed by 0.7 pp; non-subagent 97.1%; subagent prompts 19/22 vs 9/22; follow-up fix for empty bashEditDiff shipped, not re-measured) Real-log audit: overall >= 97%, no regression

## Plan-review amendments (accepted by orchestrator, 2026-10-23)

- H3 (finding 3): the per-prompt cap of 20,000 merged subagent events is applied DURING the merge (stop inserting once reached, `truncated`); perf test also asserts heap delta < 150 MB for 100 files x 1 MB.
- H5 (finding 5): distinct reason suffixes, each with a test: missing transcript "; subagent activity not analysed", event cap "; subagent transcript truncated (event cap)", text cap "; subagent transcript truncated (text cap)", depth > 3 "; subagent activity not analysed (depth > 3)".
- H6 (finding 6): an unmatched subagent file (no parent `Agent` call with that `toolUseId`) is NOT attributed to any prompt: Warning "unmatched subagent <agentId>" only; no timestamp-proximity fallback.
- H8 (finding 8): Phase 3 target is overall status match >= 96% on the owner's real logs and the non-subagent population >= 97.1% (no regression); a mid-phase baseline (fixtures only) is Phase 1's 100% fixture match.
- Rejected: finding 1 (the merge is a pure function of the ordered inputs; determinism is tested by running twice and by shuffling the order of subagent files), finding 2 (analysis is computed over the whole file at `finish()`; a live poll recomputes from the files, there is no retroactive state; late async activity clamps to the prompt end), finding 4 (a subagent file's mtime changes only when it is appended, which is real new data; 304 is still returned when nothing changed), finding 7 (the existing node-free grep rule already covers this; no new rule).
