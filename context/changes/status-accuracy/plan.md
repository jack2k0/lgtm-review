# Status accuracy (S-11) Implementation Plan

## Overview

Close the biggest gaps found by the audit of 120 real turns (status match 90.8%, reason match 76.1%): fix check recognition, prompt boundaries for slash commands, masked exit codes, invisible shell edits, and git-operation noise. Target on the audit population: status match >= 95%, reason match >= 88%, with no regression on the synthetic fixtures.

## Current State Analysis

- `packages/core/src/check-patterns.ts`: `classifyCommand(command, repo?)` with `SIMPLE_RES`, `SCRIPT_FILE_RE`, repo scripts from `RepoScripts` (loaded from `--dir` root by `node/discover.ts` `loadRepoScripts`); `unreliable` flag for pipes / `|| true` / `; echo`.
- `packages/core/src/parse.ts`: prompt detection (slash commands, `<local-command`, meta, sidechain, compact summaries skipped), `bashEditDiff` edits, `Exit code N` handling.
- `packages/core/src/analyze.ts`: status rule, `inFix`, hints; `timing.ts`/`steps.ts` share `actionPhase`.
- Audit (`audit-2026-10-23.md`) findings and top-10 list; evidence: 65 `scripts/verify*.sh` commands unrecognized; 11 slash turns skipped (4 with 14-48 edits); 431 of 436 recognized checks are `unreliable` (tail/echo/||); 2 false `checked` via masked exit; 125 of 145 `sed -i` commands lack `bashEditDiff` when the session starts outside the repo; `bash -n` false positives.
- Real data covered only Python/Java/.NET/shell projects; JS/TS patterns remain verified on synthetic fixtures only.

## Desired End State

