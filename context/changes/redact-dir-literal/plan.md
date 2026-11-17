# redact-dir-literal (follow-up of S-33)

Fable review 2026-11-17, finding 1 (Important): `redactDir` in `packages/cli/src/cli.ts` (~381) runs the full core redactor over the repo path; earlier rules (email, `password=`) rewrite part of the path first, so the repo-dir rule no longer matches and parent directories stay visible: `--dir /srv/team@example.com/proj --json` → `"dir": "/srv/[redacted:email]/proj"`. The README promises `<repo>`.

## Phase 1 (only phase)

1. `redactDir` returns the literal `"<repo>"` (keep the `--raw` path unchanged). Both the normal and the empty-sessions `--json` output.
2. Test in `packages/cli/src/redact-outputs.test.ts`: `--json` with a synthetic repo dir containing `team@example.com` and one containing `password=hunter2secret` gives `"dir": "<repo>"`; must fail on the old code.
3. Fable finding 2 (Nit): a unit test in `packages/cli/src/format.test.ts` (new test only) that `redactAnalysis(analysis, { usernames: undefined, repoDir: … })` and `formatText(…, { redact: { usernames: undefined } … })` still redact the OS user name (inject via the same env seam the other tests use); must fail with the old option order (`...opts` last). Report the fail-first check.
4. Do not touch the redaction of the same path inside titles/text (pre-existing, out of scope; report it).

Done: `pnpm check` green; gate exit 0 or 2.

```gate
allow: ^packages/cli/src/cli\.ts$
allow: ^packages/cli/src/(redact-outputs|format)\.test\.ts$
allow: ^context/(changes|archive)/redact-dir-literal/
deps: no
schema: no
```
