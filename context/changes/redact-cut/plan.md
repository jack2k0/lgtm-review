# redact-cut (S-32)

Roadmap S-32, findings F3 + G1 (verified). Guardrail: no secret, not even a partial one, leaves through a display cut. Redaction of derived text runs on the cut text, so a token cut mid-body (`AKIAIOSF…`, `postgres://u:hunter2s…` before `@`) no longer matches its pattern and survives.

## Phase 1 (only phase)

1. `packages/core/src/redact.ts`: export `cutForDisplay(s: string, max: number, ellipsis = "…"): string`. If `s.length <= max` return `s`. Otherwise cut to `max - ellipsis.length` characters, prefer ending on the last whitespace in the final 20 characters, apply `trimPartialSecret` to the cut, then append the ellipsis. Reuse `trimPartialSecret` as is; do not change it.
2. Route every display cut of log-derived text through it (keep each site's current max and ellipsis style):
   - `check-patterns-classify.ts` `labelOf` (LABEL_MAX);
   - `steps.ts` `oneLine` and `failureExcerpt` (EXCERPT_MAX, CHECK_LABEL_MAX, TITLE_MAX);
   - `analyze.ts` failing-output line (FAIL_OUTPUT_MAX) and session title (TITLE_MAX) — via `oneLine` if they already use it;
   - `parse.ts` the plain `truncate` path of `blocksText` (the tool-result head) — `truncateText` already trims;
   - `diff.ts` the per-line cuts at DIFF_LINE_CHARS_MAX (lines 61, 92, 139, 140);
   - `play.ts` `oneLine`, `llm-input.ts` `cutAtWord`, `packages/cli/src/format.ts` `oneLine`.
   Not a display cut (leave): path/array slices, `scope.ts` label of directory names.
3. Boundary test in `packages/core/src/boundaries.test.ts`: no source file in `packages/core/src` or `packages/cli/src` (non-test) contains `.slice(0, <NAME>_MAX` or `.slice(1, 1 + <NAME>_MAX` except `redact.ts`; allow-list with a reason any remaining non-display hit.
4. Tests (must fail on the old code): in `redact.test.ts` unit tests of `cutForDisplay`; in the CLI tests, a synthetic session where (a) a step command `psql postgres://app:Hunter2SecretPw9@db/x ...` is long enough that the label/title cut falls inside the password, and (b) a check output where the excerpt cut falls inside `AKIAIOSFODNN7EXAMPLE`. Assert that neither `--summary` nor `--export` output contains any 6+ character prefix of the secret (`Hunter`, `AKIAIO` …). Use synthetic values only.

No existing expectation changes. If one fails because its text now ends earlier, stop and report it with the diff.

Done: `pnpm check` green (incl. perf suite); gate exit 0 or 2 with each item explained.

Non-goals: no new secret shapes (S-34), no change to `trimPartialSecret` or to the redaction patterns.

```gate
allow: ^packages/core/src/(redact|check-patterns-classify|steps|analyze|parse|diff|play|llm-input)\.ts$
allow: ^packages/core/src/[a-z-]+\.test\.ts$
allow: ^packages/cli/src/format\.ts$
allow: ^packages/cli/src/[a-z-]+\.test\.ts$
allow: ^packages/cli/test/
allow: ^packages/core/fixtures/sessions/redact-cut[^/]*\.jsonl$
allow: ^context/(changes|archive)/redact-cut/
deps: no
schema: no
```
