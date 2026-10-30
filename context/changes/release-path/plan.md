# Release path (S-25)

## Cause

`packages/cli/package.json` and `packages/cli/src/cli.ts:26` both hard-code 0.0.0, the root package is named `strata`, there are no tags, changelog or release workflow, and `npx lgtm-review` returns 404 from the registry. Publishing stays the owner's: nothing in this slice publishes or pushes.

## Phase 1

Files: `package.json`, `packages/cli/package.json`, `packages/cli/tsup.config.ts`, `packages/cli/src/cli.ts`, `scripts/smoke-pack.mjs`, `.github/workflows/release.yml` (new), `CHANGELOG.md` (new).

1. Root `package.json`: `name` becomes `lgtm-review-monorepo` (stays private). No lockfile change expected; if there is one, stop and report.
2. `packages/cli/package.json`: `version` 0.1.0; add `repository`, `homepage`, `bugs` for `github.com/jack2k0/lgtm-review` and a one-line `description`.
3. One version source: `tsup.config.ts` reads `package.json` and sets `define: { __LGTM_VERSION__: JSON.stringify(version) }`; `cli.ts` declares it and uses it for `VERSION`. No runtime file read.
4. `scripts/smoke-pack.mjs`: the packed CLI's `--version` output must equal `lgtm-review <version from packages/cli/package.json>`; fail otherwise.
5. `.github/workflows/release.yml`, on tags `v*` only, `permissions: contents: read, id-token: write`: same setup as `ci.yml` on Node 22; `pnpm install --frozen-lockfile`; `pnpm check`; fail unless the tag equals `v` + the CLI version; `npm publish --provenance --tag next` from `packages/cli` with `NODE_AUTH_TOKEN` from the secret `NPM_TOKEN`. It must not run on push to a branch or on pull requests.
6. `CHANGELOG.md`: Keep a Changelog form, a `0.1.0 - Unreleased` section summarising what the product does and the breaking `--list`/`--json` redaction default.

Done when `pnpm check` and the gate pass. Do not create tags. Do not run `npm publish`.

## Non-goals

Publishing, tags, the npm name decision, other CI jobs (S-26), README text (S-27).

## Gate
```gate
allow: ^package\.json$
allow: ^packages/cli/(package\.json|tsup\.config\.ts|src/cli\.ts)$
allow: ^scripts/smoke-pack\.mjs$
allow: ^\.github/workflows/release\.yml$
allow: ^CHANGELOG\.md$
allow: ^context/(changes|archive)/release-path/
deps: yes
schema: no
```
