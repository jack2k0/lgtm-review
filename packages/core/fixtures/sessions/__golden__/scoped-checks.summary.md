# Review summary: Change web and core, test web only.

Branch: `main` · Date: 2026-01-01 · Session: `scoped-c`

8 prompts: 8 checked.

| # | Status | Review | Prompt | Files | +/- |
| ---: | --- | --- | --- | ---: | --- |
| 1 | checked | Skim | Change web and core, test web only. | 2 | +2 -2 |
| 2 | checked | Skim | Fix the API route and run its tests. | 1 | +1 -1 |
| 3 | checked | Skim | Fix cart totals and run the cart test. | 2 | +2 -2 |
| 4 | checked | Skim | Run everything, then the web package again. | 2 | +2 -2 |
| 5 | checked | Skim | Test the web package by name. | 1 | +1 -1 |
| 6 | checked | Skim | Fix foo and bar, test foo. | 2 | +2 -2 |
| 7 | checked | Skim | Test from the project root. | 1 | +1 -1 |
| 8 | checked | Skim | Keep testing in the web folder. | 1 | +1 -1 |

## Needs attention

### Prompt 1: Change web and core, test web only.

- Status: checked (pnpm test passed after last edit (scoped to packages/web))
- Review: Skim
- **warn** `check-scope`: `packages/core/src/b.ts`

### Prompt 2: Fix the API route and run its tests.

- Status: checked (vitest run tests/api passed after last edit)
- Review: Skim
- **warn** `public-surface`: `src/api/route.ts`

### Prompt 3: Fix cart totals and run the cart test.

- Status: checked (pytest tests/test\_cart.py passed after last edit (scoped to tests/test\_cart.py))
- Review: Skim
- **warn** `check-scope`: `src/orders.py`

### Prompt 6: Fix foo and bar, test foo.

- Status: checked (go test ./internal/foo/... passed after last edit (scoped to internal/foo))
- Review: Skim
- **warn** `check-scope`: `internal/bar/b.go`

### Prompt 8: Keep testing in the web folder.

- Status: checked (pnpm test passed after last edit (scoped to packages/web))
- Review: Skim
- **warn** `check-scope`: `packages/core/src/c.ts`

---

_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._
