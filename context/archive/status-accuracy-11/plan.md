# Status accuracy, round 11: arithmetic forms, $'' delimiters, quoted substitutions

Deferred from status-accuracy-10 review findings (`context/archive/status-accuracy-10/reviews/findings.md` rows 5, 6, 7, 10, 11).

## Rules
- R1 (row 5): `( ((` and `{ ((` (and after `;`, `&&`, `|`, `then`, `do`, `else`) start arithmetic like a command-start `((`, still only when closed by `))`. When not closed by `))`, bash falls back to subshells / command substitutions.
- R2 (row 6): `$'...'` in a heredoc delimiter honours backslash escapes (`<<E$'a\'b'` -> delimiter `Ea'b`).
- R3 (row 7): `if (( x > 1 ))` must not produce an edit target `1` (the arithmetic's `>` is not a redirect).
- R4 (row 10): the heredoc scan must see an arithmetic context that started on an earlier line of the same command (a `$((`/`((` spanning a newline with `<<` inside is a shift).
- R5 (row 11): `$((cmd) ; ...)` / `$(cmd; ...)` inside double quotes: edits in the substitution are found (substitutionBodies recognizes `$((` that falls back to command substitution and parses bodies inside double quotes).

## Bash verification (/tmp/claude-1000/-home-jack-git-lgtm-review/10357ea4-a50e-4f11-a874-ba1192382417/scratchpad/sa11)
- R1:
  - `bash -c '( (( 1 << 2 )) ); echo $?'` -> `0` (shift executed in subshell)
  - `bash -c '{ (( 1 << 2 )); }; echo $?'` -> `0` (shift executed in brace group)
  - `bash -c 'if true; then (( 1 << 2 )); fi; echo $?'` -> `0`
  - `bash -c 'if false; then :; else (( 1 << 2 )); fi; echo $?'` -> `0`
  - `bash -c 'for x in 1; do (( 1 << 2 )); done; echo $?'` -> `0`
  - `bash -c '( ((echo ok) ; echo hi) )'` -> `ok\nhi` (unclosed `((` falls back to nested subshell)
- R2:
  - `bash -c "cat <<E\$'a\\'b'\nline1\nEa'b\necho done"` -> `line1\ndone` (delimiter `Ea'b`)
- R3:
  - `bash -c 'x=5; if (( x > 1 )); then echo "x is greater"; fi; ls 1'` -> `x is greater` and `ls: cannot access '1': No such file or directory` (no redirect file `1` created)
- R4:
  - `bash -c 'printf '\''echo $((\n1 << 2)) ; cat <<E\nZZB1\nE\necho ZZB2\n'\'' | bash'` -> `4\nZZB1\nZZB2` (`echo ZZB2` runs as a command)
- R5:
  - `bash -c 'echo "$((echo ok) ; echo EDIT_RAN)"'` -> `ok\nEDIT_RAN`
  - `bash -c 'echo "$(echo ok ; echo EDIT_RAN)"'` -> `ok\nEDIT_RAN`

## Gate
```gate
allow: ^packages/core/src/(check-patterns|shell-edits)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/sa11-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa11-[a-z0-9-]+\.
allow: ^context/(changes|archive)/status-accuracy-11/
goldens: sa11-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Phase 1 (R1-R5)
- Tests failing on main / current code (named "sa11 ..."):
  - R1: `( (( 1 << 2 )) )` and `{ (( 1 << 2 )) }` do not start heredoc; `( ((echo ok) ; sed -i s/a/b/ src/a.ts) )` finds edit.
  - R2: `cat <<E$'a\\'b'` parses delimiter as `Ea'b`.
  - R3: `if (( x > 1 )); then sed -i s/a/b/ src/f.ts; fi` does not produce edit target `1`.
  - R4: `echo $((\n1 << 2)) ; cat <<E\nZZB1\nE\nsed -i s/a/b/ src/a.ts` detects edit of `src/a.ts`.
  - R5: `echo "$((echo ok) ; sed -i s/a/b/ src/a.ts)"` detects edit of `src/a.ts`.
- One fixture `sa11-arith-forms` with goldens.
- Differential verification: edit-diff and hd-diff across 3 seeds x 3000 cases.
  - edit-diff (N=3000):
    - seed 77: branch-loss 0, both-miss 1, branch-gain 0
    - seed 101: branch-loss 0, both-miss 0, branch-gain 0
    - seed 2024: branch-loss 0, both-miss 0, branch-gain 1
  - hd-diff (N=3000):
    - seed 5: cases 2466, branch-wrong 2, main-wrong 4, branch-only-wrong 0
    - seed 77: cases 2471, branch-wrong 1, main-wrong 1, branch-only-wrong 0
    - seed 2024: cases 2451, branch-wrong 2, main-wrong 2, branch-only-wrong 0

## Review fixes
- F1: `stripPrefixes` does not strip `(` when `s` starts a closed `((...))` arithmetic command, preventing `(( x > 1 ))` from creating spurious redirect file `1`. Bash: `(( x > 1 )); ls 1` -> `ls: cannot access '1': No such file or directory`; `(( x > 1 )) > out.txt; ls out.txt` -> `out.txt`.
- F2: `$'...'` heredoc delimiter decodes `\xHH`, octal `\NNN` (1-3 digits), `\uHHHH`, `\UHHHHHHHH`, `\cX`. Bash: `cat <<E$'\x41'` / `<<E$'\101'` / `<<E$'\u0041'` / `<<E$'\U00000041'` close on `EA`.
- Review differential (2 seeds x 3000):
  - edit-diff: seed 77 (branch-loss 0, both-miss 1, branch-gain 0); seed 101 (branch-loss 0, both-miss 0, branch-gain 0). Branch-loss: 0.
  - hd-diff: seed 5 (cases 2466, branch-only-wrong 0); seed 77 (cases 2471, branch-only-wrong 0). Branch-only-wrong: 0.


