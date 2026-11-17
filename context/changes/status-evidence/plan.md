# status-evidence (S-38)

Roadmap S-38: F5, F6 (repro first). FR-002/004. Status-rule change: real-log PRE/POST audit required (orchestrator runs it; aggregates only). Starts after status-tree (S-37) is merged.

**Owner decision (2026-11-17, question b): YES.** Results count per check family (test, typecheck, lint, build, other). A failing test stays `failing` until a later test-family check passes; a later passing lint/build/typecheck does not hide it. Edits after the last check still give `unchecked` as today.

## Phase 1: per-family result

1. In `analyze.ts`, derive the status from the newest completed result of each family after the last edit: any family whose newest result failed → `failing`; otherwise the existing `checked` rule. The family comes from the existing check classification (`check-patterns*`); unknown → `other` (one family).
2. PRD (`context/foundation/prd.md`, line ~114 and the Socrates note ~80): reword "last check after last edit succeeded" to "the newest check of every family after the last edit succeeded"; `failing` = "the newest check of some family failed". Owner-approved.
3. Existing expectations that encode the old rule (a later different-family pass hiding a failure): list each in the report BEFORE changing it, with the old/new assertion; change only those. Anything else that breaks → stop and report.

## Phase 2: evidence (repro first)

1. "Result not observed" (check does not count, like an incomplete check): a trailing shell `&` without a later notification; output discarded (`> /dev/null 2>&1`, `&>/dev/null`) with the exit masked; a count-only pipe (`| wc -l`, `| grep -c …`) masking the exit.
2. Extend `FAILURE_SIGNALS` (`check-patterns.ts:55`): `error TS\d+`, `error\[E\d+\]`, `npm ERR!`, `make: \*\*\*`, `command not found`, `ERR_PNPM_`, `FAILED` at line start (pytest summary) — each with a non-matching prose row.
3. No-op invocations are not checks: `--showConfig`, `--init`, `--list`/`--listTests`, `--version`, `--help` on test/lint/typecheck tools.
Each item: test that fails on the old code, plus "unchanged" rows.

`pnpm check` green.

```gate
allow: ^packages/core/src/(analyze|check-patterns(-[a-z-]+)?|steps)\.ts$
allow: ^packages/core/src/[a-z-]+\.test\.ts$
allow: ^packages/core/fixtures/sessions/status-evidence[^/]*\.jsonl$
allow: ^context/foundation/prd\.md$
allow: ^context/(changes|archive)/status-evidence/
deps: no
schema: no
```
