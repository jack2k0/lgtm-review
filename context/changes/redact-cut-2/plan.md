# redact-cut-2 (S-45)

Roadmap S-45: H4 (verified; S-32 incomplete). A display cut that lands inside a high-entropy token must not keep a recognisable prefix. Uncommitted work in this worktree is the start; finish it. Do not change redaction patterns (that is S-46/S-47).

## Phase 1 (only phase)

1. `cutForDisplay` in `packages/core/src/redact.ts`: after `trimPartialSecret`, if the cut is still mid-token (the next source character is not whitespace and the cut does not end on whitespace), drop a trailing run of 8+ token characters (`[A-Za-z0-9_+\-/=.~%]`). A run of fewer than 4 distinct characters stays (padding, not a token). Then `trimEnd` and the ellipsis, as today. Text that already fits is unchanged.
2. `packages/core/src/parse.ts`: `truncateText` goes through `cutForDisplay` (ellipsis `""`, `wordWindow` 0 so a stored cut does not jump back to an earlier word). Remove the raw `truncate` of log-derived text that is shown or stored as prompt, quote, hint, command, tool-result head or bash-edit path. A 40-character unknown-record type name may use the same helper. Do not leave a function named `truncate` or `truncateText` that slices log text.
3. `packages/cli/src/format.ts` `oneLine` and `packages/cli/src/summary.ts` `shorten` cut through `cutForDisplay`. `shorten` keeps its code-point budget: the max passed to `cutForDisplay` is the UTF-16 length of the first `max` code points (ellipsis included). Do not pass `Infinity` as `wordWindow` (that cuts back to the first whitespace of the whole string).
4. Export `cutForDisplay` from `packages/core/src/index.ts` if the CLI imports it.
5. `packages/core/src/boundaries.test.ts`: also fail when a non-test file under `packages/core/src` or `packages/cli/src` defines `function truncate` or `function truncateText`.
6. Tests in `redact.test.ts` that fail on the old `cutForDisplay`: a cut inside `AKIAIOSFODNN7EXAMPLE` and inside a 40-character high-entropy token leaves neither an 8-character prefix nor the ellipsis glued to that prefix. A short word and a run of identical characters (`aaaaaaaa`) are not stripped. One CLI test (synthetic session only) where `--summary` or the step label cuts inside `AKIAIOSFODNN7EXAMPLE` and the output has no `AKIAIOSF` prefix.

No existing expectation changes. If one fails because text now ends earlier, stop and report the diff. No label files. No new dependencies.

Done: `npx pnpm@11.2.2 --filter @lgtm/core test` and `npx pnpm@11.2.2 --filter lgtm-review test` green enough to show the new tests pass (quote the summary). `node scripts/gate.mjs --base main --plan context/changes/redact-cut-2/plan.md` exit 0 or 2. Commit on `change/redact-cut-2`. Do not push or merge.

```gate
allow: ^packages/core/src/(redact|parse|index)\.ts$
allow: ^packages/core/src/[a-z-]+\.test\.ts$
allow: ^packages/cli/src/(format|summary)\.ts$
allow: ^packages/cli/src/[a-z-]+\.test\.ts$
allow: ^context/(changes|archive)/redact-cut-2/
deps: no
schema: no
```
