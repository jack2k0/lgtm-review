# Status accuracy, round 9: several heredocs on one line

Deferred from status-accuracy-8 (ORCHESTRATION: "kilka heredoców w jednej linii, śledzony tylko pierwszy"). `parseHeredocStart` returns only the first `<<` start of a line, so in `cat <<A >a.txt; cat <<B >b.txt` the body of `B` is read as commands (lines such as `sed -i ... src/x.ts` become false edits) and the body text of `B` is never seen as a heredoc body. Checked with bash in a scratch dir: bodies are read one after another in the order of their starts; for `cat <<X <<Y` stdin is the last one (`Y`).

## Rules
- M1: `parseHeredocStarts(line)` in check-patterns.ts returns every heredoc start of a line, in order (scan continues after the end of each parsed delimiter word; the comment/arithmetic/`<<=` rules of round 8 apply to each). `parseHeredocStart` stays as `parseHeredocStarts(line)[0] ?? null` if still used.
- M2: `stripHeredocs` and `heredocParts` (shell-edits.ts) keep a queue: after a start line, the bodies of all its heredocs follow one after another; each closes on its own delimiter with its own `dash`/`quoted`. A heredoc never closed is reported unclosed (D3, fail closed), as are the queued ones after it.
- M3: segment wiring in `classifyShellMutation`: a segment with N heredoc starts advances the heredoc counter by N; the heredoc fed to its stdin is the LAST of them. Pipeline inheritance (`pipeHeredoc`) uses that one.
- No other rule changes. Each rule only removes false edits that come from heredoc bodies read as commands, or adds bodies to the existing H1/D2/D3 scanning.

## Gate
```gate
allow: ^packages/core/src/(check-patterns|shell-edits)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/sa9-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa9-[a-z0-9-]+\.
allow: ^context/(changes|archive)/status-accuracy-9/
goldens: sa9-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Phase 1 (M1-M3)
- Tests failing on main (in shell-edits.test.ts / check-patterns tests, next to the sa8 ones):
  - `cat <<A >notes.txt; cat <<B >other.txt` / `x` / `A` / `sed -i s/a/b/ src/a.ts` / `B` -> no edit of `src/a.ts` (it is body text of B).
  - `cat <<X <<Y | python3` where only `Y` writes a file `open('src/b.py','w')`: the write of `Y` is found (stdin is the last heredoc); a write only in `X` is not.
  - `cat <<A; cat <<B` where `B` is never closed -> opaque (D3).
  - `stripHeredocs` drops both bodies; `parseHeredocStarts` unit tests: two starts, `<<-` mixed with `<<'Q'`, a `<<` inside `$((1<<2))` between two starts is skipped.
- One fixture `sa9-heredoc-multi` (session with such a command and a check; labels from the rules).
- Done: `pnpm check` green; `node scripts/gate.mjs --base main --plan context/changes/status-accuracy-9/plan.md --run-check` exit 0/2.
