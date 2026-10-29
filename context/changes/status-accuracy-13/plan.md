# Status accuracy, round 13: check logs in subshells, unset scratch names, local/declare mktemp

Context: deferred rows 5, 6, 10 of `context/archive/status-accuracy-12/reviews/findings.md`.
- R1 (row 5): `(pnpm check) 2>&1 > results.txt` (a check inside a subshell/group) reports its own log as an edit; a check's log redirect must stay a non-edit as it does without the parentheses.
- R2 (row 6): `$S` (and other TEMP_PREFIX_RE names) are scratch by NAME even when unset/unassigned; when the command shows no assignment and the name is not a known scratch env, decide by real bash behaviour, fail closed (when unsure: report the edit or mark opaque).
- R3 (row 10): `local T=$(mktemp)`, `declare`/`readonly`/`export` forms, `${TMPDIR:=/tmp}` and `${TMPDIR-/tmp}` over-report "(shell edit)"; treat them like `T=$(mktemp)` / `${TMPDIR:-/tmp}` (same mktemp argument rule as round 12).

## Gate
```gate
allow: ^packages/core/src/(check-patterns|shell-edits)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/sa13-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa13-[a-z0-9-]+\.
allow: ^packages/cli/src/api\.test\.ts$
allow: ^context/(changes|archive)/status-accuracy-13/
goldens: sa13-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Status: completed

### Bash verification and analysis

1. **R1: Check log redirects on subshells and compound command groupings (`(pnpm check) 2>&1 > results.txt`)**:
   - Real bash semantics:
     In bash, compound commands `( list ) [redirections]` and `{ list; } [redirections]` execute their inner command list and redirect the aggregate stdout/stderr according to the trailing redirections.
     `bash -c '(echo check output) 2>&1 > results.txt'` writes `results.txt`.
     Without parentheses, `pnpm check 2>&1 > results.txt` also writes `results.txt` in real bash, but in LGTM status accuracy: "a check's own redirects capture its log, not an edit."
   - Why it was missed:
     In `splitSegments`, closing parentheses `)` were only stripped if at the very end of the segment (`/\)\s*$/`). In `(pnpm check) 2>&1 > results.txt`, the closing `)` was followed by redirections, leaving `)` attached to the word: `check)`.
     Consequently, `stripPrefixes` removed `(`, leaving `pnpm check) 2>&1 > results.txt`. `toks[1]` was `"check)"`, so `matchSegment` failed to recognize the check.
     Because `isCheck` was `false`, `segmentMutation` treated `> results.txt` as a mutating file edit instead of a check log capture.
     In `{ pnpm check; } 2>&1 > results.txt`, the semicolon split the command into `{ pnpm check` (matched as check) and a trailing segment `} 2>&1 > results.txt` (only closing brace plus redirects, not matched as a check), which falsely reported `results.txt` as an edit after the check.
   - Fix:
     In `splitSegments`:
     - Strip the compound command closing delimiter `)` when followed only by redirections within the segment, so `(pnpm check) 2>&1 > results.txt` becomes `(pnpm check 2>&1 > results.txt`.
     - When a segment contains only a closing delimiter `}` or `)` followed by redirections (`isOnlyRedirects`), attach those compound redirections to the previous segment (`(segs[segs.length - 1].text += " " + redirections)`) and discard the empty delimiter segment.
     - `classifyCommand` and `classifyShellMutation` see the check command with its outer redirections, properly classifying it as `isCheck: true` and treating its redirects as check log captures (`edits: []`).

2. **R2: Unset/unassigned non-standard scratch names**:
   - Real bash semantics:
     When `SCRATCH` is unset/unassigned:
     `bash -c 'unset SCRATCH; echo > $SCRATCH/out.txt'` -> attempts to redirect to `/out.txt` at filesystem root (`Permission denied` or creates `/out.txt`).
     `bash -c 'unset SCRATCH; echo > "$SCRATCH/out.txt"'` -> attempts to redirect to `/out.txt` at root.
     In contrast, `TMPDIR`, `TMP`, `TEMP`, and `$S` (the repo/session scratch directory convention) are established scratch envs.
   - Why it was missed:
     `TEMP_NAME_RE = /^(?:TMPDIR|TMP|TEMP|S|SCRATCH\w*)$/` previously classified any path starting with `$SCRATCH...` as scratch by name, even when the command never set or assigned `SCRATCH`.
   - Fix:
     - Standard scratch envs (`TMPDIR`, `TMP`, `TEMP`, `S`) remain scratch by name.
     - Non-standard variables like `SCRATCH`, `SCRATCH_DIR`, etc. only count as scratch when explicitly assigned in the command to a temp root (via `mktemp` or `/tmp/...`).
     - When unassigned, dynamic targets like `$SCRATCH/out.txt` fail closed under Option B: reported as `SHELL_EDIT_FILE` (`"(shell edit)"`) with `opaque: true`.

3. **R3: `local T=$(mktemp)`, `declare`/`readonly`/`export` forms and parameter expansions (`${TMPDIR:=/tmp}`, `${TMPDIR-/tmp}`)**:
   - Real bash semantics:
     In bash:
     `local T=$(mktemp)`, `declare T=$(mktemp)`, `readonly T=$(mktemp)`, `export T=$(mktemp)`, `local -r T=$(mktemp)`, `declare -x T=$(mktemp)` assign `T` to a freshly created temporary file/directory.
     `${TMPDIR:=/tmp}`, `${TMPDIR:-/tmp}`, `${TMPDIR=/tmp}`, `${TMPDIR-/tmp}` all default to `/tmp` when `TMPDIR` is unset.
   - Why it was missed:
     - `ASSIGN_RE` and `poisonTempNamesInSegment` only handled `export ` and bare `NAME=value`. Declaration prefixes like `local `, `declare `, `readonly `, and flags like `-r`, `-x` were not matched, so `T` was never added to `tempVars`. Subsequent redirects like `echo > $T` or `echo > $T/a.ts` over-reported `"(shell edit)"`.
     - Reassignment of temp variables using `local T=src` or `declare T=src` was not detected, failing to poison `T`.
     - `VAR_DEF_PREFIX_RE` only matched `:-`, missing `:=`, `-`, and `=`.
   - Fix:
     - Recognize declaration builtins (`local`, `declare`, `typeset`, `readonly`, `export`) with optional flags (`-[A-Za-z]+`) in `collectAssignments` and `poisonTempNamesInSegment`.
     - When assigning an allowed `mktemp` command or temp root, add the variable to `tempVars`.
     - When reassigning a temp variable to a non-temp root (with or without declaration prefix), poison the variable.
     - Broaden `VAR_DEF_PREFIX_RE` to match `(?::=|:-|-|=)` parameter fallback expansions.

## Differential harness (3 seeds x 3000)
Harness `/tmp/claude-1000/-home-jack-git-lgtm-review/10357ea4-a50e-4f11-a874-ba1192382417/scratchpad/sa12-haiku/edit-diff-sa12.mjs` run against main and branch compiled from git archives:

- Seed 77 (N=3000):
  - `cases: 3000`
  - `branch-loss: 0`
  - `both-miss: 0`
  - `branch-gain: 0`
  - `branch-only-new-edits: 0`
- Seed 101 (N=3000):
  - `cases: 3000`
  - `branch-loss: 0`
  - `both-miss: 0`
  - `branch-gain: 0`
  - `branch-only-new-edits: 0`
- Seed 2024 (N=3000):
  - `cases: 3000`
  - `branch-loss: 0`
  - `both-miss: 0`
  - `branch-gain: 0`
  - `branch-only-new-edits: 0`

## Round notes: Owner addition (CI timeout fix)
- Owner instruction: CI run 40911943046 on main 41878d0 failed because `packages/cli/src/api.test.ts` test 'every fixture prompt validates against PromptDetail and matches the analysis' timed out (5010ms > 5000ms default) on the GitHub runner.
- Raised that single test's timeout to 20000 ms via the test's timeout argument in a separate commit; no expectation or code changes.

## Review fixes

Haiku review findings addressed:
1. **F1: Standalone `${NAME:=value}` / `${NAME=value}` parameter expansion poisoning**:
   - In `poisonTempNamesInSegment`, scanned parsed words for standalone `${NAME:=value}` and `${NAME=value}` forms (e.g. `: ${TMPDIR:=src}`). If `value` is not a temp root or allowed `mktemp`, the name is added to `poisoned`.
   - In `splitSegments`, replaced blanket `text.replace(/\s*\}+$/, "")` with `trimTrailingCompoundBraces` so that trailing `}` belonging to parameter expansions (`${...}`) is not stripped, preserving parameter expansions at segment ends.
2. **F2: Check redirect exemption restricted to log-like targets**:
   - Check redirects (`> file`, `>> file`) and `tee` piped from checks are exempt ONLY when the target is log-like (`isCheckLogTarget`: matches `isIgnoredPath`, or check log naming conventions such as `results.txt`, `results.json`, `out.json`, `report.xml`, etc.).
   - Code files and other non-log targets redirected from a check (`{ pnpm check; } > src/out.ts`, `(pnpm check) > src/out.ts`, `pnpm check > src/out.ts`) remain mutating edits (`["src/out.ts"]`).
3. **Nits 3-5**:
   - Confirmed by owner to remain as designed (`$S` remains a recognized scratch name).
4. **Differential Generator (`edit-diff-sa13.mjs`)**:
   - Copied `edit-diff-sa12.mjs` to `/tmp/claude-1000/-home-jack-git-lgtm-review/10357ea4-a50e-4f11-a874-ba1192382417/scratchpad/sa13-diff/edit-diff-sa13.mjs` and added check commands (`pnpm`, `npm test`, `vitest`, `turbo`, with and without compound groups and redirects to log and code files).
   - Re-run with 2 fresh seeds x 3000 against main:
     - SEED=4242 N=3000: cases 3000, branch-loss 0, both-miss 0, branch-gain 4, branch-only-new-edits 32
     - SEED=90817 N=3000: cases 3000, branch-loss 0, both-miss 0, branch-gain 13, branch-only-new-edits 31
