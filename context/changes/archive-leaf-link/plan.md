# archive-leaf-link (S-40)

Roadmap S-40, F12 (repro first). FR-008 archive: `--archive` never follows a symlink and never writes outside the archive directory.

## Phase 1 (only phase)

1. Repro first, in `packages/core/src/node/archive.test.ts`: archive root exists; the per-project directory inside it (`<archive>/<project-dir-name>`) is a symlink to a directory outside the archive. Run the archive. Expected: nothing is written or chmod-ed through the link (the outside directory keeps its files and mode), the existing "is a symlink, skipped" warning is reported, exit code as for the other skip cases. Also the case where the archive root itself is a symlink: keep the current behaviour and only document it in the report.
2. If the test fails on `main`: fix `ensureDestDir` / the code before it in `packages/core/src/node/archive.ts` so every path component, the leaf included, is `lstat`-ed before any `mkdir`/`chmod`/write, and skipped with the existing warning when it is a symlink or not a directory. Also check `chmod(archiveDir)` and the per-file writes (`open` with `O_NOFOLLOW` where the code already uses it).
3. If the test passes on `main` (no bug), keep the test, change no product code, and say so in the report.

Done: `pnpm check` green; gate exit 0 or 2.

```gate
allow: ^packages/core/src/node/archive(\.test)?\.ts$
allow: ^context/(changes|archive)/archive-leaf-link/
deps: no
schema: no
```
