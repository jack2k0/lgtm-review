# Highlighted diffs, quieter cross-check, browser tests (S-29)

Already done and out of scope: narrow-screen rules (`styles.css:306`), Esc back navigation (`App.tsx:17`).

## Phase 1: syntax highlighting in diffs

Files: `packages/web/src/highlight.ts` (new), `packages/web/src/highlight.test.ts` (new), `packages/web/src/DiffView.tsx`, `packages/web/src/styles.css`.

No new dependency. A small line tokenizer returning `{ kind, text }[]` for comments, strings, numbers and keywords in TS/JS, Python and JSON, chosen by file extension; any other extension gets plain text. Rendered as React `<span>` children only, never as markup (`dangerouslySetInnerHTML` stays absent). Concatenating the tokens always gives the exact input line. It is linear in the line length, and lines over 2000 characters stay plain. Colours use tokens that work in light and dark and keep the added/removed row backgrounds readable. Tests: round-trip property on odd input, a log line holding `<script>` renders as text, unknown extension is plain.

## Phase 2: quieter git cross-check

Files: `packages/web/src/GitView.tsx`, `packages/web/src/git.test.tsx`, `packages/web/src/styles.css`.

Each list of files in the view with more than 20 entries renders inside a closed `<details>` whose summary gives the section's name and count; 20 or fewer stay open as today. Counts and data do not change. Existing expectations stay as they are: add tests for the over-20 case.

## Phase 3: browser tests

Files: `packages/web/e2e/` (new), `packages/web/playwright.config.ts` (new), `packages/web/package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`, `packages/web/vite.config.ts` or vitest config only if needed to keep e2e out of `pnpm test`.

`@playwright/test`, Chromium only, not part of `pnpm check`; script `test:e2e`. The test starts the built CLI (`packages/cli/dist/cli.js --no-open --dir <tmp> --projects-dir <tmp>`) on a synthetic session written by the test, reads the URL from stdout, and walks list, session, Steps, diff and Map with no console errors. At a 390 px viewport the page has no horizontal page scroll. Log text containing `<img src=x onerror=...>` shows as text. A CI job `e2e` on Ubuntu Node 22 runs `playwright install --with-deps chromium`, then build and `test:e2e`.

## Non-goals

A highlighting library, split diffs, theme changes, API or schema changes, a11y tooling.

## Gate
```gate
allow: ^packages/web/src/(highlight|highlight\.test|git\.test)\.tsx?$
allow: ^packages/web/src/(DiffView|GitView)\.tsx$
allow: ^packages/web/src/styles\.css$
allow: ^packages/web/e2e/
allow: ^packages/web/(playwright\.config\.ts|vite\.config\.ts|vitest\.config\.ts|package\.json)$
allow: ^pnpm-lock\.yaml$
allow: ^\.github/workflows/ci\.yml$
allow: ^\.gitignore$
allow: ^context/(changes|archive)/ui-browser/
deps: yes
schema: no
```
