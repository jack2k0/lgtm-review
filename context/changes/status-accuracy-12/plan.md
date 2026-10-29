# Status accuracy, round 12: dynamic and fd-prefixed redirect targets

Context: row 5 of `context/archive/status-accuracy-11/reviews/findings.md`: a redirect with a dynamic target or an fd prefix is not reported as an edit although bash writes the file.
Examples: `echo > $x.ts`, `echo > $((2)).ts`, `echo hi > $[2]`, `((x)) 2> f.ts`, `cmd 2>> f.ts`, `cmd &> f.ts`, `cmd 1> f.ts`.

## Gate
```gate
allow: ^packages/core/src/(check-patterns|shell-edits)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/sa12-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa12-[a-z0-9-]+\.
allow: ^context/(changes|archive)/status-accuracy-12/
goldens: sa12-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Status: approved option B

### Why each example was missed
1. **Dynamic targets (`echo > $x.ts`, `echo > $((2)).ts`, `echo hi > $[2]`)**:
   - In `packages/core/src/shell-edits.ts`:
     - `isUnknownTarget(w)` (lines 276-278) returns `true` for targets that start with `$`, `` ` ``, or are marked `dynamic`. The docstring previously stated: `/** Unknown variable / substitution targets of a redirect: nothing reliable to say, so no edit. */`.
     - In `segmentMutation` (line 1751): `if (isUnknownTarget(r.target) || isIgnoredPath(r.target.text, poisoned)) continue;`. Unknown targets were dropped from edit reporting.
     - The segment fell through to `writesUnseen` (lines 832-839), which marked the command `opaque: true` with `edits: []`.

2. **FD-prefixed and combined redirects (`((x)) 2> f.ts`, `cmd 2>> f.ts`, `cmd &> f.ts`)**:
   - In `packages/core/src/shell-edits.ts`:
     - In `segmentMutation` (line 1745): `if ((r.fd !== "" && r.fd !== "1") || r.target === null) continue;`.
     - Any descriptor other than stdout (`""` or `"1"`) was filtered out and skipped completely.
     - Consequently, `2>` (stderr), `2>>` (stderr append), `&>` (stdout+stderr), and custom descriptors `3>`, etc. never produced edit targets.
     - `writesUnseen` flagged them as unobserved writes, resulting in `opaque: true` and `edits: []`.

3. **Explicit stdout redirect (`cmd 1> f.ts`)**:
   - `1>` is already parsed as stdout. It reports `f.ts` for non-check commands, but when `cmd` is a recognized check, its redirects are captured as check logs rather than edits.

### Conflicting existing test expectations
Three tests in `packages/core/src/shell-edits.test.ts` (lines 81, 84, 85) within `test.each([...])("no edit: %s", (cmd) => { expect(files(cmd)).toEqual([]); })` pinned the S-01 design rule:
- Line 81: `"echo hi 2> err.txt"` -> expected `files(cmd) === []`. Under Option B, yields `["err.txt"]`.
- Line 84: `"ls &> all.txt"` -> expected `files(cmd) === []`. Under Option B, yields `["all.txt"]`.
- Line 85: `"cmd > \"$OUT\""` -> expected `files(cmd) === []`. Under Option B, yields `["(shell edit)"]`.

Owner approved moving these 3 expectations out of the "no edit" table into an "edit" test with the new Option B results. No other existing expectations were modified.

### Bash verification (/tmp/claude-1000/-home-jack-git-lgtm-review/10357ea4-a50e-4f11-a874-ba1192382417/scratchpad/sa12)
Real bash creates or truncates files for all output redirect forms regardless of fd or target dynamics:
- `bash -c 'echo > "$x".txt'` -> creates `./.txt`
- `bash -c 'echo > $((2)).ts'` -> creates `./2.ts`
- `bash -c 'echo hi > $[2]'` -> creates `./2`
- `bash -c '(( 1 )) 2> f_arith.txt'` -> creates `./f_arith.txt`
- `bash -c 'true 2>> f2append.txt'` -> creates `./f2append.txt`
- `bash -c 'true &> fand.txt'` -> creates `./fand.txt`
- `bash -c 'echo hi 2> err.txt'` -> creates `./err.txt`
- `bash -c 'ls &> all.txt'` -> creates `./all.txt`
- `bash -c 'OUT=out.txt; cmd > "$OUT"'` -> creates `./out.txt`

