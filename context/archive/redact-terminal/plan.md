# `--list` and `--json` redact by default (S-23)

## Cause

`packages/cli/src/format.ts:66-67` prints prompt text and reason as they are, and `packages/cli/src/cli.ts:441` prints the whole analysis as JSON, while `--summary` and `--export` redact. Secrets in a session log reach the terminal, CI logs and redirected files.

## Phase 1

Files: `packages/cli/src/cli.ts`, `packages/cli/src/format.ts`, `packages/cli/src/format.test.ts`, `packages/cli/src/e2e.test.ts`, `packages/cli/README.md`, `README.md`.

1. Add `--raw` (only with `--list` or `--json`; any other use is an error like the other flag checks). Help and both READMEs describe it: default output is redacted best-effort; `--raw` prints log text unredacted.
2. Default `--list`: every string taken from the log goes through `redact` with the options `--summary` uses (`osUsernames()` and the repo dir): session title, prompt text, reason, file paths, warnings. Redact before any truncation (`oneLine`).
3. Default `--json`: walk the analysis and redact every string value, keeping keys, numbers and structure; do not redact `sessionId`, `status`, timestamps or the top-level `dir`. The output must stay valid for the existing schema.
4. Tests that fail on the old code: a synthetic session with `password=hunter2secret` in a prompt and a failing check's output; the secret appears in neither default mode and appears with `--raw`. `--raw` without `--list`/`--json` exits 1.

If an existing test expects raw output by default, do not edit it: stop and report it.

## Non-goals

Web UI and API output (the local server stays as it is), redaction rules, status rules, `--summary`/`--export`.

## Gate
```gate
allow: ^packages/cli/src/(cli|format|format\.test|e2e\.test)\.ts$
allow: ^(packages/cli/)?README\.md$
allow: ^context/(changes|archive)/redact-terminal/
deps: no
schema: no
```
