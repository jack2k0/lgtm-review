# Demo refresh: SOURCE_DATE_EPOCH for a reproducible export date

## Cause

`docs/demo/index.html` is a static export of a synthetic session built by `pnpm demo` (`scripts/build-demo.mjs`). Rebuilding it every day produced a diff, because `packages/cli/src/export.ts` stamps the banner date with `exportedAt: new Date()` (`new Date().toISOString().slice(0, 10)`): the "Exported from a local Claude Code session log on …" line picked up the day of the build (2026-10-23 → 2026-10-30 between rebuilds), while everything else (statuses, hints, steps, diffs) stayed stable. A committed static export whose only rolling part is the build date is not reproducible.

## Rule

- `packages/cli/src/export.ts`: the banner date for `--export` comes from a new exported helper `exportDate(env)`: when the env var `SOURCE_DATE_EPOCH` holds a valid integer of seconds since the epoch (the reproducible-builds.org convention), that moment's date in UTC (`YYYY-MM-DD`) is used; otherwise today, as now. An invalid value is ignored (today). Nothing else in the export changes.
- `scripts/build-demo.mjs`: runs the real CLI with `SOURCE_DATE_EPOCH` set to the demo session start (`SESSION_START`, in seconds), so `docs/demo/index.html` shows the session date and rebuilding it never changes by day.
- Tests (packages/cli, in `export.test.ts`, next to the existing export tests): `SOURCE_DATE_EPOCH=0` → `1970-01-01`; an invalid value → today's date; unset → today. No existing expectations change.
- `packages/cli/README.md`: one line under the export options: Set `SOURCE_DATE_EPOCH` for a reproducible export date.

## Gate
```gate
allow: ^packages/cli/src/export\.ts$
allow: ^packages/cli/src/export\.test\.ts$
allow: ^scripts/build-demo\.mjs$
allow: ^packages/cli/README\.md$
allow: ^docs/demo/index\.html$
allow: ^context/(changes|archive)/demo-refresh/
deps: no
schema: no
```