1. **Check recognition (audit #1, #7, #9)**: script names match by name alone (no repo list needed): `(^|/)(check|test|lint|ci|verify|validate|gate|mutation|smoke)[^/\s]*\.sh$` including `bash|sh|zsh <script>` and `./script`; add `dotnet (test|build)`, `python* manage.py test`, `bats`, `shellcheck`, `hadolint`, `cargo nextest`, `gh run watch ... --exit-status`, `gh pr checks`. Exclusions: `bash|sh|zsh -n ...` (syntax only), `--dry-run`, `-h/--help` (exists), `ruff check --fix` is a Write/Fix action not a check, `ruff format` without `--check` is not a check.
2. **Slash commands as prompts (audit #3)**: a user record with `<command-name>/x</command-name>` opens a prompt when it is a "work" command; text = `/x <args>` (args truncated); skipped: `/clear`, `/compact`, `/model`, `/help`, `/status`, `/config`, `/login`, `/logout`, `/cost`, `/context`, `/resume`, `/exit`, `/ide`, `/permissions`, `/mcp`, `/memory`, `/hooks`, `/doctor`, `/terminal-setup`, `/statusline`, `/vim`, `/theme`, `/fast`, `/goal clear`; expanded-skill meta records following the command do not open a second prompt; a command turn with no tool activity afterwards yields a `no-changes` prompt that is NOT listed... (keep it simple: listed as `no-changes`). Goldens/labels updated.
3. **Masked exit (audit #4)**: for checks flagged `unreliable` (pipe to tail/head/cat/tee, `|| ...`, `; ...`), inspect the result text: failure signals `\b[1-9]\d* (failed|failures?|errors?)\b`, `(^|\s)(EXIT|exit|rc|status)[=:]\s*[1-9]`, `BUILD FAILURE`, `Tests run:.*(Failures|Errors): [1-9]`, `FAILED`, `\bnot ok\b`, `Traceback \(most recent call last\)` (only when it is the command's output tail) => treat the check as failed (status can become `failing`, reason "<command> output indicates failures (exit code masked)"); otherwise keep `checked` with reason suffix "(exit code not verified)". A mutation probe (`...; git checkout|restore|stash ... <file>` after the check segment) marks the check `unreliable` and the reason suffix "(edits may have been reverted)", never `checked` without the suffix.
4. **Shell edits without `bashEditDiff` (audit #5)**: when a successful Bash call has no `bashEditDiff` and matches a write heuristic (`sed -i`, `perl -pi`, `tee`, `>`/`>>` redirects to non-`/tmp`/non-scratch paths, `git apply`, `git mv`, `python* - <<` with `open(..., 'w')`, `cat > file <<`), count it as an edit with `maybeIncomplete: true`; file = the target path when trivially parseable (last operand of `sed -i`, redirect target, `tee` arg), otherwise `"(shell edit)"`; paths under `/tmp`, `$TMPDIR`, `/var/tmp`, `.cache` are ignored. When the session `cwd` is not a git repo... (cannot be known offline) the reason gets the suffix "(shell edits may be incomplete)" only when a heuristic edit was counted.
5. **Git-operation noise (audit #10)**: `bashEditDiff` and heuristic edits produced by a command whose only mutating segments are `git merge|rebase|pull|checkout|stash|cherry-pick|mv|restore|reset` do not invalidate an earlier passing check (kind `git-op`); they still appear in the file list with `maybeIncomplete`. Fix the contradictory "0 edits after last check" reason (never emit a count of 0; use "no edits after last check" semantics consistently or omit).
6. **Measurement**: add `scripts/audit-status.mjs` (documented, runs the built CLI on a local projects dir and prints aggregate counts only: prompts per status, % `unchecked`/`no-changes`, share of prompts flagged partial, share of checks `unreliable`; never prints content) so the owner can re-run the audit; document in the plan; fixtures + goldens cover each item.

## What We're NOT Doing

- No subagent transcript merging (S-12), no cross-file fork/resume dedupe (S-13), no background task completion mapping (S-14), no changes to the web UI beyond reason text, no new hint rules, no network, no change to time model beyond the shared classifier.

## Implementation Approach

Two phases: (1) parse/classifier changes (items 1-3), (2) edit heuristics and git-op handling plus the audit script (items 4-6). Synthetic fixtures with labels per item; table-driven tests; all existing goldens regenerated only where reasons/statuses legitimately change (reviewed in the diff).

## Critical Implementation Details

- Determinism and node-free core (grep rule). Heuristics are regex on the command string after existing prefix stripping and segment splitting; keep linear-time.
- A masked-exit inspection reads at most the last 4 KB of the result text (already truncated at parse time) and requires the signal to be in those last lines; false-positive guard: the words `0 failed`, `no errors`, `errors: 0`, `0 errors` are explicitly negative.
- Slash-command prompt text goes through the same truncation as normal prompts; hints/summary redaction unaffected.
- Reason text changes must keep the web/CLI tests passing (update goldens deliberately, list changed reasons in the report).

## Phase 1: Check recognition, slash prompts, masked exits

**Files**: `check-patterns.ts`, `parse.ts`, `analyze.ts` (+ tests, fixtures, goldens, labels). >= 40 new table cases (positives and negatives drawn from audit shapes, synthetic strings only).

### Success Criteria

- `pnpm check` green; node-free grep empty; status-match test over fixtures 100%; new fixtures for: verify script via `bash scripts/verify-x.sh > log 2>&1`, `dotnet test | tail` with failing output, slash-command turn with edits, `pytest | tail; git checkout file` probe, `bash -n scripts/check.sh` not a check

## Phase 2: Shell edit heuristics, git-op, audit script

**Files**: `parse.ts`/`analyze.ts`, `scripts/audit-status.mjs`, docs (`packages/cli/README.md` limitations paragraph: shell edits and masked exits are heuristic), tests, fixtures, goldens.

### Success Criteria

- `pnpm check` green; the audit script runs on fixtures (smoke) and prints counts only
- Orchestrator re-runs the real-log audit (subagent, same methodology) and records new match percentages in `reviews/audit-after.md` (target >= 95% status, >= 88% reason)

## Progress

### Phase 1: Check recognition, slash prompts, masked exits

- [x] 1.1 `pnpm check` green, fixtures 100%, node-free grep empty

### Phase 2: Shell edit heuristics, git-op, audit script

- [x] 2.1 `pnpm check` green
- [ ] 2.2 Real-log audit re-run: status >= 95%, reason >= 88%

## Plan-review amendments (accepted by orchestrator, 2026-10-23)

- G1 (findings 1, 5, 6): targets are measured on prompts WITHOUT subagent activity (status >= 95%, reason >= 88%); the overall figures (all prompts) are reported alongside, with the expected gap attributed to S-12 (subagents) and S-13 (dedupe). The audit re-run therefore reports two populations: non-subagent and all.
- G3 (finding 3): masked-exit inspection: if both a failure signal and a negative-guard phrase appear in the inspected tail, the failure signal wins unless the negative phrase is a final summary line (`0 failed`, `0 failures`, `All tests passed`, `Ran N tests ... OK`, `no errors`) AND no other failure signal appears; add tests for both orders.
- G8 (finding 8): git-op events never transition the status; explicit tests: passing check, then `git merge` (with `bashEditDiff`) => status stays `checked`, files listed with `maybeIncomplete`, reason unchanged ("... passed after last edit"), never "0 edits".
- Rejected: finding 2 (real-log cross-validation is the Phase 2 audit re-run itself), finding 4 (intent-uncertain tagging adds noise; `maybeIncomplete` and the reason suffix suffice), finding 7 (the script prints aggregates; comparability across users is not a goal of this slice).
