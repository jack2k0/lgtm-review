# Findings: change/status-accuracy-4

Tier High (status rule). Implementers: Grok (tool, phases 1-2, C12-C14), Sonnet (truth.py, phase 4). Reviewers: Haiku (subagent), OpenCode (GLM-5.3-Flash), in parallel. Cross-check: each accepted finding gets a test that fails on the reviewed branch head c7fcc28 (fix round), since the two reports do not overlap.

reviewers: haiku, opencode

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/shell-edits.ts:1458 | `eval "cd X"`, `source f`, `. f`, `builtin cd` change the directory invisibly; relative edits land in a known wrong (scratch) dir -> no-changes | haiku | — | open | |
| 2 | Important | packages/core/src/shell-edits.ts:1163 | python -c allow-list bypass via `sys.modules[...]`, `__class__`/`__subclasses__`, `random._os`, subscripted `__globals__` | haiku | — | open | |
| 3 | Important | packages/core/src/shell-edits.ts:846 | `node --eval=CODE scripts/gate.mjs` (also `-e`, `-p`, `--print`) taken as GATEREAD; node runs CODE | haiku | — | open | |
| 4 | Important | packages/core/src/shell-edits.ts:823 | `npm install --frozen-lockfile` accepted as non-writing; npm ignores the flag | haiku | — | open | |
| 5 | Important | packages/core/src/shell-edits.ts:1178 | dash-less `python3 <<'EOF'` heredoc no longer scanned: real writes vanish (main recorded them) | opencode | — | open | |
| 6 | Nit | packages/core/src/shell-edits.ts | `node --require=/x scripts/gate.mjs` (`--import=`, `--loader=`) non-opaque | haiku | — | open | |
| 7 | Nit | packages/core/src/shell-edits.ts:1217 | unresolved `python -c` write with allowed imports is a non-opaque `(shell edit)`, plan text says opaque | opencode | — | rejected | fail-closed: the `(shell edit)` counts as a code edit; main saw no edit at all |
| 8 | Pre-existing | packages/core/src/shell-edits.ts (operandFiles) | `/tmp/../home/u/repo/src/a.ts` treated as scratch (no normalisation before the scratch test) | haiku | — | open | |
| 9 | Pre-existing | packages/core/src/analyze.ts:~750 | git-only command with an unknown writer (`git merge b && node scripts/build.mjs`) attributes every diff file to git | haiku | — | deferred | same on main; needs a real-log PRE/POST before changing (round 5) |
| 10 | Pre-existing | packages/core/src/shell-edits.ts:1339 | executor escapes inside heredocs (`os.system` in `python3 <<EOF`) invisible | opencode | — | deferred | same on main; heredoc rules out of scope here (round 5) |
