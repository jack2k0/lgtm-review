# lgtm-review

CLI. Run `npx lgtm-review`.

## Usage

```
npx lgtm-review [--dir <path>] [--projects-dir <path>] [--list | --json] [--no-open] [--port <n>]
```

Without flags the command starts a local web UI for the Claude Code sessions of the current repository, prints its URL and opens it in your browser. Press Ctrl+C to stop.

- `--list` prints the sessions and their prompt statuses in the terminal instead of starting the UI (`--json` prints the analysis as JSON).
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
