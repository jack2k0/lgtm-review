# status-exit-owner (S-42)

Roadmap S-42: H1, M2, L6 (verified in `docs/review-2026-11-17.md`). FR-002/004. Status-rule change: the orchestrator runs the real-log PRE/POST audit (aggregates only). Uncommitted work already in this worktree is the starting implementation; finish it, do not restart.

## Phase 1: masked later operators, filter pipes, no-ops (only phase)

1. A check is `unreliable` when any later top-level segment uses `|`, `||`, `;` or a newline, not only the check segment's own operator. `pnpm test && echo ok` stays reliable. `pnpm test && echo ok || true` and `pnpm test && echo ok; true` are unreliable. A trailing `&` stays unreliable as today.
2. `--exit-zero` on a check segment makes that command unreliable (exit 0 hides the result).
3. `isFilteredCheck`: the check's output goes only into `grep`/`egrep`/`fgrep`/`rg`/`awk`/`gawk`/`mawk` or `sed -n`/`sed --quiet`/`sed --silent`. Re-export it from `packages/core/src/check-patterns.ts`. In `analyze.ts`, a non-zero exit of a filtered check is not a failure when `findMaskedFailure` finds nothing (the filter's "no match"); the check is ignored and hidden, and the step exit is "no result". A failure signal in the output still fails the check. A signal exit is unchanged.
4. No-op flags: add `--print-config`. `make -q`, `make --question` and a clustered `-q` (for example `-qk`) are dry-runs, same as `make -n`.
5. `FAILURE_SIGNALS`: node:test `ℹ fail N` and TAP `# fail N` (N >= 1), with a non-matching prose row.
6. README `packages/cli/README.md` "Masked exit codes": say a later `||`/`;`/newline/`|` in the chain masks the check (`A && B || C`), a filter pipe (`| grep`) is "not observed" unless the output shows a failure, and `--exit-zero` / `make -q` / `--print-config` are not passing checks.
7. Tests that fail on the code before this diff, in `check-patterns.test.ts` and `analyze.test.ts`. Do not edit an existing table row unless that row asserts the old H1 rule (a check reliable despite a later top-level `||`, `;`, newline or `|`). If you must change one, list old and new in the commit message. `pytest && echo ok` and `gh run watch --exit-status 12345 && echo done` stay `unreliable: false`. No fixture label files. No new dependencies.

Done: `npx pnpm@11.2.2 --filter @lgtm/core test` and `npx pnpm@11.2.2 --filter @lgtm/core typecheck` green; `node scripts/gate.mjs --base main --plan context/changes/status-exit-owner/plan.md` exit 0 or 2 with every item explained. Commit on `change/status-exit-owner`. Do not push or merge.

```gate
allow: ^packages/core/src/(analyze|check-patterns(-[a-z-]+)?)\.ts$
allow: ^packages/core/src/[a-z-]+\.test\.ts$
allow: ^packages/cli/README\.md$
allow: ^context/(changes|archive)/status-exit-owner/
deps: no
schema: no
```
