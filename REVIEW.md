# REVIEW.md

How changes to lgtm-review are reviewed before merge. Modelled on Anthropic's agent-era review ("How the Claude Code team does code review", claude.dev, 2026-10-15): automated checks block, the change sets the risk tier, every finding gets an answer, and lessons are fixed at the source.

This file is High tier: changes need the owner's approval, because it decides what reviewers may skip.

## Flow

1. **Worker verifies.** `pnpm check` and `node scripts/gate.mjs --base main --plan <plan.md>` before each phase commit; the report quotes the output.
2. **Orchestrator verifies.** Reads the diff and runs `node scripts/gate.mjs --base main --plan <plan.md> --run-check` in the worktree. Exit 1 = no merge.
3. **Pre-merge review by tier** (table below). The reviewer's model differs from the implementer's.
4. **Every finding is answered** in `context/changes/<id>/reviews/findings.md`.
5. **Merge gate.** `node scripts/gate.mjs --base main --plan <plan.md> --run-check --merge` must exit 0 or 2 (each item explained). The block goes into the merge commit body.
6. **Push** is the owner's: they read the gate block of every High merge since the last push.

## Tiers

The change sets the tier, not the author: the highest tier over all changed files. The source of truth is `TIERS` in `scripts/gate.mjs`; print it with `node scripts/gate.mjs --tiers`.

| Tier | Typical paths | Before merge |
|---|---|---|
| Low | `*.md`, `docs/`, `context/`, tests and goldens only | Gate green. No reviewer. |
| Medium | other `packages/*/src/**`, `scripts/**` | Gate green + **1** reviewer, diff-only, quick. |
| High | status rule (`analyze`, `check-patterns`, `shell-edits`, `parse`, `subagents`, `scope`, `hints`, `inherit`), `redact`, `schema`, server/API/export/summary, `node/{git,archive,read,subagents}`, web token, label files, manifests and lockfile, CI, `smoke-pack`/`build-demo`/`gate`, `AGENTS.md`/`REVIEW.md`/`CLAUDE.md` | Gate green + **2** reviewers in parallel, then **cross-verification**: each reviewer confirms or refutes the other's Important findings with a command. Status-rule paths also need a real-log PRE/POST audit (aggregate counts). Owner reads the gate block before push. |

An agent's approval never stands in for the owner's on High: the owner's push is the approval, and it covers the commits pushed.

## What failure looks like here

Review against these first; they are the bugs this repo has actually had.

- **Status rule:** a prompt is labelled `checked` that a human would call unchecked (a check that ran before the last edit, in another package or worktree, or was masked); or statuses on real logs change without an audit.
- **Redaction / export:** a secret survives into `--summary`, `--export`, a step title, a truncated line or any derived text (JSON-escaped, URL credentials, flag values, partial tokens cut by truncation).
- **Server:** something is reachable without the token, from another origin or Host, outside loopback, or outside the session directories.
- **Git:** anything writes to a repository or runs git through a shell string.
- **Archive:** a larger archive copy is overwritten, a symlink is followed, or a file lands outside the archive directory.
- **Web:** log content is rendered as markup.
- **Tests:** an existing expectation or label file was changed to make the change pass.
- **Docs:** they describe behaviour the code does not have.

## Findings

- Each finding gives `file:line` and evidence: a reproduction command, a failing input or a failing test. No evidence, no finding.
- Tags: **Important** (wrong behaviour, leak, data loss), **Nit** (at most 3 per pass), **Pre-existing** (not introduced by this diff; never blocks).
- At most 8 findings per pass. No style-only findings.
- Skip: `pnpm-lock.yaml`, `__golden__/*` (judge goldens through the test that produces them), `context/archive/**`.
- Bug fixes: check that the root cause is fixed, not the symptom.
- Re-reviews look only at the new diff and do not repeat earlier findings.
- Wording: describe access rules, robustness, and what is reachable or leaves the machine. Neutral wording keeps every reviewer model usable.

## Ledger

`context/changes/<id>/reviews/findings.md` (the gate reads it):

```markdown
reviewers: agy, opencode

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence or reason | Caught late by |
|---|---|---|---|---|---|---|---|---|
| 1 | Important | packages/core/src/redact.ts:120 | `whsec_` kept in titles | opencode | agy: confirmed (repro) | fixed (abc1234) | test `redact.test.ts` "webhook secret" | — |
```

- Findings go only in tables with a Verdict column. The gate fails closed: a table without a Verdict column, or a row after a blank line, counts as unanswered. A row with fewer cells than its header is malformed and the failure names that line; a row with more cells (an unescaped pipe) is unanswered. A ledger with no finding rows must say `findings: none` on its own line; prose or bullet findings without it fail the gate. Escape a literal pipe as `\|` or keep it in backticks.
- Verdict is `fixed` (with commit), `rejected` (with the reason) or `deferred` (with where it is tracked). An empty verdict fails the gate.
- An accepted Important finding lands with a test or fixture that fails on the old code.
- "Caught late by" names the layer that should have caught it (plan review, gate, worker check, pre-merge review, audit) when the finding came after merge.

## Rounds

- At most **2** review rounds. If round 2 still has new Important findings, stop and reconsider the approach or the plan instead of a third round.

## Merge commit body

```
Merge branch 'change/<id>' (<title>)

Tier: High (packages/core/src/analyze.ts)
Gate: <block from scripts/gate.mjs --merge>
Evidence: real-log audit PRE/POST <n> prompts, <k> status changes
Review: agy + opencode; 5 findings: 3 fixed, 1 rejected, 1 deferred
Revert: git revert -m 1 <this merge>
```

## Fix at the source

A finding category accepted twice becomes a line here, a rule in `AGENTS.md`, or a check in `scripts/gate.mjs`, so the next change cannot repeat it.
