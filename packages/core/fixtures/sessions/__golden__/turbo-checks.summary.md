# Review summary: Fix the core helper and run the suite.

Branch: `main` · Date: 2026-01-02 · Session: `turbo-ch`

5 prompts: 4 checked, 1 unchecked.

| # | Status | Review | Prompt | Files | +/- |
| ---: | --- | --- | --- | ---: | --- |
| 1 | checked | Skim | Fix the core helper and run the suite. | 1 | +1 -1 |
| 2 | checked | Skim | Fix the web view and core model, then test web only. | 2 | +2 -2 |
| 3 | checked | Skim | Run every task's tests. | 1 | +1 -1 |
| 4 | unchecked | Read flagged | Preview the test run. | 1 | +1 -1 |
| 5 | checked | Skim | Test the web project by name. | 1 | +1 -1 |

## Needs attention

### Prompt 2: Fix the web view and core model, then test web only.

- Status: checked (turbo run test --filter ./packages/web passed after last edit (scoped to packages/web))
- Review: Skim
- **warn** `check-scope`: `packages/core/src/c.ts`

### Prompt 4: Preview the test run.

- Status: unchecked (no checks ran)
- Review: Read flagged
- **warn** `unchecked-edit`: `packages/web/src/e.ts`

---

_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._
