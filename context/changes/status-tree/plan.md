# status-tree (S-37)

Roadmap S-37: F4 (repro first), G2, G3 (verified), Gm2. FR-002/004/017: `checked` only when the check ran on the edited tree. Status-rule change: real-log PRE/POST audit required (the orchestrator runs it; aggregates only).

**Owner decision (2026-11-17, question a): YES.** An unplaced check scope (a filter or target that cannot be placed, e.g. `pnpm --filter @acme/web test`) stops counting as whole-project coverage. It is treated like a scoped check that covers none of the edited files — the same outcome a placed scope gives for files outside it (see SC-5: status from the existing scoped-check rule, the uncovered files flagged by `scoped(...)`). The owner approved changing **only** the SC-4 expectation in `packages/core/src/analyze.test.ts` (~730) accordingly; rename its title to say what it now asserts. Every other existing expectation stays.

**Follow-up approval (2026-11-17):** the owner also approved changing `scoped-checks.labels.json` prompt #4 only (`expectedHints` becomes `["check-scope:packages/core/src/b.ts"]`, note updated) and regenerating the `scoped-checks.*` goldens, and approved the narrowed "unplaced" scope: only named package selectors (`--filter`/`-F <name>`, `npm -w <name>`, `yarn workspace <name>`, for pnpm/npm/yarn/bun/turbo). `pnpm -r`, glob filters, `nx run`, scripts and `cd $VAR` stay whole-project; `git reset --hard` stays out of scope.

## Phase 1: scope

1. Distinguish "whole project" (no scope: a root-level run) from "unplaced" in `scope.ts` / `check-patterns-scope.ts` / `analyze.ts` (today both are `null`). Unplaced → covers no edited file in `scopeGaps` and in any status logic that reads `scope === null` as full coverage. Keep `null` = whole project for genuine root runs.
2. G3: a check root under `<repo>/.claude/worktrees/<id>/` covers only files under that prefix (`scope.ts` ~143 `scopeCovers`); an edit in the main tree is not covered by an agent-worktree check, and vice versa.
3. Gm2: `analyze.ts` ~332 drops relative edit paths (`startsWith("/")`), so `coversNone` cannot fire. Resolve a relative path against the prompt's/record's cwd before the check; keep the shell-edit placeholder (non-path) excluded.
Tests (new; each must fail on the old code): unplaced filter → CORE flagged; agent-worktree check vs main-tree edit and the reverse; relative edit path + agent-worktree check that covers nothing → not `checked`.

## Phase 2: tree reverted (F4, repro first)

Track a "tree reverted" state per prompt: from `git stash` (push/save, not `list`/`show`), `git checkout -- .` / `git checkout -- <path>`, `git restore <path>` (not `--staged` only) until `git stash pop`/`apply` (or a later edit of the reverted files). A check that finishes while the edits are reverted does not count as verification of those edits (it ran on the old tree). First write the repro test from the roadmap finding; if it already passes on main, keep the test and change no code for that case.

No other existing expectation changes; if one breaks, stop and report it with the diff. `pnpm check` green.

```gate
allow: ^packages/core/src/(analyze|scope|check-patterns(-[a-z-]+)?|shell-edits(-[a-z-]+)?)\.ts$
allow: ^packages/core/src/[a-z-]+\.test\.ts$
allow: ^packages/core/fixtures/sessions/status-tree[^/]*\.jsonl$
allow: ^packages/core/fixtures/sessions/scoped-checks\.labels\.json$
allow: ^packages/core/fixtures/sessions/__golden__/scoped-checks\.
allow: ^packages/core/src/check-patterns-tree\.ts$
allow: ^context/(changes|archive)/status-tree/
goldens: scoped-checks\.
deps: no
schema: no
```
