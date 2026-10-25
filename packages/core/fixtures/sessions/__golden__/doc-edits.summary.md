# Review summary: Fix add, run the tests, then note it in the changelog.

Branch: `main` · Date: 2026-01-01 · Session: `doc-edit`

5 prompts: 1 checked, 1 unchecked, 1 failing, 2 no-changes.

| # | Status | Review | Prompt | Files | +/- |
| ---: | --- | --- | --- | ---: | --- |
| 1 | checked | Skim | Fix add, run the tests, then note it in the changelog. | 2 | +3 -2 |
| 2 | no-changes | Skim | Update the guide and the README. | 2 | +2 -1 |
| 3 | unchecked | Read flagged | Add sub and document it, no need to test. | 2 | +2 -1 |
| 4 | failing | Read flagged | Fix the parser and note what still fails. | 2 | +2 -2 |
| 5 | no-changes | Skim | Tighten the security policy and the auth docs. | 2 | +2 -2 |

## Needs attention

### Prompt 3: Add sub and document it, no need to test.

- Status: unchecked (no checks ran)
- Review: Read flagged
- **warn** `unchecked-edit`: `src/sub.js`

### Prompt 4: Fix the parser and note what still fails.

- Status: failing (pnpm test failed)
- Review: Read flagged

---

_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._
