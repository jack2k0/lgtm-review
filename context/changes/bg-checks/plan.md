# Background checks (S-14) Implementation Plan

## Overview

A Bash check started with `run_in_background: true` returns immediately (`toolUseResult.backgroundTaskId`); today it stays "not completed" forever and the prompt can end up `unchecked` / "check did not complete". Claude Code later injects a user-role record whose text contains a `<task-notification>` block with the outcome. Map that block back to the check.

## Current State Analysis

- `packages/core/src/parse.ts`: `handleUser` (~L360-446) turns tool_result blocks into result events; `ev.background = true` when `toolUseResult.backgroundTaskId` is present (~L415). Records with `origin.kind !== "human"` and texts starting with `<task-notification` (`NON_PROMPT_PREFIXES`, ~L148) are dropped as non-prompts. `exitCodeOf` (~L320) parses "Exit code N".
- `packages/core/src/analyze.ts`: `CheckRec` (~L351-373), `pending` map keyed by tool_use id (~L261, never cleared on new prompt, so late results already attach to the issuing prompt's check object), result handling (~L413-434: background success => not completed), `judge()` (~L208-247), check result output (~L445-451).
- Fixture with a background check: `packages/core/fixtures/sessions/steps-edge.jsonl` (L4-5). No fixture contains a task notification.

## Notification format (tolerant parsing)

Text block (string content or text parts of a user record, any `origin`):

```
<task-notification>
<task-id>ID</task-id>
<tool-use-id>toolu_…</tool-use-id>        (optional)
<output-file>…</output-file>              (optional, ignored)
<status>completed|failed|killed|…</status>
<summary>Background command "…" completed (exit code 0)</summary>   (free text)
</task-notification>
```

- Match: `tool-use-id` equal to the check's tool_use id, else `task-id` equal to the result's `backgroundTaskId`. Several blocks per record possible; unknown/extra tags ignored; never throws.
- Outcome: exit code = first `exit code (\d+)` (case-insensitive) in summary, else `status=completed` => 0, else `status=failed` => unknown failing (exit null, failed), `killed`/`stopped`/other => stays incomplete-but-resolved as "stopped" (treated like `ignored`: did not finish, not a pass, does not make the prompt unchecked by itself).
- Only the first notification per task counts (dedupe); a notification with no matching background check is ignored.

## Desired End State

- Parser emits a new event `{ kind: "task-notification", taskId, toolUseId?, status, exitCode: number|null, seq }` and records `backgroundTaskId` on the background result event. Non-prompt filtering unchanged (the record still is not a prompt).
- Analyzer: on such an event, find the background check (map `backgroundTaskId -> CheckRec` filled on the background result; plus the `pending`/tool_use id route) and set `completed=true`, `exit`, `resultSeq = notification seq` (the order relative to edits uses the notification position: an edit made while the check was running and before it finished counts as "after the check's start" — rule: compare edits against the check's tool_use seq as today for "edit after check"; use the notification seq only for "last completed result" ordering). `failed` without exit => failing with reason "background check failed".
- `killed`/other: check marked `ignored` (reason text in steps: "stopped").
- Steps/CheckResult: background checks that resolved show `passed`/`failed (exit N)` like foreground ones, plus `background: true` flag (optional schema field `CheckResult.background?: boolean`).
- Status match improves; existing goldens unchanged except fixtures that gain notifications.

## What We're NOT Doing

- No reading of `output-file` contents, no BashOutput/TaskOutput tool handling (follow-up if audit shows need), no cross-file mapping, no change to non-background checks, no masked-exit scanning of background output (no output available).

## Implementation Approach

One core phase + a small consumer phase.

## Phase 1: Core

**Files**: `packages/core/src/{parse.ts,analyze.ts,schema.ts,steps.ts}`, tests (`parse.test.ts`, `analyze.test.ts`, `steps.test.ts`), new synthetic fixtures `bg-check-pass.jsonl` (background `pnpm test`, notification completed exit 0 arriving after the NEXT prompt started -> first prompt `checked`), `bg-check-fail.jsonl` (exit 1 -> `failing`), `bg-check-killed.jsonl` (killed -> not unchecked by that check alone), `bg-check-unmatched.jsonl` (notification with unknown ids -> no effect), with goldens and `*.labels.json` like existing fixtures. Parse tests: tolerant extraction (tags in any order, multiple blocks, missing tool-use-id, no exit code in summary, malformed block).

### Success Criteria

- `pnpm check` green; node-free grep for core empty; existing goldens unchanged (except `steps-edge` only if it gains a notification — prefer not to modify it).

## Phase 2: Consumers + docs

**Files**: `packages/web` (show "background" marker on check rows if steps UI lists checks; text only), `packages/cli/src/format.ts`/`summary.ts` only if they render check results, `packages/cli/README.md` (one paragraph), smoke unchanged unless trivially extended.

### Success Criteria

- `pnpm check` green incl. smoke.

## Progress

### Phase 1: Core

- [ ] 1.1 `pnpm check` green, fixtures + goldens, parse tolerance tests

### Phase 2: Consumers

- [ ] 2.1 `pnpm check` green incl. smoke

### Phase 3: Audit (orchestrator, local Claude only)

- [ ] 3.1 real-log aggregate audit (counts only): background checks resolved vs. still incomplete
