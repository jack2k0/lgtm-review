# Pre-merge review briefs

Templates for the review step in `REVIEW.md`. The orchestrator fills in the `<...>` fields; reviewers do not get any other instructions.

## Reviewer pick

| Tier | Reviewers | Fallback when an agent is out of quota |
|---|---|---|
| Low | none | — |
| Medium | 1, a different model from the implementer | Haiku subagent |
| High | 2 different models, in parallel, then cross-verification | Sonnet subagent for one of the two |

Never the implementer's model as the only reviewer.

## Review brief

```text
Read-only review. Do not edit, commit or switch branches.
Repo: <ABS worktree path>, branch change/<id>. Diff: git diff main...change/<id>
Intent: context/changes/<id>/plan.md (phases <n>), non-goals included.
Rules: REVIEW.md (sections "What failure looks like here" and "Findings") and AGENTS.md.
Tier: <tier> (node scripts/gate.mjs --base main prints it). Focus: <areas from REVIEW.md that the diff touches>.
<Round 2 only: findings already answered are in context/changes/<id>/reviews/findings.md; review only commits after <sha> and do not repeat them.>

For each finding: tag (Important / Nit / Pre-existing), file:line, one sentence, and evidence you ran
(command + output, failing input, or a failing test). At most 8 findings, at most 3 Nits. No style-only findings.
"No findings" is a valid answer; say which areas you checked.

Write the result to <scratchpad>/review-<id>-<reviewer>.md and reply only with that path.
```

## Cross-verification brief (High tier)

```text
Read-only. Repo: <ABS worktree path>, branch change/<id>.
Another reviewer reported the Important findings in <scratchpad>/review-<id>-<other>.md.
For each one, try to reproduce it with a command or a test against this branch.
Answer per finding: confirmed (command + output) / refuted (command + output showing correct behaviour) / unclear (why).
Do not add new findings. Write to <scratchpad>/verify-<id>-<reviewer>.md and reply only with that path.
```

## Orchestrator after review

1. Copy every finding into `context/changes/<id>/reviews/findings.md`, with the `reviewers:` line.
2. Triage confirmed findings first. Check a refuted or unclear one yourself before rejecting it.
3. Fix accepted findings in the same worktree (a brief per batch), each with a test that fails on the old code.
4. Fill in every verdict, then run `node scripts/gate.mjs --base main --plan context/changes/<id>/plan.md --run-check --merge`.
5. Round 2 only when fixes were non-trivial: diff-only, same reviewers. No round 3; reconsider the approach instead.
