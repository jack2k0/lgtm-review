# Review summary: Generate the big parser.

Branch: `main` · Date: 2026-01-01 · Session: `hints-la`

5 prompts: 4 checked, 1 failing.

| # | Status | Review | Prompt | Files | +/- |
| ---: | --- | --- | --- | ---: | --- |
| 1 | checked | Skim | Generate the big parser. | 1 | +350 -0 |
| 2 | checked | Skim | Tweak design tokens and the tokenizer. | 5 | +5 -5 |
| 3 | checked | Read flagged | Rework the auth service and token refresh. | 2 | +2 -2 |
| 4 | checked | Read flagged | Clean up the tests with sed. | 1 | +1 -4 |
| 5 | failing | Read all | Make the payment tests pass. | 2 | +2 -4 |

## Needs attention

### Prompt 1: Generate the big parser.

- Status: checked (pnpm test passed after last edit)
- Review: Skim
- **info** `large-change`: `src/parser.js`

### Prompt 3: Rework the auth service and token refresh.

- Status: checked (pnpm test passed after last edit)
- Review: Read flagged
- **high** `sensitive-path`: `src/AuthService.ts`
- **high** `sensitive-path`: `src/tokens/refresh-token.ts`

### Prompt 4: Clean up the tests with sed.

- Status: checked (pnpm test passed after last edit)
- Review: Read flagged
- **high** `assertions-removed`: `tests/x.test.ts`

### Prompt 5: Make the payment tests pass.

- Status: failing (pnpm test failed)
- Review: Read all
- **high** `assertions-removed`: `tests/pay.test.ts`
- **high** `test-modified-during-fix`: `tests/pay.test.ts`
- **high** `test-skipped`: `tests/pay.test.ts`

---

_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._
