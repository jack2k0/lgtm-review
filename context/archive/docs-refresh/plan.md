# Current README and readable help (S-27)

## Cause

The root `README.md` status stops at S-05 and never mentions Map or Play, leads with `npx lgtm-review` although the package is not published, and the CLI help has one very long usage line.

## Phase 1

Files: `README.md`, `packages/cli/README.md`, `packages/cli/src/cli.ts` (the `HELP` constant only).

1. `README.md`: replace "Status (MVP)" with a short "What it does" list covering every current feature: statuses, triage, steps and diffs, hints, import map, Play, git cross-check, worktrees, live refresh, `--summary`, `--export`, `--archive`, local LLM titles. Check each one against `packages/cli/README.md` and the code; write only what the code does.
2. Install truth in both READMEs: state that the package is not on npm yet, put "From a checkout" first, and label `npx lgtm-review` as "after the first release". Say Node >= 22 and what `--raw` does.
3. Keep the merge gate, archive and LLM sections; cut nothing that is still true. Name `CHANGELOG.md`.
4. `HELP`: a short usage line (`lgtm-review [mode] [options]`), then groups: Modes, Selection, Export, Server, Local titles, Other. Every existing flag appears with its current text. No behaviour change.

If a test pins the old help text, do not edit it: stop and report.

## Non-goals

Screenshots, hosting the demo, renaming, behaviour changes, flag changes.

## Gate
```gate
allow: ^(packages/cli/)?README\.md$
allow: ^packages/cli/src/cli\.ts$
allow: ^context/(changes|archive)/docs-refresh/
deps: no
schema: no
```
