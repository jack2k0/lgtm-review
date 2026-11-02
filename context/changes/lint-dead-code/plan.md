# Dead code reported by eslint

The rest of finding B2 of `docs/review-2026-11-02.md`. No roadmap slice is left and the other open items wait for the owner. `eslint .` reports 101 warnings; this removes those that are plain dead code. No behaviour change.

## Phase 1

Fix every warning of these rules, and only these: `@typescript-eslint/no-unused-vars`, `prefer-const`, `no-useless-assignment`, plus the report at `packages/core/src/golden.test.ts:141` that has no rule id, if it is an unused directive.

- Unused import or local: remove it. If the right-hand side has a side effect, keep the call and drop the binding.
- Unused parameter that a signature needs: prefix with `_` only if the config accepts that; otherwise leave the warning and list it in the report.
- Unused export-free helper: remove it. Never remove anything exported.
- `no-useless-assignment`: remove the dead assignment only when no read can see it. If unsure, leave the warning and list it.

Do not touch `no-explicit-any`, `no-useless-escape`, `no-control-regex`, `no-empty`, `no-regex-spaces`, `no-unused-expressions`. Do not change `eslint.config.mjs`. Do not touch `packages/core/src/redact.ts`, any golden, any label or fixture. Do not change any test expectation. Only delete or rewrite the flagged lines: no refactor, no reformatting.

Done when these rules report 0, or only the listed exceptions, and no other rule's count rises; `corepack pnpm check` passes.

```gate
allow: ^packages/(core|cli|web)/src/.*\.(ts|tsx)$
allow: ^scripts/gate\.test\.mjs$
allow: ^context/(changes|archive)/lint-dead-code/
deps: no
schema: no
```
