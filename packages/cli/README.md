# lgtm-review

CLI. Run `npx lgtm-review`.

## Usage

```
npx lgtm-review [--dir <path>] [--projects-dir <path>] [--list | --json | --summary [--session <id-prefix>] [--no-titles] | --export <id-prefix> [--out <file>] [--force] [--no-diffs] [--no-titles]] [--no-open] [--port <n>]
```

Without flags the command starts a local web UI for the Claude Code sessions of the current repository, prints its URL and opens it in your browser. Press Ctrl+C to stop.

- `--list` prints the sessions and their prompt statuses in the terminal instead of starting the UI (`--json` prints the analysis as JSON).
- `--summary` prints a markdown review summary of one session (see below); `--session <id-prefix>` picks the session (default: the newest), `--no-titles` leaves prompt titles out.
- `--no-open` prints the URL without opening a browser.
- `--port <n>` listens on a fixed port instead of a free one.

Security: the server listens only on 127.0.0.1, is read-only, and checks the Host and Origin headers on every request. The URL carries a random per-run token (in the `#k=` fragment) that the page sends with each API call, so other local sites and processes cannot read your sessions. Treat the URL as a secret and do not share it. The URL is printed to stdout in full; the browser is opened through a short-lived 0600 file in a private temp directory (removed on exit or after about 60 s) so the token never appears in another process's command line.

## Steps and diff

In the web UI each prompt row has a **Steps** link. It opens a vertical list of the steps the agent took for that prompt:

- a phase badge (Read, Write, Check, Fix; the same classification as the time bar), a mechanical title such as "Edit src/a.ts (+2 -1)" and an approximate duration;
- for a check step: the command, its result ("passed" or "exit 1") and the first failing lines;
- the agent's own words before the step, as short quotes;
- a "N actions" disclosure that lists the raw tool calls (tool, target, time);
- file chips. Click one (or a file in an expanded prompt row) to open the **diff** of that file for this prompt: a unified diff with `+`/`-` prefixes and background colors, hunk headers, and horizontal scrolling for long lines. Escape goes back to the steps.

The diff is what the agent's edits did, taken from the session log only: **agent edits, not final git state**. lgtm-review never reads your repository or runs git for this. Shell edits, removals and moves may be missing; such files are marked "may be incomplete".

Limits (so very large sessions stay fast): a diff shows at most 2000 lines and 2000 characters per line, a prompt keeps at most 200 steps and 5000 actions, quotes are cut to 400 characters. When something was cut the UI says so. Titles and quotes are templates and verbatim text; nothing is summarised by an LLM. All text from the log is rendered as plain text, never as markup.

The same data is available from the local API (token required, as for the other routes): `GET /api/sessions/<id>/prompts/<index>` and `GET /api/sessions/<id>/prompts/<index>/diff?path=<file>`; `path` must be one of the prompt's files.

## Live

