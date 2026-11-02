# False `no-undef` warnings in scripts

Part of finding B2 of `docs/review-2026-11-02.md`: `eslint .` reports 63 `no-undef` warnings in `scripts/`, because that block declares no Node globals.

## Phase 1

In `eslint.config.mjs`, in the existing block for `scripts/**/*.{js,mjs}`, add `languageOptions.globals` listing, as `"readonly"`, exactly the names ESLint reports as undefined there. Find them by running `eslint scripts -f json`. No new dependency: do not add the `globals` package. Keep `"no-undef": "warn"`.

If a reported name is a real bug, not a Node global, do not list it: stop and report it.

Done when `corepack pnpm exec eslint .` reports 0 `no-undef` warnings and no new warning or error of any other rule. Do not touch any other warning or file.

```gate
allow: ^eslint\.config\.mjs$
allow: ^context/(changes|archive)/eslint-script-globals/
deps: no
schema: no
```
