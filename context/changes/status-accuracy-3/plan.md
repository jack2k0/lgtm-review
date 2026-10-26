# Status accuracy, round 3 Implementation Plan

## Overview

The independent real-log audit of 2026-10-26 (`scripts/audit/`, report `context/archive/status-accuracy-2/reviews/audit-2026-10-26.md`) measured 74.0% status match on prompts without subagents and 68.3% overall, far below the >= 97% target. A manual adjudication of the 52 disagreements found the tool wrong in about 45, from three rule gaps that appear with multi-agent orchestration (worktrees, merges, lock-wrapped check scripts, Python heredoc edits):

1. **Mixed git + documentation commands** (about 19 rows). `rebase/merge/mv … && sed -i plan.md && git commit` makes the whole `bashEditDiff` (code files brought in by the git operation) count as a plain code edit, because `gitOnly` is false as soon as any plain edit exists. A directory moved with `git mv` (extensionless path) is classed as code.
2. **Wrapped check commands** (about 14 rows). `flock <lock> scripts/check.sh` (and `ionice`, `setsid`, `stdbuf`) is not stripped before check matching, so the check is invisible.
3. **Unresolved shell write targets** (about 16 rows). A Python heredoc writing `open(p, "w")` with `p = "context/plan.md"`, or `python3 - "$R"` with `R=docs/x.md`, is recorded as `(shell edit)` and counted as code.

PRD rules are unchanged (S-11, S-16, S-18, S-20 already say what is right); this slice makes the tool follow them. Owner questions from the adjudication (git-only merge prompts as `no-changes`; ordering of late subagent checks; unresolvable targets as code) are NOT decided here: current behaviour stays where the PRD is unclear.

## Current State Analysis

- `packages/core/src/check-patterns.ts` L150-164 `PREFIXES`: wrappers stripped before matching (`time|nohup|command|exec`, `nice`, `timeout`, `env`, `sudo`, `uv run`, …). No `flock`, `ionice`, `setsid`, `stdbuf`.
- `packages/core/src/shell-edits.ts` L373-420 `classifyShellMutation`: `gitOnly = !anyPlain`; every plain mutating segment sets `anyPlain`, whatever its target class.
- `packages/core/src/analyze.ts` L620-660: with a non-empty `bashEditDiff`, all diff files get `gitOp = sm.gitOnly`; without a diff, `sm.edits` are resolved with `resolveTarget` and classified.
- `packages/core/src/shell-edits.ts` L217-235 `pythonWrites`: only a string literal as the first `open()` argument resolves; anything else adds `SHELL_EDIT_FILE`.
- `packages/core/src/hints.ts`: `isDocPath`, `isScratchPath` decide doc/scratch classes.

## Desired End State

- **W (wrappers):** `flock [opts] <lockfile> <cmd…>` (opts: `-n -x -s -u -o -e`, `-w <secs>`, `-E <code>`, long forms), `ionice [-c N] [-n N] [-t]`, `setsid [-f -w]`, `stdbuf -oL/-eL/-i0…` are stripped like `timeout`. `flock … -c "<cmd>"` matches the quoted command. Also in the shell-edit segment parser (a wrapped `sed -i` stays an edit).
- **G (git attribution):** in a command that has a history-moving git operation (`merge`, `rebase`, `pull`, `cherry-pick`, `revert`, `stash`, `checkout`, `switch`, `reset`, `restore`, `am`, `mv`), files of `bashEditDiff` are attributed per file: a file that matches a resolved plain-edit target (after `resolveTarget`) is a plain edit; every other diff file is git-made (`gitOp`). If any plain-edit target is unresolved (`(shell edit)`), keep today's behaviour for that command (all plain). Without a diff, `gitOnly` = no plain edit whose target class is code (doc/scratch plain targets do not clear it). A `git mv` target with no extension that is a directory in the diff's file list (other diff paths start with `<target>/`) is not itself a file.
- **R (target resolution):** `pythonWrites` resolves `open(<name>, "w")`, `Path(<name>).write_text(`, `<name>.write_text(` when `<name>` is assigned a string literal (`name = "x"`, `name = Path("x")`) in the heredoc, and `sys.argv[N]` when the interpreter is called as `python3 - <args>` whose N-th argument is a literal or a `$VAR`/`"$VAR"` assigned a literal earlier in the same command (`R=docs/x.md && python3 - "$R" <<'EOF'`). Unresolvable stays `(shell edit)` (code, conservative).

