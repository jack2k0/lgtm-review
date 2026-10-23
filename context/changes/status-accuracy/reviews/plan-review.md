# Plan review (OpenCode via herdr, 2026-10-23)

# Status Accuracy Review (S-11)

**Files reviewed:**
- `/home/jack/git/lgtm-review/context/changes/status-accuracy/plan.md`
- `/home/jack/git/lgtm-review/context/changes/status-accuracy/audit-2026-10-23.md`

**Audit baseline:** 90.8% status match, 76.1% reason match across 120 turns (109 prompts) in 5 project directories. Top-10 audit fixes identified root causes.

## Findings (8 max)

### 1. BLOCKING: Subagent tracking explicitly excluded, leaving 19% of prompts unaddressed
- **Location:** Plan "What We're NOT Doing" item 1; audit §3c, §4 items 2,8
- **Detail:** The plan explicitly states "No subagent transcript merging (S-12)" and does not plan to load `<session>/subagents/agent-*.jsonl` or track subagent edits/checks by timestamp. The audit finds 22 prompts with `Agent` flag, 21 with `partial` flag, and 100+ subagent log files — 19% of prompts have unrecorded subagent activity that affects status/reason classification. This gap alone prevents reaching the ≥95% status match target on real logs.
- **Fix:** Either include subagent transcript integration (re-adding S-12 scope) or formally acknowledge the ≥95% target applies only when sessions have no subagent activity, with the report documenting this limitation.

