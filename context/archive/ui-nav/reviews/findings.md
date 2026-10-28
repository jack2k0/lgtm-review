# Findings: change/ui-nav

Tier Medium (packages/web). Implementer: Grok. Reviewer: OpenCode (GLM-5.3-Flash). One round. Orchestrator check: Opus.
New tests fail on old code: 13 failed / 158 passed on main sources (reviewer run).

reviewers: opencode

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason |
|---|---|---|---|---|---|---|---|
| 1 | Nit | context/changes/ui-nav/plan.md:45 | "no existing expectation changed" contradicts section 3, which drops the Where column; two git.test.tsx lines removed | opencode | — | fixed | plan wording names the two obsolete lines; gate EYES item explained in the merge message |
| 2 | Nit | packages/web/src/GitView.tsx:14 | root group rendered as "(root)/" | opus | — | fixed | label "(root)" without slash; git.test.tsx updated (new test of this branch) |
