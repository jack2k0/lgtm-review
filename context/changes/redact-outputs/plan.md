# redact-outputs (S-33)

Roadmap S-33, F2 (verified), F10 + G4 (docs). Guardrail: no secrets / personal data leave the machine; the README promises `<user>` in `--summary` and redacted `--list`/`--json`.

## Phase 1 (only phase)

1. `packages/cli/src/summary.ts` `redact`: the `...opts` spread overwrites the `usernames` default with an explicit `undefined` (callers at lines ~65/78/141 pass `usernames: opts?.usernames`). Build the options as `{ ...opts, usernames: opts.usernames ?? osUsernames() }`. Check the other callers of core `redact` in `packages/cli/src` for the same pattern and fix them the same way.
2. `--json` (`packages/cli/src/cli.ts` ~line 393, and the empty case ~464): the top-level `dir` is printed raw. Without `--raw`, print it redacted (`<repo>`, i.e. through the same redactor with `repoDir: dir`). With `--raw`, unchanged. Check `redactAnalysis` covers every other path field (`root`, worktree labels); if one is raw, redact it too and list it in the report.
3. README (`README.md`, `packages/cli/README.md`): wherever the docs show a placeholder, make it match the code: `[redacted:<kind>]`, `<user>`, `<repo>`, `~`. Mention that `--json` shows the repo directory as `<repo>` unless `--raw`.
4. Tests (must fail on the old code): `--summary` on a synthetic session whose prompt contains the OS user name (inject via the existing test seam for usernames/home, or set `USER`/`HOME` in the spawned env) prints `<user>`, not the name; `--json` without `--raw` has `"dir": "<repo>"`; with `--raw` the real dir.

No existing expectation changes. If one breaks, stop and report.

Done: `pnpm check` green; gate exit 0 or 2 with each item explained.

Non-goals: no change in core `redact.ts`.

```gate
allow: ^packages/cli/src/(summary|cli|export|export-html|format)\.ts$
allow: ^packages/cli/src/[a-z-]+\.test\.ts$
allow: ^packages/cli/test/
allow: ^(packages/cli/)?README\.md$
allow: ^context/(changes|archive)/redact-outputs/
deps: no
schema: no
```
