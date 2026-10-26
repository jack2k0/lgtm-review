# Plan Review: Status accuracy, round 3 (status-accuracy-3)

**Plan under review:** `context/changes/status-accuracy-3/plan.md`  
**Reviewer:** agy  
**Date:** 2026-10-26  

---

### Findings and Actionable Points

#### 1. Per-file `bashEditDiff` attribution requires splitting `EditRec` entries in `analyze.ts`
- **File:line:** [packages/core/src/analyze.ts:626-669](packages/core/src/analyze.ts#L626-L669)
- **Issue:** The plan states in Desired End State G that diff files will be attributed per-file (`gitOp` per file). However, in `analyze.ts`, `gitOp`, `doc`, and `scratch` are boolean properties of the aggregate `EditRec` pushed to `use.prompt.edits` (L667: `{ seq: seqAt, files: touches, gitOp, doc, scratch }`), and `judge()` filters whole `EditRec` records (L245). If a single `EditRec` contains both git-made code touches and plain documentation touches, `touches.every(isDocPath)` evaluates to `false` and `gitOp` must be `false`, causing the entire group (including the merged code files) to be judged as a plain code edit and wrongly failing the check. `analyze.ts` must explicitly split touches into separate `EditRec` entries (one with `gitOp: true` and one with `gitOp: false` evaluating `doc`/`scratch` only over its subset).
- **Concrete input:** Command `git merge feature && sed -i 's/x/y/' plan.md` with `bashEditDiff` containing `src/a.ts` and `plan.md`.

#### 2. Target matching in mixed git commands fails when `hasCd` is true
- **File:line:** [packages/core/src/shell-edits.ts:363](packages/core/src/shell-edits.ts#L363) and [packages/core/src/analyze.ts:650](packages/core/src/analyze.ts#L650)
- **Issue:** `resolveTarget(file, cwd, hasCd)` returns relative `file` unchanged whenever `hasCd` is `true` (L364). However, `ev.bashEditDiff` contains absolute paths (`/home/user/project/...`). Matching `bashEditDiff` paths against unresolved relative targets will always fail. As a result, code files edited by plain edits (e.g. `sed -i`) in a command containing `cd` will fail to match, be attributed as git-made (`gitOp: true`), and wrongly leave the prompt status as `checked`.
- **Concrete input:** Command `cd packages/core && git merge feature && sed -i 's/x/y/' src/a.ts` where `bashEditDiff` has `/repo/packages/core/src/a.ts` and `resolveTarget` returns `src/a.ts`.

#### 3. Mutation ordering ignores git operations following checks
- **File:line:** [packages/core/src/shell-edits.ts:410-415](packages/core/src/shell-edits.ts#L410-L415) and [packages/core/src/analyze.ts:628](packages/core/src/analyze.ts#L628)
- **Issue:** `classifyShellMutation` computes `order` (`"before-check"` vs `"after-check"`) by checking only `plainIdx` against `checkIdx`. If a command executes a plain edit before a check, and then merges code after the check, `sm.order` is evaluated as `"before-check"`. When a file in `bashEditDiff` was touched by both the plain edit and the merge, `orderedSeq` assigns it `seq - 0.5` (before the check), falsely declaring the post-check merge changes covered by the earlier passing check.
- **Concrete input:** Command `sed -i 's/x/y/' src/a.ts && pnpm test && git merge feature` where `feature` brings additional modifications to `src/a.ts`.

#### 4. `flock -c "<cmd>"` cannot be handled by `PREFIXES` alone
- **File:line:** [packages/core/src/check-patterns.ts:150-180](packages/core/src/check-patterns.ts#L150-L180)
- **Issue:** `stripPrefixes()` only slices matching prefixes from the beginning of a string (`s = s.slice(m[0].length).trimStart()`). If `PREFIXES` matches `flock ... -c ["']?`, the closing quote remains attached to the end of the string (e.g. `"pnpm test"` becomes `pnpm test"`). This corrupts tokenization (`tokens("pnpm test\"")` yields `["pnpm", "test\""]`) and causes `matchPackageManager` and `SIMPLE_RES` to fail. Quoted command unwrapping requires stripping the matching closing quote or unquoting the `-c` argument.
- **Concrete input:** Command `flock /tmp/check.lock -c "pnpm test"`.

#### 5. Flock option parsing misses unspaced flag values and combined flags
- **File:line:** [packages/core/src/check-patterns.ts:150-164](packages/core/src/check-patterns.ts#L150-L164)
- **Issue:** Standard `flock(1)` invocations frequently use combined flags (`-nx`, `-on`, `-xn`), unspaced flag arguments (`-w10`, `-E1`), equals signs (`--wait=10`), or file descriptor numbers (`flock -n 9 cmd`). Specifying separate tokens like `-n -x -s -u -o -e` and `-w <secs>` in the regex will treat `-w10` or `-nx` as the lockfile argument, leaving the actual lockfile path as the start of the command and failing check recognition.
- **Concrete input:** Command `flock -nx /tmp/x.lock pnpm test` or `flock -w10 /tmp/x.lock ./scripts/check.sh`.

#### 6. `pythonWrites` resolution misses intermediate variables from `sys.argv[1]`
- **File:line:** [packages/core/src/shell-edits.ts:222-235](packages/core/src/shell-edits.ts#L222-L235)
- **Issue:** Desired End State R states that `<name>` is resolved when assigned a string literal (`name = "x"`), and `sys.argv[N]` when passed in `open(sys.argv[1], "w")`. Real Python heredocs in orchestration scripts almost universally bind `sys.argv[1]` to a variable first (`p = sys.argv[1]; open(p, "w")` or `p = Path(sys.argv[1]); p.write_text(...)`). Under the plan as written, assigning `sys.argv[1]` to a variable will not count as a string literal assignment, leaving the target as `(shell edit)` (code) and wrongly turning documentation updates into unchecked code edits.
- **Concrete input:** Heredoc command: `R=docs/x.md && python3 - "$R" <<'EOF'\nimport sys\np = sys.argv[1]\nopen(p, "w").write("done")\nEOF`.

#### 7. Directory detection for `git mv` belongs in `analyze.ts`, not `shell-edits.ts`
- **File:line:** [packages/core/src/shell-edits.ts:289-309](packages/core/src/shell-edits.ts#L289-L309) and [packages/core/src/analyze.ts:626](packages/core/src/analyze.ts#L626)
- **Issue:** Phase 2 assigns `shell-edits.ts` the responsibility to detect "directory `git mv` targets". However, `classifyShellMutation(command, repo)` operates purely on command text without access to `bashEditDiff` or filesystem state. Whether a `git mv` operand is a directory can only be determined by cross-referencing against diff paths (`paths.some(p => p.startsWith(target + "/"))`), which is only available inside `analyze.ts`.
- **Concrete input:** Command `git mv context/changes/x context/archive/x` with `bashEditDiff` containing `context/archive/x/plan.md`.

#### 8. Setting `gitOnly = true` on doc-only plain edits violates PRD FR-015 reason formatting
- **File:line:** [packages/core/src/analyze.ts:247-252](packages/core/src/analyze.ts#L247-L252)
- **Issue:** Desired End State G specifies: "Without a diff, `gitOnly` = no plain edit whose target class is code (doc/scratch plain targets do not clear it)." When a command has a git operation and a plain documentation edit, setting `gitOnly = true` causes `analyze.ts` (L646) to set `gitOp: true` on the `EditRec`. In `judge()`, `nonGit = p.edits.filter(e => !e.gitOp)` becomes empty (L247), causing the prompt to return reason `"no edits (git operations only)"` (L248) instead of the PRD FR-015 required `"no code edits (documentation only)"`. The plan itself notes uncertainty about this in Phase 2 test (b).
- **Concrete input:** Command `git merge feature && sed -i 's/x/y/' plan.md` in a session without `bashEditDiff`.
