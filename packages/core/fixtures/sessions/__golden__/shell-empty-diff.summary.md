# Review summary: Patch with sed and commit in one command.

Branch: `main` · Date: 2026-01-01 · Session: `shell-em`

5 prompts: 3 unchecked, 2 no-changes.

| # | Status | Review | Prompt | Files | +/- |
| ---: | --- | --- | --- | ---: | --- |
| 1 | unchecked | Read flagged | Patch with sed and commit in one command. | 1 | +0 -0 |
| 2 | no-changes | Skim | Only commit. | 0 | +0 -0 |
| 3 | unchecked | Read flagged | Patch with sed, commit; the log has a diff. | 1 | +1 -1 |
| 4 | no-changes | Skim | Write a file with a heredoc, then test, in one command. | 0 | +0 -0 |
| 5 | unchecked | Read flagged | Test, patch, commit in one command. | 1 | +0 -0 |

## Needs attention

### Prompt 1: Patch with sed and commit in one command.

- Status: unchecked (no checks ran (shell edits may be incomplete))
- Review: Read flagged
- **warn** `unchecked-edit`: `src/a.js`

### Prompt 3: Patch with sed, commit; the log has a diff.

- Status: unchecked (no checks ran)
- Review: Read flagged
- **warn** `unchecked-edit`: `src/real.js`

### Prompt 5: Test, patch, commit in one command.

- Status: unchecked (1 edit after last check (shell edits may be incomplete))
- Review: Read flagged
- **warn** `unchecked-edit`: `src/c.js`

---

_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._
