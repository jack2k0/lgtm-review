# Split the rule files, no behaviour change (S-30)

## Cause

`packages/core/src/shell-edits.ts` (about 2300 lines) and `check-patterns.ts` (about 1570 lines) hold many unrelated concerns in one file, which makes every status change risky to review.

## Rules for both phases

- Move code only. No renamed logic, no reordered rules, no changed regex, no "while I'm here" edits. A helper may become `export`ed so a sibling module can import it; nothing else changes on a moved line.
- `check-patterns.ts` and `shell-edits.ts` stay as the entry points with the same public exports, so no importer and no existing test changes.
- New modules are named `check-patterns-<topic>.ts` and `shell-edits-<topic>.ts`, in `packages/core/src/`, no `node:` imports, no import cycles (check with a quick script or by reading the imports). Aim for at most about 800 lines each and split along the existing concerns; no file with fewer than about 100 lines.
- Performance tests must stay green. Test files are not edited, except the gate test named below.

## Phase 1: gate tier follows the new files, and check-patterns

Files: `scripts/gate.mjs`, `packages/cli/src/gate.test.ts`, `packages/core/src/check-patterns.ts`, `packages/core/src/check-patterns-*.ts`.

1. In `TIERS` (`scripts/gate.mjs:31`) the status-rule pattern also matches `check-patterns-<topic>.ts` and `shell-edits-<topic>.ts`, so the new files stay High. Add a test case to `gate.test.ts` for both names; no existing expectation changes.
2. Split `check-patterns.ts`.

## Phase 2: shell-edits

Files: `packages/core/src/shell-edits.ts`, `packages/core/src/shell-edits-*.ts`.

## Non-goals

Any behaviour change, `analyze.ts`, simplifying regexes, new tests beyond the gate case. The orchestrator runs the real-log audit and a differential; this slice is dropped if they are not identical.

## Gate
```gate
allow: ^scripts/gate\.mjs$
allow: ^packages/cli/src/gate\.test\.ts$
allow: ^packages/core/src/(check-patterns|shell-edits)(-[a-z-]+)?\.ts$
allow: ^context/(changes|archive)/rule-files-split/
deps: no
schema: no
```
