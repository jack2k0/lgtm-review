# lgtm-review

CLI. Run `npx lgtm-review`.

## Usage

```
npx lgtm-review [--dir <path>] [--projects-dir <path>] [--archive-dir <path>] [--archive | --list | --json | --summary [--session <id-prefix>] [--no-titles] | --export <id-prefix> [--out <file>] [--force] [--no-diffs] [--no-titles]] [--no-open] [--port <n>] [--no-worktrees]
```

Without flags the command starts a local web UI for the Claude Code sessions of the current repository, prints its URL and opens it in your browser. Press Ctrl+C to stop.

- `--archive` mirrors new or updated session logs of this repository to a private local archive (see Archive below).
- `--archive-dir <path>` sets the local archive root directory (default: `$LGTM_REVIEW_ARCHIVE` or `~/.lgtm-review/archive`).
- `--list` prints the sessions and their prompt statuses in the terminal instead of starting the UI (`--json` prints the analysis as JSON).
- `--summary` prints a markdown review summary of one session (see below); `--session <id-prefix>` picks the session (default: the newest), `--no-titles` leaves prompt titles out.
- `--no-open` prints the URL without opening a browser.
- `--no-worktrees` shows only the sessions of `--dir`, not of the repository's other git worktrees.
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

## Triage and keyboard

A prompt **needs attention** when it is unchecked or failing or has at least one review hint (the rule of the "Needs attention" section of `--summary`); inherited prompts are not counted. The prompt table says how many need attention ("12 prompts · 4 prompts need attention") and **All** / **Needs attention** above it switch between all prompts and only those. The choice is part of the address (`#/session/<id>?show=attention`), so reload and Back keep it. The session list shows the same count per session and has the same filter (`#/?show=attention`). `GET /api/sessions` carries it as `attentionCount`.

Keyboard in the prompt table: Tab to a prompt, then ↑/↓ move between prompts, Enter or Space expands or collapses the row, `s` opens its Steps and `m` its import map. Escape goes back to the session list. The keys act only on a focused prompt row (Escape anywhere on the page) and never while you type in a field.

## Import map

The **Map** view (per session or per prompt) shows the changed source files and their direct in-repo neighbours: files they import and files that import them, one hop, at most 150 nodes. Nodes are grouped into layers by top-level directory (`packages/<x>` and `apps/<x>` per package) and coloured by the status of the prompt that last changed them; click a changed file to open its diff. The map reads the **current working tree** under `--dir` ("imports as of now"), not the tree at prompt time; it scans at most 5000 files of 512 KB each.

- **TS/JS**: ESM `import`/`export … from`, literal `import()` and `require()`; relative paths and `tsconfig` `paths` aliases.
- **Python**: `import a.b` and `from a import b` (relative imports too), resolved to `.py` files or `__init__.py` under the repository root, `src/` and every directory that contains a `manage.py`. Packages outside the repository (stdlib, virtualenv) are not shown. In a Django project each app is its own layer (`backend/shop`, `backend/core`).
- Extraction is a regular-expression scan, not a parser: unusual syntax can produce a missing or an extra edge. `importlib`/`__import__` and computed specifiers are ignored. In Python files, comments and string literals are blanked before matching.
- Imports a session's own edits added are **new** edges (solid, highlighted); the rest are **existing** (grey). The legend counts both. Detection reads the `+` lines of each changed file's diff, so imports added by shell edits without a diff are shown as existing.

## Play the change

A prompt's map has a **▶ Play the change** link (only for prompts of this session that edited files or ran checks). It replays the prompt as a sequence of beats, `3 / 9`: each beat highlights the files and imports it is about and dims the rest.

