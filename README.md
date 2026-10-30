# lgtm-review

Review what a coding agent did in a Claude Code session without reading every line: which prompts were checked, where the time went, what the agent did step by step, and what it changed.

Monorepo: packages/core, packages/cli, packages/web.

## What it does

- **Statuses**: heuristic classification of each prompt (`checked`, `unchecked`, `failing`, `no-changes`) based on whether tests or checks ran after code edits.
- **Triage**: filter prompts by "Needs attention" (unchecked, failing, or carrying review hints) in the UI and session list; keyboard navigation (`↑`/`↓`, `Enter`/`Space`, `s` for steps, `m` for map, `Escape`).
- **Steps and diffs**: vertical breakdown of agent actions per prompt (Read, Write, Check, Fix), check results, agent quotes, and per-file unified diffs showing what the agent edited from session logs (agent edits, not final git state).
- **Review hints**: deterministic heuristics and recommendations (`Read all`, `Read flagged`, `Skim`) highlighting sensitive paths, tests modified during fix, removed assertions, skipped tests, unchecked edits, dependency changes, public surface, config changes, large changes, and scoped checks.
- **Import map**: visual dependency graph of changed source files and 1-hop in-repo neighbours grouped by directory layer, highlighting new imports added by the session (TypeScript/JavaScript and Python).
- **Play**: step-by-step playback replaying the prompt's file edits, new imports, and checks against the map.
- **Git cross-check**: compares session log edits against read-only `git status` and commit history to highlight uncommitted/committed files not in the log, or log edits not in git.
- **Worktrees**: automatically discovers linked git worktrees (`git worktree add`, `claude --worktree`) and presents sessions across all worktrees.
- **Live refresh**: polls the local API every 5 seconds via conditional requests (`ETag`/`304`) to update running sessions live without losing scroll or expanded state.
- **`--summary`**: prints a markdown review summary of a session (default: newest) for a PR description.
- **`--export`**: writes a self-contained offline HTML file of a session (no JavaScript, best-effort secret redaction).
- **`--archive`**: mirrors session logs to a private local archive directory so older sessions are not lost when Claude Code cleans up logs after `cleanupPeriodDays`.
- **Local LLM titles**: optional one-sentence prompt titles generated via a local model server (Ollama, llama.cpp, LM Studio) over loopback HTTP.

See [CHANGELOG.md](CHANGELOG.md) for version history and release notes.

## Installation and running

The package is not on npm yet. After the first release, you will be able to run it with `npx lgtm-review`. Until then, run it from a checkout (requires Node >= 22).

### From a checkout

```bash
git clone https://github.com/jack2k0/lgtm-review.git
cd lgtm-review
corepack pnpm install --frozen-lockfile
corepack pnpm check                 # typecheck, tests, build and the pack smoke test
node packages/cli/dist/cli.js       # starts the local UI for the current repo
```

CLI modes from a checkout:

```bash
node packages/cli/dist/cli.js --list     # terminal list (redacted best-effort; --raw prints unredacted log text)
node packages/cli/dist/cli.js --summary  # markdown summary of a session for a PR description
node packages/cli/dist/cli.js --export <id-prefix>  # self-contained HTML file of a session
```

### After the first release (`npx`)

```bash
npx lgtm-review            # starts the local UI for the sessions of the current repo
npx lgtm-review --list     # terminal output instead of the UI (redacted best-effort; --raw prints unredacted log text)
npx lgtm-review --summary  # markdown summary of a session for a PR description
npx lgtm-review --export <id-prefix>  # self-contained HTML file of a session (redaction is best-effort)
```

The `--raw` flag prints log text unredacted (only valid with `--list` or `--json`; by default secrets, repo paths, and usernames are redacted best-effort).

Merge gate (run from a worktree; exit 0 pass, 1 hard fail, 2 needs a look):

```
node scripts/gate.mjs --base main [--plan <plan.md>] [--run-check] [--merge]
node scripts/gate.mjs --tiers   # risk tier table
```

It checks freshness, scope (a fenced `gate` block in the plan: `allow`, `goldens`, `labels`, `deps`, `schema`), labels, goldens, removed test expectations, dependencies and the schema, and prints a risk tier. With `--merge` it also checks the pre-merge review ledger for that tier. Contributor rules are in [AGENTS.md](AGENTS.md), review rules in [REVIEW.md](REVIEW.md).

The server listens on 127.0.0.1 only, is read-only and requires the per-run token in the printed URL. See packages/cli/README.md for options, the Steps/Diff views and their limits.

## Keeping old sessions

Claude Code deletes session logs older than `cleanupPeriodDays` (a setting in `~/.claude/settings.json`, default 30 days), so lgtm-review can only show sessions whose logs still exist, and a session reviewed last month can disappear. Run `npx lgtm-review --archive` regularly to keep copies, or raise `cleanupPeriodDays`. `--archive` mirrors the repository's session logs to a private local archive (`--archive-dir <path>`, else `$LGTM_REVIEW_ARCHIVE`, else `~/.lgtm-review/archive`) and refuses, with exit 1, when the archive directory would lie inside the repository or the Claude Code projects directory. Every reader — `--list`, `--json`, `--summary`, `--export` and the web UI — lists archived sessions alongside live ones, marked `(archived)`, and reads the longer copy when a session exists in both. `--list` and `--json` redact log text best-effort by default; pass `--raw` to print it unredacted. Details are in [packages/cli/README.md](packages/cli/README.md).

## Local LLM titles (optional)

Opt in with both `--llm-url` and `--llm-model` (no default model). The web UI then shows a one-sentence title above each of the session's own prompts, labelled "generated". Nothing is rendered and no model connection is made without the flags.

```
npx lgtm-review --llm-url http://127.0.0.1:11434 --llm-model qwen3:4b   # Ollama
npx lgtm-review --llm-url http://127.0.0.1:8080 --llm-model qwen        # llama.cpp server
npx lgtm-review --llm-url http://127.0.0.1:1234/v1 --llm-model qwen      # LM Studio
```

The URL is `http` only, to a loopback host (`127.0.0.0/8`, `[::1]`, or `localhost`, which is rewritten to `127.0.0.1` and not resolved through DNS). Any other host is rejected. What is sent for each own prompt is a condensed, redacted view: the prompt text, up to 25 step titles and up to 20 repository-relative file paths. Tool output, diffs and quotes are not sent. Titles are cached under `~/.lgtm-review/cache/titles` (override with `--llm-cache-dir`) and are never written into `--summary`, `--export`, `--list` or `--json`. `--no-titles` does not affect them. Inherited prompts do not get a title. Details are in packages/cli/README.md.

Licensed under Apache-2.0. Copyright lgtm-review contributors.
