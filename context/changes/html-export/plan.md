# HTML export with redaction (S-06) Implementation Plan

## Overview

`lgtm-review --export <session-id-prefix> [--out <file>] [--no-diffs] [--dir <path>] [--projects-dir <path>]` writes one self-contained HTML file: session header, prompt table (status, recommendation, hints, time-split bar, files), per prompt Steps (check results, quotes, raw actions) and optionally per-file diffs. No JavaScript, no external requests, every string HTML-escaped, secrets redacted. Intended for attaching to a PR or sending to a colleague.

## Current State Analysis

- Core: `analyzeFileDetail` (analyzer with `details()`, `diffFor`), schemas `SessionAnalysis`, `PromptDetail`, `Step`, `FileDiff`, hints, `timeSplit`, `headline`. `@lgtm/core/node`: `discoverSessions`, `analyzeFile`, `analyzeFileDetail`, `projectDirFor`.
- CLI: `cli.ts` (flags `--list`, `--json`, `--summary`, `--session`, `--no-titles`, server default), `summary.ts` (markdown with token redaction of titles; heuristic pattern set exists there), `format.ts`. Web CSS tokens in `packages/web/src/styles.css` (light/dark).
- Existing guardrails: secret-scan test over `packages/core/fixtures/` patterns.

## Desired End State

- `packages/core/src/redact.ts` (node-free): `redact(text, opts?): {text, count}` applying an ordered, documented pattern set: Anthropic/OpenAI keys (`sk-ant-...`, `sk-...` >= 20), GitHub tokens (`ghp_`, `gho_`, `ghs_`, `github_pat_`), AWS (`AKIA[0-9A-Z]{16}`, `aws_secret_access_key` assignments), Google API keys (`AIza...`), Slack (`xox[baprs]-`), Stripe (`sk_live_`, `rk_live_`), JWTs (`eyJ...\..*\..*`), PEM private key blocks (whole block), `Authorization: Bearer|Basic ...` headers, URLs with credentials (`scheme://user:pass@`), `KEY=value`/`key: value` assignments where the key name contains `token|secret|password|passwd|api[_-]?key|credential|private[_-]?key` (value replaced), `.env`-style lines in file content blocks of `.env*` diffs (entire values redacted), generic high-entropy strings (>= 32 chars of base64/hex alphabet with entropy >= 4.0 bits/char, not looking like a path/URL/git sha-with-context). Replacement `[redacted:<kind>]`. Home directory paths: `/home/<user>/` and `/Users/<user>/` -> `~/`; the current OS username in free text -> `<user>`; email addresses -> `[redacted:email]`.
- Renderer `packages/cli/src/export-html.ts`: pure function `renderExport(input, opts): string` where input = `{analysis: SessionAnalysis, details: PromptDetail[], diffs: Map<promptIndex, FileDiff[]>}` obtained via analyzer; output is a full HTML document: `<meta charset>`, CSP `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`, inline `<style>` (same palette/tokens as the UI, light/dark via `prefers-color-scheme`, print-friendly), semantic structure with `<details>` for steps/diffs (works without JS), status as text + colored dot, hints list, time bar as CSS widths, banner "Exported from a local Claude Code session log on <date>; statuses and hints are heuristic; secrets are redacted on a best-effort basis, review before sharing". All text passes through `escapeHtml` AND `redact` (order: redact then escape). No `<script>`, no remote URLs (links are never generated from log text; file paths are text).
- CLI: `--export` conflicts with `--list`, `--json`, `--summary` (exit 1). `--out` default `lgtm-review-<session8>.html` in cwd; refuses to overwrite an existing file unless `--force`; writes with mode 0644 via a temp file + rename; prints the output path and the redaction count to stderr/stdout (one line). `--no-diffs` omits diffs entirely (steps/actions summaries remain). `--no-titles` also respected (prompt text omitted). Diff limits reuse core caps; additional export cap: 5 MB total diff text, then "diffs omitted (size cap)".
- Safety properties tested: no `<script`, no `on*=` attributes, no `http(s)://` outside text nodes (assert regex on the generated tag/attribute set), CSP meta present, malicious strings (`<img onerror>`, `</style>`, `javascript:`) rendered inert, redaction corpus (>= 40 secret samples across kinds) never appears in the output, the repo's secret-scan patterns never match the golden exports, golden HTML files byte-exact for synthetic fixtures.

## What We're NOT Doing

- No interactive JS in the export, no search/filter, no embedded screenshots, no PDF, no upload/share action, no automatic redaction guarantees (documented best effort), no local archive (FR-008 second half), no change to analysis rules, no export from the web UI (CLI only in this slice).

## Implementation Approach

Three phases: (1) core redaction module with corpus tests; (2) renderer + CLI flag with goldens and safety tests; (3) docs, smoke on packed CLI, final review of a real session export (local only, not committed).

## Critical Implementation Details

