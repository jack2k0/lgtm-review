# Status accuracy, round 5: deferred fail-closed holes

Deferred from status-accuracy-4 (ledger rows 9, 10, 27 in `context/archive/status-accuracy-4/reviews/findings.md`). All three exist on main; each can hide a real code edit. Every rule only makes the tool MORE conservative; the real-log audit measures the cost (orchestrator, counts only).

## Rules
- R1 (row 27): command substitution `$(…)`, backticks and process substitution `<(…)`/`>(…)` anywhere in a segment are analysed: their inner text is parsed as its own command (same classifier, inner `cd` never leaks out) and its edits/opacity are merged into the segment. Inner text that cannot be extracted (unbalanced, nested quotes the splitter cannot follow) -> the segment is opaque. `$(pwd)`, `$(git rev-parse …)`, `$(date …)`, `$(cat f)` stay non-writing via the existing safe heads.
- R2 (row 10): heredoc-fed python (`python3 - <<EOF`, dash-less forms) is opaque when the source contains an execution or OS surface: any import of `os`, `subprocess`, `shutil`, `pty`, `importlib`, `ctypes`, `multiprocessing`, `pathlib` other than `Path(...)` reads/writes the existing scan already resolves, or any of `exec`, `eval`, `compile`, `__import__`, `getattr`, `globals`, `system`, `popen`, `spawn`. Resolved writes are still recorded (opacity is added, never edits removed). This is a deny-list only in the safe direction (opacity on).
- R3 (row 9): a command with a history git op, a `bashEditDiff`, and an opaque segment is no longer `gitOnly`: diff files not matched to a parsed plain edit nor to a git-made path that the git op itself explains are plain edits (code by class). Concretely: when the command has an opaque segment, the per-file split treats unmatched diff files as plain (today they become git-made). Measure the cost.

## Gate
```gate
allow: ^packages/core/src/(shell-edits|analyze)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/sa5-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa5-[a-z0-9-]+\.
allow: ^context/(changes|archive)/status-accuracy-5/
goldens: sa5-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Phase 1 (R1-R3)
- Tests per rule, each failing on main: `echo $(sed -i s/a/b/ src/a.ts)` -> `src/a.ts`; `echo "$(touch src/a.ts)"`; backticks; `cat <(sed -i … src/a.ts)`; `node scripts/gate.mjs $(touch src/a.ts)`; negatives `echo $(pwd)`, `x=$(git rev-parse HEAD)` non-writing. R2: `python3 - <<'EOF'` with `import os; os.system('…')` -> opaque; with `open('docs/a.md','w')` only -> non-opaque doc edit (unchanged). R3: `git merge b && node scripts/build.mjs` with diff [src/c.ts] -> `src/c.ts` a code edit.
- One fixture `sa5-hidden-writes` (labels from the rules).
- Never change an existing expectation; if one conflicts, stop and report.
- Done: `pnpm check` green; gate exit 0/2.
- [ ] Phase 1 done

## Phase 2 (orchestrator): real-log audit PRE/POST, counts only; any regression adjudicated by a Claude subagent.
