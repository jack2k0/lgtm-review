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

## Keeping old sessions

Claude Code deletes session logs older than `cleanupPeriodDays` (a setting in `~/.claude/settings.json`, default 30 days), so lgtm-review can only show sessions whose logs still exist, and a session reviewed last month can disappear. Run `npx lgtm-review --archive` regularly to keep copies, or raise `cleanupPeriodDays`. `--archive` mirrors the repository's session logs to a private local archive (`--archive-dir <path>`, else `$LGTM_REVIEW_ARCHIVE`, else `~/.lgtm-review/archive`) and refuses, with exit 1, when the archive directory would lie inside the repository or the Claude Code projects directory. Every reader — `--list`, `--json`, `--summary`, `--export` and the web UI — lists archived sessions alongside live ones, marked `(archived)`, and reads the longer copy when a session exists in both. Details are in [packages/cli/README.md](packages/cli/README.md).

## Local LLM titles (optional)

Opt in with both `--llm-url` and `--llm-model` (no default model). The web UI then shows a one-sentence title above each of the session's own prompts, labelled "generated". Nothing is rendered and no model connection is made without the flags.

```
npx lgtm-review --llm-url http://127.0.0.1:11434 --llm-model qwen3:4b   # Ollama
npx lgtm-review --llm-url http://127.0.0.1:8080 --llm-model qwen        # llama.cpp server
npx lgtm-review --llm-url http://127.0.0.1:1234/v1 --llm-model qwen      # LM Studio
```

The URL is `http` only, to a loopback host (`127.0.0.0/8`, `[::1]`, or `localhost`, which is rewritten to `127.0.0.1` and not resolved through DNS). Any other host is rejected. What is sent for each own prompt is a condensed, redacted view: the prompt text, up to 25 step titles and up to 20 repository-relative file paths. Tool output, diffs and quotes are not sent. Titles are cached under `~/.lgtm-review/cache/titles` (override with `--llm-cache-dir`) and are never written into `--summary`, `--export`, `--list` or `--json`. `--no-titles` does not affect them. Inherited prompts do not get a title. Details are in packages/cli/README.md.

Licensed under Apache-2.0. Copyright lgtm-review contributors.
