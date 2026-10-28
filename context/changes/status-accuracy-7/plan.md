# Status accuracy, round 7: heredoc delimiter forms, nested heredocs, flaky timing test

Deferred from status-accuracy-6 (`context/archive/status-accuracy-6/reviews/findings.md` rows 2-4), plus one load-sensitive cli test. Every rule only adds edits or opacity (fail closed).

## Rules
- D1 (row 2): `<<\EOF` is a QUOTED delimiter (literal body), in `HEREDOC_START_RE` (shell-edits.ts) and in `stripHeredocs` (check-patterns.ts).
- D2 (row 3): when the substitution body found in an unquoted heredoc body itself contains `<<`, the command is opaque (a nested heredoc is not followed).
- D3 (row 4): a plain `<<EOF` body ends only on a line exactly equal to the delimiter; `<<-EOF` also allows leading tabs (only tabs). Today `line.trim() === delim` ends it early. Both heredoc scanners (shell-edits.ts, check-patterns.ts) follow this.
- F1 (flaky): `packages/cli/src/llm.test.ts` "a non-loopback endpoint is not contacted" asserted `Date.now() - started < 400` (timeoutMs 200); under load that failed. The timing assertion moves unchanged to `llm.perf.test.ts`; the functional assertions stay.

## Gate
```gate
allow: ^packages/core/src/(shell-edits|check-patterns|analyze)(\.test)?\.ts$
allow: ^packages/cli/src/llm(\.perf)?\.test\.ts$
allow: ^packages/core/fixtures/sessions/sa7-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa7-[a-z0-9-]+\.
allow: ^context/(changes|archive)/status-accuracy-7/
goldens: sa7-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Phase 1 (D1-D3, F1)
- Tests failing on main: `cat <<\EOF` body with `$(sed -i x src/a.ts)` -> no edit; `cat <<\EOF` newline `don't` newline `EOF` newline `echo $(sed -i x src/a.ts)` -> `src/a.ts`; `<<EOF` body containing `$(cat <<X ... X)` -> opaque; `cat <<EOF` with an indented `  EOF` line then `$(sed -i x src/a.ts)` line then `EOF` -> `src/a.ts` (body, not command; indented line does not end it); likewise `<<EOF` with `$(sed -i x src/a.ts)` after a space-padded `EOF ` -> still body; `<<-EOF` with tab-indented `EOF` ends it.
- Never change an existing expectation; if one conflicts, stop and report. One fixture `sa7-heredoc-forms` (labels from the rules).
- Done: `pnpm check` green; gate exit 0/2.
- [x] Phase 1 done
