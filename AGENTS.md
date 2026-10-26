# AGENTS.md

Rules for every agent working in this repo (implementers, reviewers, the orchestrator). Keep it short; review rules live in [REVIEW.md](REVIEW.md).

## Stack and commands

- pnpm workspaces + Turborepo, Node >= 22, TypeScript, vitest. Use pnpm, never npm or yarn.
- Packages: `packages/core` (parser, statuses, hints, map; `src/node/` holds the only Node-specific code), `packages/cli` (the published `lgtm-review`: CLI, local server, export), `packages/web` (React UI).
- `pnpm install --frozen-lockfile`, then `pnpm check` (typecheck, test, build, pack smoke, then the perf suite). If `pnpm` is missing, `corepack pnpm check`.
- `node scripts/gate.mjs --base main [--plan <plan.md>] [--run-check]` before every commit of a phase. Exit 0 pass, 1 hard fail, 2 needs a look (explain each item in your report).

## Contracts

- The Story JSON (`packages/core/src/schema.ts`, zod) is the contract between core and web. Only a plan with `schema: yes` in its gate block may change it; schema changes go first, in one phase.
- `packages/core/src` outside `src/node/` and `src/testing/` imports nothing from `node:`; the web bundle uses it.
- Git is called only through `execFile`/`spawn` with fixed arguments, read-only. Never a shell string.
- The local server stays on 127.0.0.1, read-only, behind the per-run token.

## Tests are ground truth

- Never edit an existing `packages/core/fixtures/sessions/*.labels.json`. A label that disagrees with your rule means the rule is wrong: stop and report.
- Never change or delete an existing test expectation to make a change pass. If you believe an expectation is wrong, stop and report it with evidence.
- Golden files (`__golden__/`) change only when the plan's gate block lists them.
- Every fixed bug gets a test that fails on the old code.
- Timing assertions belong in `*.perf.test.ts` (run sequentially), not in ordinary tests.

## Privacy

- Real session logs (`~/.claude/projects`) contain secrets. Never paste their content into a prompt, a fixture, a commit or a report; only aggregate counts from a local script.
- Fixtures are synthetic or fully anonymised.
- Redaction (`redact.ts`) fails closed: when unsure, redact.

## Work rules

- One phase = one brief = one worktree (`../lgtm-review-<id>`, branch `change/<id>`). Never two agents in one worktree.
- Stay inside the plan's files. Plan unclear or contradicting the code: stop and report, do not guess.
- No new dependencies unless the plan says `deps: yes`. No CI changes unless the phase is about CI.
- Do not push, merge or switch branches. Commit on your branch only.

## Report (your last message)

1. Changed files.
2. Verbatim last lines of `pnpm check` and the full gate block.
3. Deviations from the plan, with the reason.
4. Open problems / TODO.

Do not claim success without the command output.
