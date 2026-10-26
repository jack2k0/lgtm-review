# lgtm-review

Review what a coding agent did in a Claude Code session without reading every line: which prompts were checked, where the time went, what the agent did step by step, and what it changed.

Monorepo: packages/core, packages/cli (published), packages/web.

## Status (MVP)

- S-01 sessions and prompt statuses (checked / unchecked / failing / no changes): done.
- S-02 local web UI with the session list, prompt table and time split: done.
- S-03 steps per prompt and per-file diffs from the log: done.
- S-05 review hints per prompt (where to look, Skim / Read flagged / Read all) and `npx lgtm-review --summary`, a markdown summary for a PR description: done.

Not in the MVP: syntax highlighting, split diffs.

## Run

```
npx lgtm-review            # starts the local UI for the sessions of the current repo
npx lgtm-review --list     # terminal output instead of the UI
npx lgtm-review --summary  # markdown summary of a session for a PR description
npx lgtm-review --export <id-prefix>  # self-contained HTML file of a session (redaction is best-effort: review it before sharing)
```

From a checkout (Node >= 22, pnpm):

```
pnpm install --frozen-lockfile
pnpm check                 # typecheck, tests, build and the pack smoke test
node packages/cli/dist/cli.js
```

Merge gate (run from a worktree; exit 0 pass, 1 hard fail, 2 needs a look):

```
node scripts/gate.mjs --base main [--plan <plan.md>] [--run-check] [--merge]
node scripts/gate.mjs --tiers   # risk tier table
```

It checks freshness, scope (a fenced `gate` block in the plan: `allow`, `goldens`, `labels`, `deps`, `schema`), labels, goldens, removed test expectations, dependencies and the schema, and prints a risk tier. With `--merge` it also checks the pre-merge review ledger for that tier. Contributor rules are in [AGENTS.md](AGENTS.md), review rules in [REVIEW.md](REVIEW.md).

The server listens on 127.0.0.1 only, is read-only and requires the per-run token in the printed URL. See packages/cli/README.md for options, the Steps/Diff views and their limits.

Licensed under Apache-2.0. Copyright lgtm-review contributors.
