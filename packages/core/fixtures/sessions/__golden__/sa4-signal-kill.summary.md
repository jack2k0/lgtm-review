# Review summary: Edit add, pass the tests, then lint is killed.

Branch: `main` · Date: 2026-01-01 · Session: `sa4-sign`

4 prompts: 1 checked, 2 unchecked, 1 failing.

| # | Status | Review | Prompt | Files | +/- |
| ---: | --- | --- | --- | ---: | --- |
| 1 | checked | Skim | Edit add, pass the tests, then lint is killed. | 1 | +1 -1 |
| 2 | unchecked | Read flagged | Edit add and the only check exits 144. | 1 | +1 -1 |
| 3 | failing | Read flagged | Edit add and fail the tests. | 1 | +1 -1 |
| 4 | unchecked | Read flagged | Edit add and run the tests in the background until they are signalled. | 1 | +1 -1 |

## Needs attention

### Prompt 2: Edit add and the only check exits 144.

- Status: unchecked (check did not complete)
- Review: Read flagged
- **warn** `unchecked-edit`: `src/add.js`

### Prompt 3: Edit add and fail the tests.

- Status: failing (pnpm test failed)
- Review: Read flagged

### Prompt 4: Edit add and run the tests in the background until they are signalled.

- Status: unchecked (check did not complete)
- Review: Read flagged
- **warn** `unchecked-edit`: `src/add.js`

---

_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._
