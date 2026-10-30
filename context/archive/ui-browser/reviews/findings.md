# Review findings: ui-browser

reviewers: haiku, opus

The `e2e` CI job has not run on GitHub yet. Locally `test:e2e` passes against Chromium.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Important | .github/workflows/ci.yml | `pnpm exec playwright` fails at the root | opus | run: command not found | fixed | now `--filter @lgtm/web exec`, gives 1.64.1 |
| 2 | Nit | packages/web/e2e/walk.spec.ts:294 | the Map assertion passed on any SVG | haiku | opus: read | fixed | asserts `.map-scroll` |
| 3 | Nit | packages/web/src/highlight.ts:86 | a quote in a regex or comment continuation colours the rest of the line as a string | haiku | opus | rejected | colour only, text stays exact; a line tokenizer cannot know multi-line context |
| 4 | Nit | packages/web/src/highlight.ts:24 | contextual words such as `type` and `get` are always keywords | haiku | opus | rejected | colour only |
| 5 | Nit | packages/web/src/GitView.tsx:111 | a refresh crossing 20 entries changes a toggled list | haiku | opus | rejected | rare, no data lost |
