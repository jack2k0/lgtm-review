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