- Redaction runs on every string that can hold log content: prompt text, reasons, step titles, quotes, check commands and excerpts, action summaries, file paths, diff lines, hint reasons, titles, branch. Apply per string; diff lines are redacted per line but multi-line constructs (PEM blocks) are handled by redacting the diff body joined with `\n` per hunk before splitting back (line count preserved: replace block lines with `[redacted:private-key]` on the first line and empty-marker lines `[redacted]` for the rest).
- `redact` must be deterministic and idempotent (`redact(redact(x).text).text === redact(x).text`), linear-time (no catastrophic regexes; test with a 1 MB adversarial string < 500 ms).
- Entropy rule must not redact git SHAs (40 hex) when preceded by `commit `/`sha`/in a diff header — keep a small allowlist: 40/64-hex strings are redacted ONLY if the surrounding key name looks secret; UUIDs never redacted.
- Escape: `&`, `<`, `>`, `"`, `'`, and backtick; also strip NUL/control characters except `\n` and `\t`.
- CSS in the export duplicates only the needed rules; contrast >= 4.5:1 for text in both themes (reuse tokens from the web styles test pairs).
- Export reads the session file once, via the existing analyzer; memory bounded by existing caps; file size warning on stderr when > 10 MB.

## Phase 1: Core redaction

**Files**: `packages/core/src/redact.ts`, `redact.test.ts`, `index.ts` export, `packages/core/fixtures/redact/secrets.json` is NOT allowed to hold real secrets: samples are synthetic, assembled at test time from fragments (e.g. `"sk-" + "ant-" + ...`) so the fixture secret-scan test and GitHub push protection do not trigger.

**Contract**: as Desired End State; table-driven corpus >= 40 positive samples, >= 25 negative samples (paths, UUIDs, SHAs, normal prose, base64-looking images in a data: URL are not secrets, long identifiers), idempotence and performance tests.

### Success Criteria

- `pnpm check` green; node-free grep rule empty; secret-scan test over fixtures still green

## Phase 2: Renderer and CLI flag

**Files**: `packages/cli/src/{export-html.ts,export.ts,cli.ts}`, tests incl. goldens `packages/core/fixtures/sessions/__golden__/*.export.html` (for 3 synthetic fixtures, with and without `--no-diffs`), e2e on built CLI.

**Contract**: as Desired End State.

### Success Criteria

- `pnpm check` green incl. safety assertions and byte-exact goldens

## Phase 3: Docs and smoke

**Files**: `packages/cli/README.md` (Export section with the best-effort redaction warning), root README line, `scripts/smoke-pack.mjs` (packed CLI exports a fixture session; assert file exists, contains CSP meta, no `<script`, contains status words; no secret sample).

### Success Criteria

- `pnpm check` green incl. smoke; tarball < 2 MB
- Orchestrator exports one real local session, greps the output for the repo owner's home path, username and obvious token patterns, and opens it in a headless browser (file stays local, not committed)

## Progress

### Phase 1: Core redaction

- [ ] 1.1 `pnpm check` green, node-free grep empty

### Phase 2: Renderer and CLI

- [ ] 2.1 `pnpm check` green incl. safety assertions and goldens

### Phase 3: Docs and smoke

- [ ] 3.1 `pnpm check` green incl. smoke
- [ ] 3.2 Real-session export reviewed locally

## Plan-review amendments (accepted by orchestrator, 2026-10-23)

- F1: order is fixed: `redact` on the raw string first, `escapeHtml` after; test with a secret containing a literal `&` and with HTML-entity-looking input.
- F2: add patterns: `client_secret`, `access_token`, `auth_token`, `api-token`, `x-api-key` and `api-key` headers (Azure), `Cookie:`/`Set-Cookie:` values for session/token-like names, DeepSeek/Vertex style keys covered by the generic `KEY=value` rule; add >= 10 positive samples.
- F3: high-entropy rule fires only with context (a secret-like key name nearby, or inside `Authorization`/`Bearer`, or the string is >= 40 chars and not hex/UUID/`data:` URL/path/URL); 40/64-hex and `data:` URLs never redacted without secret-like key context; tests for each.
- F4: PEM redaction is a single pass over the whole joined text (per hunk body or per string), regex `-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----` (bounded length 100 KB, unterminated `BEGIN` redacts to end of the text); line count of diffs is preserved afterwards; boundary tests (start/end, split, multiple blocks, unterminated).
- F5: the entropy scan is a manual single-pass tokenizer (no nested quantifiers); dedicated adversarial 1 MB tests (long runs of alphabet characters, repeated near-matches) < 500 ms.
- F6: `<style>` content is a constant (no interpolation); malicious-string injection test across all text fields (`</style>`, `<img onerror>`, `javascript:`, `"` and `'` in attributes).
- F7: username detection: `os.userInfo().username`, `USER`, `USERNAME`, `LOGNAME` (deduplicated, length >= 3, excluding `root`, `user`, `admin` generic names which are not redacted in free text but home-path rules still apply); paths `/home/<x>/`, `/Users/<x>/`, `/root/` -> `~/`; the absolute repo dir (`--dir`) is rewritten to `<repo>/`; tests with usernames `jack`, `root`, `admin`.
- F8: the reported count is the total number of replacements (documented); idempotence test remains.
