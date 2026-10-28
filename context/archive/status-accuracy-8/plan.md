# Status accuracy, round 8: heredoc delimiter is the whole shell word

Deferred from status-accuracy-7 (`context/archive/status-accuracy-7/reviews/findings.md` row 2). `HEREDOC_START_RE` cut a bare delimiter such as `END-1` at the first non-word character, so the body never closed. Each rule only adds edits or opacity, except where bash proves main over-reported.

## Rules
- W1: the delimiter is the whole shell word up to an unquoted metacharacter (space, tab, newline, `;`, `&`, `|`, `<`, `>`, `(`, `)`), with quote removal (`'E-1'`, `"E-1"`, `\E-1`, `E'-'1` -> `E-1`). It is quoted (literal body) iff any quoting char was present. `HEREDOC_START_RE` becomes `parseHeredocStart` in check-patterns.ts; both scanners use it.
- W2: the CRLF rule stays (a closing line may end with one `\r`). An unterminated quote or an empty unquoted word is not a heredoc start.
- Each behavioural change was checked against real bash in a scratch dir.

## Gate
```gate
allow: ^packages/core/src/(check-patterns|shell-edits)(\.test)?\.ts$
allow: ^packages/core/fixtures/sessions/sa8-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa8-[a-z0-9-]+\.
allow: ^context/(changes|archive)/status-accuracy-8/
goldens: sa8-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Phase 1 (W1, W2)
- Tests failing on main: `cat <<END-1` / `x` / `END-1` / `sed -i s/a/b/ src/a.ts` -> `src/a.ts`; `<<'E-1'` literal body; `<<E.x`; `<<"a b"`.
- One fixture `sa8-heredoc-words` (labels from the rules).
- Done: `pnpm check` green; gate exit 0/2.
