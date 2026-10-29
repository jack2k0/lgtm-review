# Status accuracy, round 10: quote- and arithmetic-aware heredoc start detection

Deferred from status-accuracy-9 review findings (`context/archive/status-accuracy-9/reviews/findings.md` rows 1-2). `inCommentOrArithmetic` and `parseHeredocStarts` did not track quotes across the line (causing `<<` inside quotes such as `python3 -c "print(1 << 2)"` or `grep "<<EOF"` to start false heredocs) and reset command scanning at `|`/`;` inside arithmetic contexts (causing shifts like `8 | 1<<2` inside `$((...))` to start false heredocs).

## Rules
- Q1: a `<<` inside single quotes, double quotes or `$'...'` (quote still open at the `<<`, tracked across the WHOLE line, not reset at `;`/`|`) is not a heredoc start. Examples: `python3 -c "print(1 << 2)"`, `grep "<<EOF" "a b"`, `echo 'a <<B'`.
- Q2: an arithmetic context `$((`, `$[` still open at the `<<` makes it a shift even when a `|`, `;` or `&` sits between them inside the arithmetic. Example: `echo $((8 | 1<<2)); cat <<E | python3`.
- Q3: investigate `let x=1<<2; cat <<A` (reported as missing the real start `A`); fix if bash shows `A` is a heredoc. In real bash, unquoted `let x=1<<2` parses `<<2` as a heredoc with delimiter `2`, followed by heredoc `A`; quoted `let "x = 1 << 2"; cat <<A` shifts in `let` and has only heredoc `A`. The previous `let` regex in `inCommentOrArithmetic` incorrectly treated unquoted `let` as arithmetic context; removing it aligns with bash (unquoted `let x=1<<2` yields both heredocs `2` and `A`, while quoted `let "x = 1 << 2"` has only `A` via Q1).
- Bash verification in scratchpad `/tmp/claude-1000/-home-jack-git-lgtm-review/10357ea4-a50e-4f11-a874-ba1192382417/scratchpad/sa10`:
  - Q1:
    - `python3 -c "print(1 << 2)"` -> `4`
    - `echo 'a <<B'` -> `a <<B`
    - `echo $'foo <<EOF bar'` -> `foo <<EOF bar`
    - `python3 -c "import sys; print(1 << 2)"` -> `4` (semicolon inside quotes does not reset quote)
  - Q2:
    - `echo $((8 | 1<<2))` -> `12`
    - `echo $[8 | 1<<2]` -> `12`
    - `echo $((8 | 1<<2)); cat <<E | python3` (+ body `print("hi")\nE`) -> `12\nhi`
  - Q3:
    - `let x=1<<2; cat <<A` (+ bodies `body2\n2\nbodyA\nA`) -> `bodyA\nx=1` (bash reads heredoc `2` then `A`)
    - `let "x=1<<2"; cat <<A` (+ body `bodyA\nA`) -> `bodyA\nx=4` (bash reads only heredoc `A`)

## Gate
```gate
allow: ^packages/core/src/(check-patterns|shell-edits)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/sa10-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa10-[a-z0-9-]+\.
allow: ^context/(changes|archive)/status-accuracy-10/
goldens: sa10-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Phase 1 (Q1-Q3)
- Tests failing on main / current code (named "sa10 ..."):
  - `python3 -c "print(1 << 2)"` followed by edit -> no heredoc started, edit detected.
  - `grep "<<EOF" "a b"` / `sed -i s/a/b/ src/a.ts` / `EOF a` -> edit of `src/a.ts` is reported and not opaque.
  - `echo $((8 | 1<<2)); cat <<E | python3` -> shift inside arithmetic ignored, `E` read as heredoc to python3.
  - `let "x = 1 << 2"; cat <<A` -> only `A` is heredoc.
  - `let x=1<<2; cat <<A` -> both `2` and `A` are heredocs.
- One fixture `sa10-heredoc-quotes` (session with quoted heredoc tokens and check; labels from the rules).
- Done: `pnpm check` green; gate exit 0/2.

## Review fixes
- F1: `$((` or command-start `((` is arithmetic only if its inner level closes with `))`; otherwise bash treats as command substitution or nested subshells (`((echo ok) ; echo hi)` -> `ok\nhi`, `echo $((echo ok) ; echo hi)` -> `ok hi`).
- F2: `#` starts a comment only after unescaped whitespace or `;&|()` or at start (`echo a\ #b; echo hi` -> `a #b\nhi`).
- F3: `<<` preceded by an odd number of backslashes is an escaped `<` followed by input redirect `<word>`, not a heredoc start (`echo \<<E` -> bash prints `E: No such file or directory`).