- Beats follow the order in which files were first edited: `Created cart.test.ts (+40)`, `Edited cart.ts (+3 -1)`, `views.py now imports models.py`. A file edited again while fixing a failed check gets a `Fix: edited …` beat. Every check is a beat: `pnpm vitest run -> failed`, with the first failing lines.
- Files outside `--dir` (scratch notes, plans) are left out. At most 60 beats per prompt; the view says when more were cut.
- Controls: `‹` / `›`, **Play**/**Pause** (a beat every 2.5 s), **Done** (back to the map). Keyboard: `←` `→`, `Space`, `Escape`. Autoplay does not start when the system asks for reduced motion.
- Captions are templates, not an LLM. API: `GET /api/sessions/<id>/prompts/<index>/play` (token required, ETag/304 like the other routes).

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
- `check-scope` (warn): the prompt is checked, but the check that passed after this file's last edit ran on only part of the repository (a path argument, `cd <dir> &&`, `pnpm -C`/`--filter ./dir`, `npm --prefix`, `go test ./pkg/...`, or a Bash working directory below the session's). A scope also covers files whose path contains its last non-test folder name (`tests/api` covers `src/api/`) and the source file of a scoped test file (`cart.test.ts` covers `cart.ts`). Named package filters (`--filter @scope/pkg`) are not resolved. The hint means "confirm the scoped check covers this file", not "untested".

Documentation files (see "Documentation edits" under Status accuracy and limits) only get `large-change`.

The web UI shows the recommendation in a **Review** column, marks flagged files with the rule name, lists the hints in an expanded row, and shows a **Where to look** block (top 5 hints) above the steps of a prompt. Hints are also part of `GET /api/sessions/<id>` and `GET /api/sessions/<id>/prompts/<index>`.

## Status accuracy and limits

Statuses are heuristics read from the session log, not verdicts. Known limits:

- **Shell edits.** File changes made through Bash are exact only when the log carries a diff for them (Claude Code records one when the session started inside the repository). Without it lgtm-review reads the command text: `sed -i`, `perl -pi`, `tee`, `>`/`>>` redirects, `git apply`, `git mv` and `python - <<` scripts that `open(..., 'w')` count as edits, listed as "may be incomplete" with the target path when it is trivial to parse and `(shell edit)` otherwise, and the reason ends with "(shell edits may be incomplete)". Redirects to `/tmp`, `$TMPDIR`, `.cache`, scratch directories, log files and `/dev/*`, and failed commands, are ignored. Other writers (`mv`, `cp`, `rm`, formatters, package managers, code generators) are not detected.
- **Git operations.** Edits made by a command whose only mutating parts are `git merge|rebase|pull|checkout|stash|cherry-pick|mv|restore|reset` stay in the file list (marked incomplete) but never change a status or invalidate an earlier passing check. A prompt with only such edits is "no changes".
- **Scoped checks.** A checked prompt whose deciding check ran on only part of the repository says "(scoped to <scope>)" in its reason and flags the edited files outside that scope with `check-scope`; the status stays checked.
- **Documentation edits.** Edits whose files are all documentation (`*.md`, `*.markdown`, `*.mdown`, `*.mkd`, `*.mkdn`, `*.rst`, `*.adoc`, `*.asciidoc`, and files named `README`, `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, `AUTHORS`, `CONTRIBUTORS`, `CHANGELOG`, `CHANGES` or `HISTORY`, also with `.txt`) stay in the file list, the steps and the diffs but need no check: they never make a prompt unchecked and never invalidate an earlier passing check (the reason then reads "pnpm test passed after last code edit; 1 documentation edit after it"). A prompt that only edited documentation is "no changes" with the reason "no code edits (documentation only)". `.mdx` and other `.txt` files count as code. If your build or tests consume Markdown (doctests, prompt templates), read those files yourself.
- **Scratch files.** Files written outside the session's directory in a temporary or scratch location (`/tmp`, `/var/tmp`, macOS `/var/folders`, or a folder whose name starts with `scratch`, such as Claude Code's own scratchpad) are listed but need no check, like documentation: a prompt that only wrote such files is "no changes" ("no code edits (scratch files only)"), and they get no review hints. Files in the tool call's own working directory or in a `.claude/worktrees/` folder are never scratch.
- **Masked exit codes.** When a check's exit code does not reflect the check (a pipe such as `| tail`, `|| true`, `; echo`), lgtm-review looks for failure signals (for example `2 failed`, `EXIT=1`, `BUILD FAILURE`) in the last 4 KB of the output and reports `failing` when it finds one. Otherwise the reason says "(exit code not verified)". A check followed by `git checkout|restore|stash` on files is marked "(edits may have been reverted)".
- **Subagents.** Edits and checks from subagent transcripts count toward the prompt that started the subagent, merged by timestamp. A prompt is marked partial only when a transcript is missing or nested deeper than 3 levels; a transcript cut by a cap is named in the reason.

Checks started in the background (`run_in_background`) only confirm the launch, so their result is taken from Claude Code's later task notification. A background run that failed counts as failing; one that was killed or stopped is reported as "check stopped", which leaves the prompt unchecked with no verdict.

To measure how these limits affect your own sessions, run `pnpm build` and then `node scripts/audit-status.mjs [--dir <repo>] [--projects-dir <dir>]` from a checkout of the repository. It runs the built CLI with `--list --json` and prints aggregate counts only: sessions and prompts, the status distribution, the share of partial prompts, the share of prompts with heuristic shell edits, the share of checks with an unverified exit code the share of prompts whose documentation edits were not counted and the share of checked prompts with files outside the check's scope. It never prints prompt text, paths, commands or reasons; add `--json` for machine-readable output.

## Resumed and forked sessions

Resuming or forking a Claude Code session copies the earlier prompts (same prompt `uuid`) into a new file. lgtm-review analyses all sessions of the project together: the session that started first owns a prompt, and the copies in later sessions are marked `inheritedFrom: <session id>`. Inherited prompts are not counted: `promptCount` and `statusCounts` cover the session's own prompts, `inheritedCount` the rest, and `forkOf` names the session most of them came from.

`--list` marks them `(inherited from <id8>)`; `--json` and the API keep them, with `inheritedFrom`. `--summary` and `--export` leave them out and say so ("N prompts inherited from <id8> omitted"); a session with no prompts of its own prints "All N prompts inherited from <id8>. No prompts to review." Only equal prompt `uuid`s count; the timelines are not merged.

## Worktrees

Claude Code stores each session under the directory it was started in, so sessions of a linked git worktree (`git worktree add`, or `claude --worktree`, which creates worktrees under `.claude/worktrees/`) belong to that worktree. lgtm-review asks git once per run for the repository's worktrees (`git worktree list`, read-only) and shows the sessions of all of them: the terminal list marks them `[worktree ../name]`, `--json` and the API carry `worktree` (the path relative to the main checkout, `.` for the main checkout), and the web list gets a Worktree column and filter. Steps, diffs, the import map and play of a worktree session use that worktree's directory; `--export` redacts its path as `<repo>`. `--archive` mirrors every worktree's sessions. Worktrees that git no longer lists, and their archived sessions, are not shown; a worktree added while the UI runs appears after a restart. Use `--no-worktrees` for the sessions of `--dir` only.

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

## Archive

Claude Code automatically deletes session logs older than `cleanupPeriodDays` (default 30 days). A review from last month then disappears. `lgtm-review --archive` mirrors the current repository's session logs and their subagent transcripts into a private local archive:

```
npx lgtm-review --archive [--dir <path>] [--projects-dir <path>] [--archive-dir <path>]
```

- **Where it goes:** `--archive-dir <path>`, else env `LGTM_REVIEW_ARCHIVE`, else `~/.lgtm-review/archive`. Sessions for the repository are stored under `<archiveRoot>/<project-dir-name>/`.
- **Merged across all readers:** every reader (terminal `--list`, `--json`, `--summary`, `--export`, and the web UI) automatically reads from the archive for sessions whose live logs were deleted. Live sessions take precedence over archived copies. Sessions read from the archive are marked `(archived)` in the terminal list, carry `archived: true` in `--json` and the API, and show an "archived" badge in the web UI.
- **Privacy:** the archive is a private, unredacted copy of raw logs already stored on your machine (`~/.claude`), with the same trust level. It is never uploaded anywhere. The archive is opt-in: only `lgtm-review --archive` writes to it; all other commands and the local server treat it as read-only.
- **Automation (optional):** you can mirror sessions automatically via a cron job or git hook:
  ```bash
  # Cron example: daily mirror at 18:00
  0 18 * * * npx lgtm-review --archive --dir /path/to/repo

  # Git hook example: mirror on push (.git/hooks/pre-push)
  npx lgtm-review --archive || true
  ```

## Demo

A static demo built from a synthetic session (no real logs or personal paths) is committed at `docs/demo/index.html`. Rebuild it with `pnpm build && pnpm demo`.
