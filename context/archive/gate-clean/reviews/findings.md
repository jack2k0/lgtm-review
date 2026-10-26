# Findings: change/gate-clean

Tier High (scripts/gate.mjs). Implementer: Opus. Reviewers: Haiku, Agy; cross-verified. One round.
Cause: the status-accuracy-3 merge passed the gate with its ledger and audit report untracked in the worktree, so the merge left them out (recovered in e5b3aa5).

reviewers: haiku, agy

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Important | scripts/gate.mjs:172 | a submodule with `ignore = all` hides a dirty submodule | haiku | agy: confirmed | fixed | `--ignore-submodules=none`; test "dirty submodule" fails without it |
| 2 | Important | scripts/gate.mjs:172 | an uncommitted ledger makes --merge fail | haiku | — | rejected | intended: the ledger must be committed to be merged; docs/prompts/03-review.md step 4 now says so |
| 3 | Nit | scripts/gate.mjs:172 | a rename is listed as one "old -> new" entry | haiku | — | rejected | still fails; display only |
| 4 | Nit | packages/cli/src/gate.test.ts:272 | no submodule/rename case | haiku | — | fixed | submodule test added |