### Implementation details (Option B)
- In `packages/core/src/shell-edits.ts` (`segmentMutation`):
  - Removed fd restriction `r.fd !== "" && r.fd !== "1"`. All output redirect descriptors (`r.op.startsWith(">")`) are evaluated.
  - Process substitutions `>(...)` and `<(...)` are filtered out so they do not produce spurious dynamic targets.
  - Ignored paths (`/dev/null`, `/dev/stderr`, `>&2`, `2>&1`, check log captures, scratch/tmp paths) remain preserved as non-edits.
  - Dynamic / unresolved targets (`isUnknownTarget(r.target)`) produce `SHELL_EDIT_FILE` (`"(shell edit)"`) with `targetOpaque = true`.
  - Non-stdout descriptors (`r.fd !== "" && r.fd !== "1"`) targeting non-documentation files set `fdOpaque = true` to preserve opacity semantics.
- Fixture `sa12-redirect-targets` added with golden records.

## Differential harness (3 seeds x 3000)
Harness extended with redirect forms (`>`, `>>`, `1>`, `1>>`, `2>`, `2>>`, `&>`, `&>>`, `((1)) 2>`, `cmd 2>`, `cmd 3>`, and distractors `/dev/null`, `/dev/stderr`, `>&2`, `2>&1`, `$OUT`, `$x.ts`).

- Seed 77 (N=3000):
  - `cases: 3000`
  - `branch-loss: 0`
  - `both-miss: 0`
  - `branch-gain: 0`
  - `branch-only-new-edits: 130`
- Seed 101 (N=3000):
  - `cases: 3000`
  - `branch-loss: 0`
  - `both-miss: 0`
  - `branch-gain: 0`
  - `branch-only-new-edits: 119`
- Seed 2024 (N=3000):
  - `cases: 3000`
  - `branch-loss: 0`
  - `both-miss: 0`
  - `branch-gain: 0`
  - `branch-only-new-edits: 91`

Sample branch-only new edits:
- `(( 0 )) || a || echo hi 2> f34.txt || 8 | 1<<2]` -> `f34.txt` (main edits: `[]`)
- `if (( 1 )) ; then (1) ; echo hi &>> f62.txt | (1); fi && echo q` -> `f62.txt` (main edits: `[]`)
- `x=$(((1) & echo hi 2> f122.txt ) | (1))` -> `f122.txt` (main edits: `[]`)
- `echo $[1 ) | 1 ) | 1]\necho hi 2> f119.txt` -> `f119.txt` (main edits: `[]`)

## Real-log audit (Option B)
Ran against real session logs (`~/.claude/projects`) comparing main CLI vs branch CLI.

### Aggregate diff metrics (`diff.mjs`):
- Total prompts: 164
- Status changed count: 0
- Transition table (from -> to: count): (none)
- Edited-file count changed: 1

### Accuracy comparison (`scripts/audit/compare.mjs`):
- Main CLI:
  - `A: rows 123, unique uuid 108 | main status 104/123 = 84.6% (unique 93/108 = 86.1%) | reason class 87/123 = 70.7% (unique 78/108 = 72.2%)`
  - `B: rows 173, unique uuid 158 | main status 145/173 = 83.8% (unique 134/158 = 84.8%) | reason class 127/173 = 73.4% (unique 118/158 = 74.7%)`
  - `C: rows 50, unique uuid 50 | main status 41/50 = 82.0% (unique 41/50 = 82.0%) | reason class 40/50 = 80.0% (unique 40/50 = 80.0%)`
- Branch CLI:
  - `A: rows 123, unique uuid 108 | main status 104/123 = 84.6% (unique 93/108 = 86.1%) | reason class 87/123 = 70.7% (unique 78/108 = 72.2%)`
  - `B: rows 173, unique uuid 158 | main status 145/173 = 83.8% (unique 134/158 = 84.8%) | reason class 127/173 = 73.4% (unique 118/158 = 74.7%)`
  - `C: rows 50, unique uuid 50 | main status 41/50 = 82.0% (unique 41/50 = 82.0%) | reason class 40/50 = 80.0% (unique 40/50 = 80.0%)`

## Review fixes
Review findings from Sonnet & Haiku addressed:
- **F1 (Sonnet 1 + Haiku 2: Temp targets)**:
  - Treat as scratch: variable assigned `$(mktemp ...)`, `$(mktemp -d ...)`, or backtick mktemp in earlier segments of the same command (tracked in `tempVars`), direct `"$(mktemp ...)"` targets (`isDirectMktemp`), and `${TMPDIR:-/tmp}` / `${TMPDIR:-/var/tmp}` prefixes (`VAR_DEF_PREFIX_RE`).
  - Later reassignment of a variable poisons it (fails closed to `climb` / edit).
  - Tests: `T=$(mktemp); echo > $T` -> `[]`, `T=$(mktemp -d); echo > $T/a.ts` -> `[]`, `echo > ${TMPDIR:-/tmp}/a.ts` -> `[]`, `echo > ${TMPDIR:-/var/tmp}/a.ts` -> `[]`, `echo hi >"$(mktemp)"` -> `[]`, `echo hi >"$(mktemp -d)/x"` -> `[]`, `T=$(mktemp); T=src; echo > $T/a.ts` -> `["(shell edit)"]`, `echo > ${TMPDIR:-src}/a.ts` -> `["(shell edit)"]`.
