# Status accuracy, round 6: heredoc and substitution gaps

Deferred from status-accuracy-5 (`context/archive/status-accuracy-5/reviews/findings.md` rows 1, 2, 3, 5). All four exist on main and can hide a real code edit. Every rule only adds edits or opacity (fail closed); the orchestrator measures the real-log cost.

## Rules
- H1 (row 1): the body of a heredoc whose delimiter is NOT quoted (`<<EOF`, `<<-EOF`) is expanded by bash: its `$(…)` and backtick substitutions are analysed like R1 substitutions (inner text classified, edits and opacity merged). A quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) keeps the body literal: not analysed. Inside a heredoc body quotes are literal characters.
- H2 (row 5): `substitutionBodies` scans the command with heredoc bodies removed (they are handled by H1), so an apostrophe or quote inside a heredoc body can no longer open a quote that hides a later substitution on the command line.
- H3 (row 3): a substitution body that contains the word `case` is opaque (no attempt to match `case` pattern parentheses); its edits that the extractor did find are still kept.
- H4 (row 2): heredoc-fed python is opaque unless every import is in the allow-list {json, re, math, sys, pathlib, textwrap, datetime, collections, itertools, functools, string, typing} (any form, aliases included) AND the source contains no dunder identifier (`__x__`) and none of `exec`, `eval`, `compile`, `getattr`, `setattr`, `globals`, `vars`, `builtins`. Resolved writes are still recorded. (Replaces the R2 deny-list; it only adds opacity.)

## Gate
```gate
allow: ^packages/core/src/(shell-edits|analyze)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/sa6-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa6-[a-z0-9-]+\.
allow: ^context/(changes|archive)/status-accuracy-6/
goldens: sa6-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Phase 1 (H1-H4)
- Tests failing on main: `cat <<EOF` newline `$(sed -i s/a/b/ src/a.ts)` newline `EOF` -> `src/a.ts`; same with backticks; `cat <<'EOF'` with the same body -> no edit (literal); `cat > a.md <<'EOF'` newline `don't` newline `EOF` newline `echo $(sed -i x src/a.ts)` -> `src/a.ts`; `echo $(case x in x) sed -i x src/a.ts;; esac)` -> opaque; heredoc python `import posix; posix.execv(...)` -> opaque; `import json as j` -> non-opaque; `__import__('os')` -> opaque; `open('docs/a.md','w')` with `import json` -> non-opaque doc edit.
- Never change an existing expectation; if one conflicts, stop and report. One fixture `sa6-heredoc-gaps` (labels from the rules).
- Done: `pnpm check` green; gate exit 0/2.
- [ ] Phase 1 done

## Phase 2 (orchestrator): real-log audit PRE/POST, counts only.
