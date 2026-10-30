# py-map-strings: comments and nested f-strings in the Python import scanner (S-09)

Follow-up to `context/archive/python-map/plan.md` and the review round whose fixtures are the S-20
tests in `map-extract-py.test.ts` (`context/ORCHESTRATION.md` lists nested PEP 701 f-strings in the
Python map as a knowingly unfixed limitation).

## Cause

`blankCommentsAndStrings` in `packages/core/src/map-extract-py.ts` treats an f-string exactly like a
plain string. Since Python 3.12 (PEP 701) an f-string may reuse its own quote type inside `{...}`
interpolations, so a nested same-quote f-string closes the outer string early in the scanner: the
rest of the outer f-string (including nested f-strings whose body spans lines, e.g.
`f"""{f"""\nimport fake\n"""}"""`) becomes scanner-visible code and `import` text inside it is
matched as a real import. Comment handling (`#` to end of line, never opening a string) has been
enforced since the S-20 round; this slice only locks it down with further regression tests.

## Rules (target state)

1. Comments: unchanged — `#` in code state ends the comment at end of line and can never open a
   string; inside strings `#` stays literal content.
2. Non-f strings: unchanged byte-for-byte (single line ends at an unescaped newline; a
   backslash-newline continues the string; triple-quoted strings end only at the same three quotes,
   even at end of line; CRLF behaviour as tested).
3. F-strings (`f`/`F` prefix plus optional `r`/`b`/`u` prefix chars directly attached to the quote)
   are scanned as f-strings:
   - `{{` and `}}` in literal parts are literal braces, not interpolation.
   - A `{` opens a field: expressions track `(`/`[`/`{` nesting; the first top-level `:` switches to
     the format spec; `}` at nesting depth 0 closes the field (and a `!` conversion is inert).
   - In the format spec, `{` opens a nested dynamic part (`f"{v:{w}}"`, `f"{v=:{'{'}"...`); `#` and
     quotes inside a field or spec are literal, never comments or openers of that string.
   - Inside a field any string of any quoting (including the outer quote; nested f-strings too) is
     scanned as a string on its own, so PEP 701 quote reuse cannot close the outer f-string early.
   - An unescaped newline in a single-quoted f-string (field boundary included) ends it like any
     unterminated single-line string; triple-quoted f-strings keep newlines and may span lines.
   - Line numbers and offsets are preserved: every blanked character stays one character, `\r`/`\n`
     survive.
4. No behaviour change for TS/JS extraction, the resolver, hints, or the response schema.

Python used as the oracle: both failing shapes below were confirmed against `python3` (3.14, PEP 701
grammar) with `ast.parse`. Note for reviewers: `python3` 3.14 also accepts these; on interpretors
without PEP 701 (≤ 3.11) the nested shapes are syntax errors, where the extractor only guarantees
"no false import / no crash", not equality with `ast`.

## Tests (new, plus no change to existing ones)

- Failing today (verified against python3 truth): `import` text inside a nested same-quote f-string
  whose body spans lines (`f"""{f"""...` across lines) is extracted as `import fake`; same for a
  nested f-string placed on its own lines inside a field.
- Regression locks (already passing, kept green by the new scanner): the PEP 701 examples
  `f"{x + f'{y}'}"`, `f"{'a' if b else "c"}"`, `{{ }}`, format specs `{v:{w}}`
  with an import after the line and import-like text inside the string; comment shapes
  (`# """`, `# '''`, hash inside strings, triple quotes inside comments) as tested by S-20.

## Review fixes

- F1: `isFstring` checks any `f`/`F` anywhere in the prefix run (`rf"`, `Rf"`, `fR`, `rF`, etc.).
- F2: In `blankFstringBody` and `blankField`, backslash escape consumes the next char even when it is another backslash (`\\`).
- F3: An unterminated field or nested string inside a triple-quoted f-string continues blanking to the end of the outer triple-quoted string instead of dropping into code state.
- F4: Bounded recursion with a nesting depth cap (`MAX_NESTING = 200`); deeper nesting is treated as an unterminated plain string without throwing `RangeError`.

```gate
allow: ^packages/core/src/map-extract-py\.ts$
allow: ^packages/core/src/map-extract-py\.test\.ts$
allow: ^context/(changes|archive)/py-map-strings/
deps: no
schema: no
```
