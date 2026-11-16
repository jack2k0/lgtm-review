# gate-coverage (S-39)

Roadmap S-39, F11 (repro first). Process (REVIEW.md): the gate must catch changed fixture inputs, workspace overrides, `.mjs`/`.spec` expectations, and tier the risky files High.

## Phase 1 (only phase)

All in `scripts/gate.mjs`, tests in `scripts/gate.test.mjs` (add cases in its existing style; each must fail on the old gate).

1. A modified or deleted existing `packages/core/fixtures/sessions/*.jsonl` (status M/D/R vs base, not A) is a hard fail (exit 1), like a changed `.labels.json`. Adding new fixtures stays allowed.
2. `DEP_RE` also matches `^pnpm-workspace\.yaml$` (overrides live there), so it needs `deps: yes`.
3. The expectation scan (today `/\.test\.tsx?$/` near line 879) covers `\.(test|spec)\.(mjs|cjs|js|tsx?)$`, perf tests included. Update the Low tier pattern the same way (`/\.(test|spec)\.(mjs|cjs|js|tsx?)$/`) — except `scripts/gate.test.mjs`, which stays High with `gate.mjs` (add it to the High scripts pattern).
4. Tier High, added to `TIERS.High`: `packages/cli/src/{format,map,llm,llm-input}.ts`, `packages/core/src/{llm-input,paths,steps,discover}.ts`, `packages/core/src/node/worktrees.ts`. Check where each file really lives (`ls`) and use the real paths; list any that do not exist in the report. Update the High row of `REVIEW.md` to mention them (one short phrase).

Done: `pnpm check` green; `node scripts/gate.mjs --tiers` shows the new rows; gate exit 0 or 2 (this change is itself High).

```gate
allow: ^scripts/gate(\.test)?\.mjs$
allow: ^REVIEW\.md$
allow: ^context/(changes|archive)/gate-coverage/
deps: no
schema: no
```

Addendum (from git-no-locks review): 5. the `git` helper in `scripts/gate.mjs` (~line 170) passes `--no-optional-locks` first, so the gate's `git status` (~line 845) never rewrites `.git/index`. Test: the existing gate test helpers show the argument, or an index byte check like `packages/core/src/node/git.test.ts`.