## What We're NOT Doing

- No change to the three owner questions (see Overview). No use of `toolUseResult.gitOperation` (rare, not covering merge/mv).
- Subagent shell edits not attributed to the host prompt (1 row): later.
- No schema, web or CLI change. No changes to existing fixtures, labels or goldens.

## Ownership

```gate
allow: ^packages/core/src/(check-patterns|shell-edits|analyze)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/(wrapped-checks|git-doc-mix|heredoc-targets|shell-gaps-2)\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/(wrapped-checks|git-doc-mix|heredoc-targets|shell-gaps-2)\.
allow: ^context/changes/status-accuracy-3/
allow: ^scripts/audit/
goldens: (wrapped-checks|git-doc-mix|heredoc-targets|shell-gaps-2)\.
labels: new-only
deps: no
schema: no
```

## Plan-review amendments (Agy, 2026-10-26; binding)

- A1 (review #1, #8): `analyze.ts` splits one Bash command's touches into separate `EditRec`s: git-made files (`gitOp: true`) and plain files (`doc`/`scratch` computed over that subset only). Same split in the no-diff path: a mixed command with a git op and a doc-only plain edit gives a git record plus a doc record, so the reason stays `no code edits (documentation only)` where FR-015 says so.
- A2 (#2): plain-edit targets are matched against `bashEditDiff` paths after resolving them against the call's cwd; when `hasCd` leaves a target relative, match a diff path that ends with `/<target>`; when nothing matches, the target counts as unresolved (today's behaviour for the whole command).
- A3 (#4, #5): wrappers are parsed word by word, not with one regex: `flock` takes any number of option words (`-nx`, `-w10`, `-w 10`, `--wait=10`, `-E 1`, `--conflict-exit-code 1`), then a lockfile or fd number, then the command; `flock <lock> -c '<cmd>'` / `-c "<cmd>"` unquotes `<cmd>`. Same approach for `ionice`, `setsid`, `stdbuf`.
- A4 (#6): `pythonWrites` follows one level of variable binding: `p = sys.argv[N]`, `p = Path(sys.argv[N])`, `p = "lit"`, `p = Path("lit")`.
- A5 (#7): the directory test for an extensionless `git mv` target happens in `analyze.ts` against the diff paths; `shell-edits.ts` only reports the git-moved targets.
- A6 (orchestrator, during phase 3): the existing expectation `shell-edits.test.ts:33` (`Path('a').write_text('x')` → `(shell edit)`) changes to `["a"]`: a literal `Path(...)` receiver is exactly what R resolves; the status does not change (`a` is still a code path). This is the only existing expectation this slice may change.
- Rejected #3: a file a merge brings in after a check is git-made and never counts as a code edit (S-11), so the plain edit's order is the only one that matters.

## Phase 1: Wrapped checks (W)

- `check-patterns.ts`: add the wrappers to `PREFIXES`; `flock -c "<cmd>"` form.
- Tests in `check-patterns.test.ts`: each wrapper with a test command, a script check (`scripts/check.sh`), and a non-check (`flock /tmp/l ls`); a wrapped `sed -i` in `shell-edits.test.ts` stays an edit.
- New fixture `wrapped-checks.jsonl` + `.labels.json` + goldens: prompt 1 edit code, `flock /tmp/x.lock ./scripts/check.sh` passes → checked; prompt 2 edit, `flock -w 600 lock bash scripts/verify-all.sh` in the background with a passing notification → checked; prompt 3 edit, `ionice -c3 nice pnpm test` failing → failing.
- [x] done when: tests and the fixture pass; `pnpm check` green; gate exit 0/2.

## Phase 2: Git attribution in mixed commands (G)

- `shell-edits.ts`: return per-plain-edit resolved targets and their classes (or enough for `analyze.ts` to classify), plus `hasHistoryGitOp`; `gitOnly` ignores doc/scratch plain targets; directory `git mv` targets.
- `analyze.ts`: per-file attribution of `bashEditDiff` for commands with a history-moving git op (Desired End State G).
- Tests in `analyze.test.ts`/`shell-edits.test.ts`: (a) edit code, test passes, then `git merge b && sed -i 's/x/y/' plan.md && git commit -qam m` with a diff listing `src/a.ts` and `plan.md` → still checked, reason with the documentation tail; (b) the same command as the only activity of a prompt → no-changes (`git operations` / documentation reason as today's rules give); (c) `git mv context/changes/x context/archive/x && sed -i … context/archive/x/change.md` → no code edit; (d) a mixed command whose plain edit writes `src/b.ts` → `src/b.ts` counts as a code edit, the merged files do not; (e) unresolved plain target → today's behaviour.
- New fixture `git-doc-mix` with goldens covering (a), (b), (d).
- [x] done when: tests pass; existing labels and goldens unchanged; `pnpm check` green; gate exit 0/2.

## Phase 3: Heredoc and variable targets (R)

- `shell-edits.ts` `pythonWrites` (and its caller for the `python3 - args` form).
- Tests: `p = "docs/x.md"; open(p, "w")` → `docs/x.md`; `Path("a/b.md").write_text(…)`; `p = Path("a.md"); p.write_text`; `python3 - "$R" <<EOF … open(sys.argv[1], "w")` with `R=context/plan.md &&` before; `open(f"{x}.md", "w")` → `(shell edit)`; a literal under the scratchpad → ignored.
- New fixture `heredoc-targets` with goldens: code edit + passing check, then a heredoc doc write → checked with the documentation tail; a heredoc code write after the check → unchecked.
- [x] done when: tests pass; `pnpm check` green; gate exit 0/2.

## Phase 5: Remaining tool gaps from the POST audit (adjudication round 2)

POST after phases 1-3: A 85.5%, B 83.5% (from 74.0% / 68.9%); 27 disagreements left, tool wrong in 18. Fix:
- R1 `shell-edits.ts` `pythonWrites`: resolve each write with the binding in effect at its position (a name rebound later does not become unresolved); support `NAME + "lit"` / `"lit" + NAME` and `NAME / "lit"` (pathlib) when the parts resolve; `os.path.join(lit|NAME, …)`.
- R2 `shell-edits.ts`: `$VAR` / `${VAR}` / `"$VAR"` operands of `sed -i`, redirects, `tee`, `cp`/`mv`/`rm` resolve from literal assignments earlier in the same command (the same `vars` map used for python argv).
- R3 `analyze.ts` `plainDiffPaths`: a doc/scratch plain target absent from a capped `bashEditDiff.files` does not make the match fail (it cannot change the code attribution); a code target absent from the diff still does.
- R4 `shell-edits.ts` `segmentMutation`: only the heredoc fed to the python segment's stdin is scanned for python writes, not every heredoc in the command.
- Tests for each, failing on the code before this phase; extend the `heredoc-targets` / `git-doc-mix` fixtures only by NEW fixtures (e.g. `heredoc-targets-2`), never by editing the new ones' labels after the fact unless the label was wrong by the plan (then say so).
- [x] done when: tests pass; `pnpm check` green; gate exit 0/2.

## Phase 6: Truth-script fixes (audit tool, a different agent than the tool phases)

`scripts/audit/truth.py`: unwrap `flock` (and the other wrappers) for every runner, not only scripts; `git diff <file>` is not a check; a wait loop (`pgrep`/`sleep`/`until`) is not a check; expand `cd $VAR` from same-command assignments. One synthetic fixture case each in `scripts/audit/fixtures`, self-test green.
- [x] done when: `node --test scripts/audit/audit.test.mjs` passes; gate exit 0/2.

## Phase 4: Real-log audit (orchestrator only)

- PRE = main before this change, POST = branch: `node scripts/audit/compare.mjs` (aggregates only) and status transitions PRE→POST (counts only).
- Target: A >= 95%, no category of the adjudication still above 2 rows; record in `context/changes/status-accuracy-3/reviews/audit.md`.

## Review

Tier High (status rule). Two reviewers from models other than the implementer, cross-verification of Important findings, ledger `reviews/findings.md`, merge gate with `--merge`.