- **F2 (Haiku 1: Dynamic fd-dup targets)**:
  - `>&$fd`, `2>&$n`, `2>&"$x"`, `2>&${ERR}` do not report `(shell edit)`. The segment stays opaque as on main (`edits: []`, `opaque: true`).
  - When `r.op === ">&"` and `isUnknownTarget(r.target)`, mark `targetOpaque = true` and continue without adding `(shell edit)`.
- **F3 (Sonnet 3: `>|` and `2>|` noclobber override writes)**:
  - `splitSegments` recognizes `|` preceded by `>` as part of `>|`, not a pipeline operator.
  - `REDIRECT_RE` in check-patterns and `REDIR_RE` in shell-edits recognize `>|` and `2>|`.
  - Tests: `echo >| src/f.ts` -> `["src/f.ts"]`, `echo 2>| src/f.ts` -> `["src/f.ts"]`.
- **F4 (Sonnet 2: Assert `.opaque`)**:
  - sa12 tests assert `.opaque` where the rule specifies it.

### Review differential harness
Rerun differential against main (2 seeds x 3000):
- Seed 4242 (N=3000): `cases: 3000`, `branch-loss: 0`, `both-miss: 0`, `branch-gain: 0`, `branch-only-new-edits: 104`
- Seed 9001 (N=3000): `cases: 3000`, `branch-loss: 0`, `both-miss: 0`, `branch-gain: 0`, `branch-only-new-edits: 117`
- Branch-only losses: 0.

### Review round 2 fixes (commit: fix(status-accuracy-12): mktemp scratch only without a location, escaped >| (review 2))
- **G1 (Sonnet 1 + Haiku 2: mktemp scratch location restrictions)**:
  - `isAllowedMktempCmd`: only bare `mktemp`, or flags from `{-d, -u, -q, -t, --directory, --dry-run, --quiet}` and optionally ONE template that is an absolute path under `/tmp/` or `/var/tmp/` (or a bare template with `-t`) count as scratch.
  - `-p`, `--tmpdir`, relative templates, or unknown options disqualify scratch status (target treated as unresolved: `(shell edit)`).
  - Tests: `T=$(mktemp -p src -d); echo > $T/a.ts` -> `(shell edit)`, `T=$(mktemp --tmpdir=src); echo > $T` -> `(shell edit)`, `T=$(mktemp src/x.XXXX); echo > $T` -> `(shell edit)`, `T=$(mktemp -p .); echo > $T` -> `(shell edit)`, `T=$(mktemp -d /tmp/x.XXXX); echo > $T/a` -> `[]`, `T=$(mktemp -t x.XXXX); echo > $T` -> `[]`.
- **G2 (Sonnet 2: direct mktemp wired up)**:
  - `isDirectMktemp`: handles both `"$(mktemp)"` and `$(mktemp)` (and backtick versions) with the G1 argument rules.
  - `splitSegments`: only strips trailing `)` when `excess = closes - opens > 0` (or for subshells starting with `(`), preventing command substitution parens in commands like `echo > $(mktemp)` from having their closing paren stripped.
  - Tests: `echo > "$(mktemp)"` -> `[]`, `echo > $(mktemp)` -> `[]`, `echo > "$(mktemp -p src)"` -> `(shell edit)`, `echo > $(mktemp -p src)` -> `(shell edit)`.
- **G3 (Sonnet 3: unescaped > before |)**:
  - In `splitSegments`, require unescaped `>` before `|` (`cmd[i - 1] === ">" && bs % 2 === 0`).
  - Test: `echo \>| tee src/a.ts` -> `["src/a.ts"]`.

### Review 2 differential harness
Differential against main (fresh seeds x 3000):
- Seed 4243 (N=3000): `cases: 3000`, `branch-loss: 0`, `both-miss: 0`, `branch-gain: 0`, `branch-only-new-edits: 89`
- Seed 9003 (N=3000): `cases: 3000`, `branch-loss: 0`, `both-miss: 0`, `branch-gain: 0`, `branch-only-new-edits: 119`
- Branch-only losses: 0.