### 2. BLOCKING: Synthetic-fixture 100% pass does not guarantee real-log correctness
- **Location:** Phase 1 Success Criteria: "status-match test over fixtures 100%; new fixtures for: verify script via `bash scripts/verify-x.sh > log 2>&1`, `dotnet test | tail` with failing output, slash-command turn with edits, `pytest | tail; git checkout file` probe, `bash -n scripts/check.sh` not a check"
- **Detail:** The audit covers only Python/Django+shell, Java/.NET/Node/Python, and shell projects. JS/TS patterns (pnpm/npm/vitest/tsc/cargo/go) are unverified on real data. The audit's false-negative rate of 15.3% (78 FN) includes `verify*.sh` (65), `gh run watch` (10), `dotnet test` (3) — patterns the plan adds but never tested on actual user logs. A 100% fixture pass rate is necessary but not sufficient for the ≥95% real-log goal.
- **Fix:** Add a cross-validation step: re-run the built CLI on at least 3 diverse real log directories (beyond the audit's 5 projects) and verify status/reason counts before final sign-off.

### 3. WARNING: Masked-exit inspection guard may produce false positives/negatives
- **Location:** Plan critical detail: "false-positive guard: the words `0 failed`, `no errors`, `errors: 0`, `0 errors` are explicitly negative"; inspect last 4 KB of result text for failure signals.
- **Detail:** The audit shows 98.9% of recognized checks are `unreliable` (pipe to `tail`/`head`/`cat`/tee, `|| ...`, `; ...`). The plan's failure-signal patterns (`\b[1-9]\d* failed`, `(EXIT|exit|rc|status)=#[1-9]`, `BUILD FAILURE`, `Tests run:.*(Failures|Errors): [1-9]`, `FAILED`, `\bnot ok\b`, Traceback) are reasonable but may miss project-specific exit-text patterns. Conversely, the negative-guard words could suppress valid failure detection if a check output legitimately contains "0 failed" or "no errors" as part of a larger message. The 1/8 false `checked` instances in the audit (mutation probe with coverted exit) indicate the boundary is fragile.
- **Fix:** Expand the negative-guard list with regexes that match common "all good" summaries in test output (e.g., `Ran \d+ test` with `0 failures`, `All tests passed`); add a heuristic that if the last 4 KB contains both a failure signal AND the negative-guard words, prioritize the failure signal.

### 4. WARNING: Shell-edit fallback heuristics for non-repo sessions risk false positives on common prose
- **Location:** Plan item 4 (Shell edits without `bashEditDiff`): fallback counts `sed -i`, `perl -pi`, `tee`, `>`/`>>` redirects to non-`/tmp`/non-scratch paths, `git apply`, `git mv`, `python* - <<` with `open(..., 'w')`, `cat > file <<` as edits with `maybeIncomplete: true`.
- **Detail:** The audit finds 125 of 145 `sed -i` commands lack `bashEditDiff` when the session starts outside the repo, and 2 false `no-changes` classifications result from this heuristic. The plan notes "paths under `/tmp`, `$TMPDIR`, `/var/tmp`, `.cache` are ignored" but does not guard against `sed -i` or redirect patterns appearing in documentation strings, configuration files, or data-writing commands that are not intended as code edits. On a Java/.NET project, `sed -i` may appear in build config modifications that should count as edits, but on a Python project it may appear in data file manipulation — the same pattern, different intent.
- **Fix:** Add context-aware filtering: if a `sed -i` or redirect target matches a known build/config file pattern (Makefile, package.json, .csproj, .pyproject.toml), count it as an edit; otherwise, if the command is in a data/log directory or matches common prose patterns, surface a `"(shell edit, intent uncertain)"` tag instead of `maybeIncomplete: true`.

### 5. OBSERVATION: Phase 2 success criterion re-running real-log audit is inconsistent with S-12 exclusion
- **Location:** Phase 2 Success Criteria: "Orchestrator re-runs the real-log audit (subagent, same methodology) and records new match percentages in `reviews/audit-after.md` (target ≥ 95% status, ≥ 88% reason)"; Plan "What We're NOT Doing": "No subagent transcript merging (S-12)".
- **Detail:** The audit's full methodology depends on counting subagent edits/checks by timestamp (audit §3c item 2, §4 item 2, §4 item 8). If S-12 is not implemented, the "same methodology" cannot genuinely re-run the subagent portions of the audit, meaning the re-run will only cover the non-subagent subset. The target ≥95% status match will be measured on a reduced population, potentially making the target trivially attainable or misleadingly reported.
- **Fix:** Either (a) include subagent transcript merging in the S-11 scope, or (b) change the Phase 2 criterion to: "re-run audit on non-subagent prompts only and record status/reason percentages with a note on subagent exclusion," or (c) document the expected percentage drop when subagent prompts are excluded.

### 6. OBSERVATION: Ambitious target (≥95% status, ≥88% reason) depends on fixes with mixed coverage of audit top-10
- **Location:** Plan Phase 1 items 1-3, Phase 2 items 4-6 versus audit §5 Top-10 poprawki.
- **Detail:** The plan explicitly addresses 7 of the 10 top audit fixes (script pattern extension, slash commands, masked exits, bash edits without bashEditDiff, excluding --dry-run, dotnet/python patterns). Three are only partially addressed or omitted:
  - **Audit #6** (`gh run watch ... --exit-status` background handling, mapping to `<task-notification>`): not in plan.
  - **Audit #8** (dedup fork/resume between session files): not in plan; 15 duplicates (13.8%) in 109 rows.
  - **Audit #10** tie-break/git-op: plan fixes "0 edits after last check" contradiction but only partially addresses git-op noise marking (`kind git-op`).
  With 3 of 10 top fixes uncovered, slippage on the ≥95%/≥88% targets is likely unless the remaining 3 fixes have outsized impact.
- **Fix:** Explicitly scope the target: "≥95% status match and ≥88% reason match on prompts without subagent activity, and ≥92%/≥85% when subagent prompts are included with the current exclusion."

### 7. OBSERVATION: Measurement loop reproducibility across user project structures is untested
- **Location:** Phase 2 Success Criterion: "scripts/audit-status.mjs (documented, runs the built CLI on a local projects dir and prints aggregate counts only: prompts per status, % unchecked/no-changes, share of prompts flagged partial, share of checks unreliable"
- **Detail:** The audit was run on 5 specific project directories (A: Python/Django+shell 55 prompts, B: multi-repo orchestration 52 prompts, C: home directory 2 prompts, plus lgtm-review and tmp: 0 prompts). The plan's audit script is documented to run on "a local projects dir" but does not specify how many/project-mix is needed for statistically meaningful results. A user with a single Python project or a Node project may produce markedly different numbers, and the orchestrator's "re-run the real-log audit" may not be comparable across environments.
- **Fix:** Define a minimum fixture set for the audit script: at least 3 project directories with mixed languages (Python, shell, and one other), each with ≥30 prompts, and report the expected range of status/reason percentages across that set.

### 8. OBSERVATION: "0 edits after last check" contradiction fix is necessary but insufficient for audit #10
- **Location:** Plan item 5 (Git-operation noise): "Fix the contradictory '0 edits after last check' reason (never emit a count of 0; use 'no edits after last check' semantics consistently or omit)."
- **Detail:** The audit finds 38 git-operation events (merge, rebase, pull, checkout, stash, cherry-pick, mv) where `bashEditDiff` is produced but the only mutating segments are git operations; these are marked `kind git-op` and do not invalidate earlier passing checks. The plan's fix addresses the text contradiction but does not fully implement the audit's distinction: git-op events should appear in the file list with `maybeIncomplete` but should **not** change the status from `checked` to `unchecked`/`no-changes`. If the implementation simply stops emitting "0 edits" without also correcting the status-mutation logic, the contradiction may reappear in a different form (e.g., status flip due to misclassified edit count).
- **Fix:** Ensure that `kind git-op` events are handled as a separate branch in the status rule: they contribute to the file list/edit count but do NOT transition the prompt's status; add integration tests where a `git merge` command follows a passing check and verify the reason is "no edits after last check" (not "unchecked") and the status remains `checked`.

---
**Summary:** The plan addresses the majority of audit-identified root causes and provides a structured two-phase approach with measurable criteria. However, two blocking issues — subagent exclusion and fixture-versus-real-log gap — combined with three warnings about masked-exit guard fragility, shell-edit heuristic false positives, and incomplete top-10 coverage, mean the ≥95%/≥88% targets are contingent on additional validation beyond the planned scope. The measurement loop, while well-scoped for the audit's 5-project sample, needs explicit reproducibility guards for arbitrary user project directories. Phase size is appropriate (two focused phases) but the success criteria should include a "known limitations" clause for subagent and multi-language gaps.