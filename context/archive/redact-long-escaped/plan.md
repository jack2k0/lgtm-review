# Redact long quoted secrets and values with an escaped quote

Open from `redact-open-quote` (ledger findings 1 and 2). Both exist on `main` for closed and open values.

## Cause

1. `ASSIGN` and `ASSIGN_OPEN_QUOTE` in `redact.ts` cap a quoted value at 300 characters. `password="` plus 370 characters is returned unchanged, count 0, so the whole value stays visible. `QUOTE_MAX` is 400, so such a value reaches `redact`.
2. A backslash-escaped quote ends the value early: `password="abc\"def ghi` gives `password="[redacted:secret]"def ghi`, and `def ghi` stays visible.

## Phase 1

Files: `packages/core/src/redact.ts`, tests in `packages/core/src/redact.test.ts`.

1. In the two quoted alternatives of both patterns, raise the cap to 4096 characters. The unquoted alternative keeps its cap.
2. In those alternatives, `\` followed by any character except a line break is part of the value, so an escaped quote does not end it. A value ending in an escaped backslash (`password="a b\\"`) closes normally.
3. Same output as today for values under 300 characters with no backslash. Windows paths in secret values such as `password="C:\tmp\x"` are redacted whole. Exemptions, idempotence and the per-line limit of the open form stay. Keep matching linear: `redact.perf.test.ts` passes and a 1 MB line with many backslashes and quotes stays under 500 ms. Keep `redactInner`, whose comment states the 300 limit, cheap; if its comment becomes wrong, correct it.
4. A value longer than 4096 characters stays out of scope; say in your report what happens to it.
5. Tests that fail on the old code: a closed and an open value of 370 and of 4000 characters, single and double quotes; `password="abc\"def ghi"` and the open form, with `def ghi` absent from the output; the JSON-escaped form of the same. Tests that hold on both: a closed short value, `title="<long text>"` with a non-secret key, a reference `password="$VAR`, idempotence.

## Non-goals

Other patterns (`CLI_FLAG`, headers, URLs), `parse.ts`, existing expectations, labels, goldens. If a label, a golden or an existing expectation disagrees, stop and report it.

## Audit

The orchestrator measures real logs before and after, aggregates only. Do not open `~/.claude/projects`.

## Gate
```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact\.test\.ts$
allow: ^context/(changes|archive)/redact-long-escaped/
deps: no
schema: no
```