While a Claude Code session is still running, the page keeps itself up to date: every 5 seconds it asks the local API whether the current view changed, using conditional requests. The header shows **Live · updated HH:MM:SS** (the time new data last arrived) and a **Pause**/**Resume** button; the choice is remembered for the tab only (session storage), and live is on by default.

- Each of the four data routes (`/api/sessions`, `/api/sessions/<id>`, `.../prompts/<index>`, `.../diff?path=`) answers with a strong `ETag` derived from the size and modification time of the session files it depends on (all session files of the project for the list, the one file otherwise). Send it back as `If-None-Match` and an unchanged view costs a `304` with no body and no re-analysis, only a `stat` per session file. The routes use `Cache-Control: no-cache, private`; the Host, Origin and token checks run before anything is compared, and a `304` is never sent for a session, prompt or file that does not exist.
- Polling pauses while the tab is hidden and refetches immediately when you come back; it also stops while paused and is cancelled when you leave the view. Requests never overlap.
- If the server cannot be reached the old data stays on screen with a "Connection lost, retrying" note; retries back off from 5 s to 10 s to 30 s and return to 5 s after a success.
- Expanded rows (by prompt number), expanded action lists (by step number), "show more" counts and the scroll position survive a refresh.
- A line that is still being written can show up as a transient "truncated last line" warning; the next refresh clears it.

## Review hints

Each prompt gets a **recommendation** and a list of **hints** that say where to look first. They come from the edits in the session log only (small counters per edit; no file contents are kept), are deterministic and are heuristics, not verdicts.

Recommendation: `Read all` when there are high-severity hints of at least three different rules, or the prompt is failing and has a high hint; `Read flagged` when there is any high hint or the prompt is failing or unchecked; otherwise `Skim` (also for prompts without changes).

Rules (severity):

- `test-modified-during-fix` (high): a test file was edited after a failed check, before the next passing one.
- `assertions-removed` (high): in test files, more assertion lines (`expect(`, `assert*(`, `self.assert*(`, `.should`) were removed than added.
- `test-skipped` (high): skip markers were added (`.skip(`, `xit(`, `xdescribe(`, `it.todo`, `test.todo`, `@pytest.mark.skip`/`xfail`, `t.Skip(`, `@Disabled`).
- `sensitive-path` (high; warn for test files): path segments such as `auth`, `login`, `secrets`, `tokens`, `credentials`, `migrations`, `permissions`, `security`, `.env*`, `Dockerfile*`, `.github/workflows/`.
- `unchecked-edit` (warn): the file was edited after the last completed check.
- `dependency-change` (warn): a manifest or lockfile was edited (`package.json`, lockfiles, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, ...).
- `public-surface` (warn): a package entry `index.ts|js`, or a path with `routes/`, `api/`, `openapi` or `schema`.
- `config-change` (info): TypeScript, lint, formatter, bundler or CI configuration.
- `large-change` (info): more than 300 changed lines in one file within the prompt.

The web UI shows the recommendation in a **Review** column, marks flagged files with the rule name, lists the hints in an expanded row, and shows a **Where to look** block (top 5 hints) above the steps of a prompt. Hints are also part of `GET /api/sessions/<id>` and `GET /api/sessions/<id>/prompts/<index>`.

## Status accuracy and limits

Statuses are heuristics read from the session log, not verdicts. Known limits:

- **Shell edits.** File changes made through Bash are exact only when the log carries a diff for them (Claude Code records one when the session started inside the repository). Without it lgtm-review reads the command text: `sed -i`, `perl -pi`, `tee`, `>`/`>>` redirects, `git apply`, `git mv` and `python - <<` scripts that `open(..., 'w')` count as edits, listed as "may be incomplete" with the target path when it is trivial to parse and `(shell edit)` otherwise, and the reason ends with "(shell edits may be incomplete)". Redirects to `/tmp`, `$TMPDIR`, `.cache`, scratch directories, log files and `/dev/*`, and failed commands, are ignored. Other writers (`mv`, `cp`, `rm`, formatters, package managers, code generators) are not detected.
- **Git operations.** Edits made by a command whose only mutating parts are `git merge|rebase|pull|checkout|stash|cherry-pick|mv|restore|reset` stay in the file list (marked incomplete) but never change a status or invalidate an earlier passing check. A prompt with only such edits is "no changes".
- **Masked exit codes.** When a check's exit code does not reflect the check (a pipe such as `| tail`, `|| true`, `; echo`), lgtm-review looks for failure signals (for example `2 failed`, `EXIT=1`, `BUILD FAILURE`) in the last 4 KB of the output and reports `failing` when it finds one. Otherwise the reason says "(exit code not verified)". A check followed by `git checkout|restore|stash` on files is marked "(edits may have been reverted)".
- **Not analysed.** Subagent activity (prompts are marked partial) and background tasks.

To measure how these limits affect your own sessions, run `pnpm build` and then `node scripts/audit-status.mjs [--dir <repo>] [--projects-dir <dir>]` from a checkout of the repository. It runs the built CLI with `--list --json` and prints aggregate counts only: sessions and prompts, the status distribution, the share of partial prompts, the share of prompts with heuristic shell edits and the share of checks with an unverified exit code. It never prints prompt text, paths, commands or reasons; add `--json` for machine-readable output.

## Resumed and forked sessions

Resuming or forking a Claude Code session copies the earlier prompts (same prompt `uuid`) into a new file. lgtm-review analyses all sessions of the project together: the session that started first owns a prompt, and the copies in later sessions are marked `inheritedFrom: <session id>`. Inherited prompts are not counted: `promptCount` and `statusCounts` cover the session's own prompts, `inheritedCount` the rest, and `forkOf` names the session most of them came from.

`--list` marks them `(inherited from <id8>)`; `--json` and the API keep them, with `inheritedFrom`. `--summary` and `--export` leave them out and say so ("N prompts inherited from <id8> omitted"); a session with no prompts of its own prints "All N prompts inherited from <id8>. No prompts to review." Only equal prompt `uuid`s count; the timelines are not merged.

## Summary

```
npx lgtm-review --summary [--session <id-prefix>] [--no-titles]
```

Prints markdown for a PR description: title, branch, date, a table of prompts (status, recommendation, title, file count, `+/-`) and, for every prompt that is unchecked, failing or has hints, its reason and hints (severity, rule, path). Paths below the repository are relative. A footer states that statuses are heuristic. `--summary` cannot be combined with `--list` or `--json` (exit 1).

The summary contains no command output (a failing check shows only `<command> failed`), no file contents and no full prompt text. Titles are the first line of the prompt cut to 80 characters, with token-like text (API keys, `Bearer ...`, `password=...`, long hex or base64-like strings) replaced by `[redacted]`; this is best effort.

Privacy: prompt titles and file paths can still reveal internal names, so read the text before you paste it into a public PR, or use `--no-titles` to print "Prompt N" instead of titles. Markdown-special characters (`|`, backticks, `*`, `_`, brackets, `<`, `>`) in titles and paths are escaped and newlines are collapsed.

## Export

```
npx lgtm-review --export <id-prefix> [--out <file>] [--force] [--no-diffs] [--no-titles]
```

Writes one session as a single self-contained HTML file (default `lgtm-review-<first 8 chars of the id>.html` in the current directory) and prints its path and the number of redactions. `<id-prefix>` must match exactly one session. An existing output file is not overwritten unless you pass `--force`. `--no-diffs` leaves the file diffs out, `--no-titles` prints "Prompt N" instead of prompt titles. `--export` cannot be combined with `--list`, `--json`, `--summary` or `--session`.

The file contains the prompt table with statuses and review hints, the steps of every prompt and (unless `--no-diffs`) the file diffs. It has no JavaScript and makes no external requests (a Content-Security-Policy meta tag forbids them), so it can be opened offline and attached to a PR or a chat.

**Warning: redaction is best-effort. Read the file before you share it.** The export replaces secrets and personal data with placeholders, but no automatic filter finds everything. You are responsible for what you publish.

What is redacted:

- PEM blocks (private keys, certificates) and vendor token formats (for example GitHub, AWS, Slack, JWT).
- `Authorization` / `Cookie` style headers, credentials in URLs, and cookies.
- `key=value` / `key: value` assignments with secret-like names (`password`, `token`, `secret`, `api_key`, ...), `--password <value>` style flags, and every value in `.env*` files.
- High-entropy strings with a secret-like context or a known prefix.
- E-mail addresses, the repository directory (shown as `<repo>`), the home directory (`~`) and your OS user name (`<user>`).

Known gaps (these can stay in the file):

- A secret shorter than 6 characters without quotes.
- A high-entropy string shorter than 40 characters with neither a context word nor a known prefix.
- Passwords made only of capital letters and `_`.
- Windows paths inside JSON strings (escaped backslashes).
- The user name match is case-sensitive.
- A directory that has the same name as the user (for example `/home/dashboard` when the user is `dashboard`) is rewritten to `~`, which can hide real paths.
- Prompt text, file contents in diffs, company and project names, and anything a person would call confidential but that does not look like a secret.

Limits: diffs are included up to 5 MB of text in total (later diffs are left out and the file says so), each step lists at most 200 actions, and a session log larger than 10 MB prints a warning because the export can be large and slow.
