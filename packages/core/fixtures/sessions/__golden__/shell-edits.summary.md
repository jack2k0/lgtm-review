# Review summary: Rename the constant in the config loader.

Branch: `main` · Date: 2026-01-01 · Session: `shell-ed`

8 prompts: 1 checked, 3 unchecked, 1 failing, 3 no-changes.

| # | Status | Review | Prompt | Files | +/- |
| ---: | --- | --- | --- | ---: | --- |
| 1 | unchecked | Read flagged | Rename the constant in the config loader. | 1 | +0 -0 |
| 2 | no-changes | Skim | Rename it in the docs too and run the tests. | 1 | +0 -0 |
| 3 | checked | Skim | Generate the lookup table and verify. | 1 | +0 -0 |
| 4 | no-changes | Skim | Dump the environment to a scratch file. | 0 | +0 -0 |
| 5 | no-changes | Skim | Patch the parser. | 0 | +0 -0 |
| 6 | failing | Read flagged | Apply the patch and fix the header, then test. | 2 | +0 -0 |
| 7 | unchecked | Read flagged | Bump the version and test in one go. | 1 | +0 -0 |
| 8 | unchecked | Read flagged | Edit through a shell that does log the diff. | 1 | +1 -1 |

## Needs attention

### Prompt 1: Rename the constant in the config loader.

- Status: unchecked (no checks ran (shell edits may be incomplete))
- Review: Read flagged
- **warn** `unchecked-edit`: `src/config.js`

### Prompt 6: Apply the patch and fix the header, then test.

- Status: failing (pnpm test failed)
- Review: Read flagged

### Prompt 7: Bump the version and test in one go.

- Status: unchecked (1 edit after last check (shell edits may be incomplete))
- Review: Read flagged
- **warn** `dependency-change`: `package.json`
- **warn** `unchecked-edit`: `package.json`

### Prompt 8: Edit through a shell that does log the diff.

- Status: unchecked (no checks ran)
- Review: Read flagged
- **warn** `unchecked-edit`: `src/real.js`

---

_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._
