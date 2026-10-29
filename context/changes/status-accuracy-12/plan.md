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

## Status: parked, owner decision

### Why each example is missed
1. **Dynamic targets (`echo > $x.ts`, `echo > $((2)).ts`, `echo hi > $[2]`)**:
   - In `packages/core/src/shell-edits.ts`:
     - `isUnknownTarget(w)` (lines 276-278) returns `true` for targets that start with `$`, `` ` ``, or are marked `dynamic`. The docstring explicitly states: `/** Unknown variable / substitution targets of a redirect: nothing reliable to say, so no edit. */`.
     - In `segmentMutation` (line 1751): `if (isUnknownTarget(r.target) || isIgnoredPath(r.target.text, poisoned)) continue;`. Unknown targets are dropped from edit reporting.
     - The segment falls through to `writesUnseen` (lines 832-839), which marks the command `opaque: true` with `edits: []`.

2. **FD-prefixed and combined redirects (`((x)) 2> f.ts`, `cmd 2>> f.ts`, `cmd &> f.ts`)**:
   - In `packages/core/src/shell-edits.ts`:
     - In `segmentMutation` (line 1745): `if ((r.fd !== "" && r.fd !== "1") || r.target === null) continue;`.
     - Any descriptor other than stdout (`""` or `"1"`) is filtered out and skipped completely.
     - Consequently, `2>` (stderr), `2>>` (stderr append), `&>` (stdout+stderr), and custom descriptors `3>`, etc. never produce edit targets.
     - `writesUnseen` flags them as unobserved writes, resulting in `opaque: true` and `edits: []`.

3. **Explicit stdout redirect (`cmd 1> f.ts`)**:
   - `1>` is already parsed as stdout. It reports `f.ts` for non-check commands, but when `cmd` is a recognized check, its redirects are captured as check logs rather than edits.

### Conflicting existing test expectations
Three tests in `packages/core/src/shell-edits.test.ts` (lines 81, 84, 85) within `test.each([...])("no edit: %s", (cmd) => { expect(files(cmd)).toEqual([]); })` explicitly pin the S-01 design rule:
- Line 81: `"echo hi 2> err.txt"` -> expects `files(cmd) === []`. If `2>` is treated as an edit, it yields `["err.txt"]` and fails.
- Line 84: `"ls &> all.txt"` -> expects `files(cmd) === []`. If `&>` is treated as an edit, it yields `["all.txt"]` and fails.
- Line 85: `"cmd > \"$OUT\""` -> expects `files(cmd) === []`. If unresolved dynamic targets fail closed to `(shell edit)`, it yields `["(shell edit)"]` and fails.

Per AGENTS.md (*"Never change or delete an existing test expectation to make a change pass. If you believe an expectation is wrong, stop and report it with evidence"*), these tests cannot be modified or deleted without owner decision.

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

### Options for owner decision
- **Option A (Keep S-01 design)**:
  - Close finding row 5 as rejected/intentional.
  - Retain current behavior: stderr/`&>` redirects and unresolved variable targets remain classified as non-edits (with opacity where appropriate), preserving lines 81, 84, and 85.
- **Option B (Fail closed)**:
  - Update `segmentMutation` to treat `2>`, `2>>`, `&>`, and unresolved dynamic targets (`SHELL_EDIT_FILE`) as file edits when target is not an ignored/scratch path.
  - Owner product decision to update the existing test expectations in `packages/core/src/shell-edits.test.ts` (lines 81, 84, 85).
  - Measure impact against real session logs.
