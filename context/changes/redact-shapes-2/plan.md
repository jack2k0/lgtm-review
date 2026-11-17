# redact-shapes-2 (S-34)

Roadmap S-34: Gm3 (verified), F1, F10 (repro first). Guardrail: no secrets leave the machine. All rule work in `packages/core/src/redact.ts`; tests in `redact.test.ts` (new tests only) and a new table-driven `redact-corpus.test.ts`. Owner's standing warning: do not over-hide ordinary text — every new rule gets "unchanged" rows too.

## Phase 1: repro + the verified leak + reference exemptions

1. Repro first: add failing rows for each case below; record which already pass on `main` (those keep a test, no rule change).
2. URL credentials (`redact.ts` ~1527, `/^[$%{]/`): a password starting with `%` is exempted. Exempt only real templates: `%VAR%` (`%[A-Za-z_][A-Za-z0-9_]*%`), `${…}`, `$VAR` / `$(…)`. `postgres://admin:%21Xk9pQ2vLm8nR4tZ@localhost:5432/app` → password redacted.
3. `isNonLiteral` (~549) exempts values of secret-named keys too broadly. Must be redacted: `token: hvs.CAESIJ7xk2mQpLr9tWv4NbYz` (Vault), a Discord bot token shape `MTA4NjQ5ODc2NTQzMjEwOTg3Ng.GxYz12.AbCdEfGhIjKlMnOpQrStUvWxYz012345`, `password: $uper$ecret99`, `secret: <k3y-9fA2xQ>`. Must stay: `password: ${DB_PASSWORD}`, `token: $GITHUB_TOKEN`, `api_key: <your-api-key>`, `password: process.env.DB_PASS`, `secret: os.environ["X"]`.

## Phase 2: new contexts + corpus

1. Per-tool password flags: `docker login -u u -p <v>`, `redis-cli -a <v>`, `mysql -p<v>` (already? keep), `sshpass -p <v>`.
2. `.netrc`: `machine h login u password <v>`.
3. XML elements: `<password>v</password>`, `<secret>`, `<token>`, `<apiKey>`, `<client_secret>` — inner text only.
4. `=>` assignment (`'password' => 'v'`, `:token => "v"`).
5. Literal default after `||`, `??`, `getenv("X", "v")`, `os.environ.get("X", "v")`, `process.env.X || "v"` when X is secret-named.
6. `redact-corpus.test.ts`: table (context × shape) — contexts: key=value, YAML, JSON, CLI flag, URL, header, XML, netrc, `=>`, default-after-`||`; shapes: AWS id, GitHub PAT, Vault `hvs.`, Discord, JWT, random 20-char mixed, `$`-containing password. Assert each through `redact()` and through the CLI `--summary` and `--export` paths (one session fixture built in the test). Plus an "unchanged" table of 15+ ordinary lines (prose with "password", docs with `<password>` placeholder text like `<password>YOUR_PASSWORD</password>`? → decide: placeholder-looking all-caps stays).

No existing expectation changes; if one breaks, stop and report it with the diff. `pnpm check` green incl. perf suite (redact perf tests must stay within their thresholds).

```gate
allow: ^packages/core/src/redact\.ts$
allow: ^packages/core/src/redact(-corpus)?\.test\.ts$
allow: ^packages/core/src/redact\.perf\.test\.ts$
allow: ^packages/cli/src/redact-shapes[a-z-]*\.test\.ts$
allow: ^(packages/cli/)?README\.md$
allow: ^context/(changes|archive)/redact-shapes-2/
deps: no
schema: no
```
