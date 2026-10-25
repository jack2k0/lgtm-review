# Worktree sessions (S-19, FR-018) Implementation Plan

## Overview

Claude Code keeps a session under the project dir named after its working directory (`~/.claude/projects/<cwd with / and . replaced by ->`). A session started in a linked git worktree therefore never shows up when `lgtm-review` runs in the main checkout, and the reviewer has to start the tool once per worktree. This slice asks git (read-only, once per run) for the repository's worktrees, reads every worktree's project dir and archive, labels each session with its worktree when sessions come from more than one worktree, and does per-session work (repo check scripts, import map, play, export redaction) in the session's own directory. The web list gets a Worktree column and filter; `--no-worktrees` keeps today's behaviour.

## Current State Analysis

- `packages/core/src/node/discover.ts`: `SessionFile { path, id, mtimeMs, archived? }`; `projectDirFor(cwd, projectsDir)`; `discoverSessions(dir)`; `discoverAllSessions(projectDir, archiveDir, warnings?)` merges live and archived sessions of ONE project dir (throws `ENOENT` only when both are missing). `packages/core/src/node/index.ts` re-exports them; `archive.ts` has `archiveDirFor(projectDir, archiveRoot)` and `archiveSessions`.
- `packages/cli/src/cli.ts`: `--dir` → `projectDir`/`archiveDir` (L232-234); `--archive` (L236-250, one project dir); list/json/summary discover with `discoverAllSessions` (L267) and analyse with one `loadRepoScripts(dir)` (L105, L290); `serve()` (L50) passes `{ dir, projectsDir, archiveDir }` to `startServer`.
- `packages/cli/src/export.ts` `runExport` (L103-185): one project dir, `loadRepoScripts(cmd.dir)`, redaction `repoDir: cmd.dir`.
- `packages/cli/src/server.ts` `ServerOptions` (L10-25); `packages/cli/src/api.ts` `createApi` (L96-): one `projectDir`; `loadRepoScripts(opts.dir)` in `detailFor`/`analysisFor` (L136, L172); `planImportMap(opts.dir, …)` in the map and play routes (L305, L350) and `realpathSync(opts.dir)`/`toRepoRelative(…, [opts.dir, root])` in play (L381-393); `summarize()` (L21-60).
- `packages/cli/src/format.ts` `formatText`: the session header line (`<id8>  <title>  [<branch>]  <start>[ (archived)]`).
- The import map already takes its directory as a parameter (`planImportMap(dir, …)` in `map.ts`) and runs `git ls-files` with fixed arguments: the precedent for read-only git.
- `packages/web/src/SessionList.tsx` (S-17): header line, "Filter sessions" nav (All / Needs attention), table Session · Branch · Started · Prompts · Statuses. `packages/web/src/viewmodel.ts`: list route `{ kind: "list"; show?: "attention" }`, `parseRoute` recognises exactly `#/?show=attention` (L144). `App.tsx` `ListView({ token, show })`. `PromptTable.tsx` session header (L156-160) shows branch and counts.
- Schema: `SessionAnalysis.worktree?` and `SessionSummary.worktree?` come from the orchestrator's wave-2 schema pre-commit (`context/changes/scoped-checks/plan.md`).
- Tests that run the CLI pass `--dir /home/user/project` (no such directory) or run inside the developer's checkout, which may have linked worktrees; their output must not change (see D4).

## Desired End State

- `lgtm-review` (UI), `--list`, `--json`, `--summary`, `--export` and `--archive` cover the sessions of `--dir` and of every other worktree that `git worktree list` reports for its repository. With `--no-worktrees`, without git, outside a repository, or with a single worktree, everything behaves exactly as today.
- When sessions come from more than one worktree, each carries `worktree` = its worktree's path relative to the main checkout (`.` for the main checkout, `../lgtm-review-zod`, `.claude/worktrees/fix-x`); `--list` text shows `[worktree ../lgtm-review-zod]` (nothing for `.`), JSON and the API carry the field, the web list shows a Worktree column ("main checkout" for `.`) and a worktree filter (`#/?worktree=..%2Flgtm-review-zod`, combinable with `show=attention`), and the session header says which worktree.
- Repo check scripts, the import map, play and the export's path redaction use the session's own worktree directory.

## What We're NOT Doing

- No sessions of worktrees that git no longer lists (removed or pruned), and no discovery of their archived copies; no scanning of `~/.claude/projects` by name.
- No new git command beyond `git -C <dir> worktree list --porcelain -z`; nothing is written to any repository.
- No change to the status rule, hints, summary/export formatting, goldens or the README (orchestrator pastes the README text, phase 5).
- Roots are fixed at start-up: a worktree added while the server runs appears after a restart.
- No `schema.ts` edit in this branch.

## Ownership and guard (S-18 runs in parallel)

S-19 owns, and only S-19 edits in wave 2:
- `packages/core/src/node/discover.ts`, `packages/core/src/node/index.ts`, new `packages/core/src/node/worktrees.ts`, new `packages/core/src/node/worktrees.test.ts`;
- `packages/cli/src/{cli.ts,export.ts,format.ts,format.test.ts,server.ts,api.ts}`, new `packages/cli/src/worktrees.e2e.test.ts`, new `packages/cli/src/api.worktrees.test.ts`;
- `packages/web/src/{viewmodel.ts,viewmodel.test.ts,SessionList.tsx,SessionList.test.tsx,PromptTable.tsx,App.tsx}`, new `packages/web/src/worktree.ts`, new `packages/web/src/worktree.test.tsx`.

S-19 must NOT touch: `packages/core/src/schema.ts`, `packages/core/src/index.ts`, any other file directly under `packages/core/src/` (S-18 owns `check-patterns`, `parse`, `analyze`, `hints`, `scope`), anything under `packages/core/fixtures/` (**no golden file may change or be added by S-19**), `scripts/audit-status.mjs`, `packages/cli/src/audit-status.test.ts`, `packages/cli/README.md`, `package.json`/`pnpm-lock.yaml`, `context/foundation/**`.

Check before every phase commit (prints nothing):

```
git diff --name-only "$(git merge-base main HEAD)" HEAD -- . ':!context/changes/worktree-sessions' \
  | grep -vE '^packages/core/src/node/(worktrees(\.test)?|discover|index)\.ts$|^packages/cli/src/(cli|export|format|format\.test|server|api|worktrees\.e2e\.test|api\.worktrees\.test)\.ts$|^packages/web/src/(viewmodel|viewmodel\.test|worktree)\.ts$|^packages/web/src/(worktree\.test|SessionList|SessionList\.test|PromptTable|App)\.tsx$'
```

## Design decisions (binding)

D1. **Listing worktrees**, new `packages/core/src/node/worktrees.ts`:

```ts
export interface Worktree {
  /** Absolute path as git reports it. */
  path: string;
  /** Branch name without `refs/heads/`, or null (detached HEAD). */
  branch: string | null;
}

/**
 * Parses `git worktree list --porcelain -z`: NUL-terminated lines, records separated by an empty line,
 * each starting with `worktree <path>`. The first record is the main worktree; its path is returned as
 * `main` even when it is `bare`. Records marked `bare` or `prunable` are left out of `worktrees`.
 */
export function parseWorktreeList(stdout: string): { main: string | null; worktrees: Worktree[] };

/** `git -C <dir> worktree list --porcelain -z` via execFile (fixed arguments, no shell, timeout 5 s, maxBuffer 1 MB, windowsHide); null on any failure (git missing, not a repository, `dir` missing). */
export function listWorktrees(dir: string): Promise<{ main: string | null; worktrees: Worktree[] } | null>;
```

D2. **Session roots** (`discover.ts` holds the type, `worktrees.ts` builds it):

```ts
export interface SessionRoot {
  /** Directory whose Claude Code project dir is read: `--dir` itself, or another worktree's root. */
  dir: string;
  /** Path of the root's worktree relative to the main checkout, "/"-separated; "." for the main checkout. */
  worktree: string;
  projectDir: string;
  /** Archive dir of this root's project dir; null when no archive root is used. */
  archiveDir: string | null;
}

/** `--dir` first, then every other listed worktree in git's order. Only `--dir` (worktree ".") when `opts.worktrees` is false, git fails or one worktree is listed. `list` is injectable for tests. */
export async function sessionRoots(dir: string, projectsDir: string, archiveRoot: string | null, opts: { worktrees: boolean }, list?: typeof listWorktrees): Promise<SessionRoot[]>;
```

  The worktree containing `--dir` is the listed one with the longest path equal to `realpath(dir)` or a prefix of it followed by `/` (fallback: `dir` itself); its label is the first root's `worktree`. Labels: `relative(main, path)` with `/` separators, `""` → `"."`. Every root: `projectDir = projectDirFor(root.dir, projectsDir)`, `archiveDir = archiveRoot === null ? null : archiveDirFor(projectDir, archiveRoot)`.

D3. **Discovery** (`discover.ts`): `SessionFile` gains `/** Directory of the root the session was found under. */ root?: string;` and `/** Worktree label; set only when sessions came from more than one root. */ worktree?: string;`.

```ts
/** Sessions of every root: live and archived (`discoverAllSessions` per root), tagged with `root`; an id seen in an earlier root wins; newest first like `discoverSessions`. */
export async function discoverRootSessions(roots: readonly SessionRoot[], warnings?: string[]): Promise<SessionFile[]>;
```

  Per root: `discoverAllSessions(root.projectDir, root.archiveDir, warnings)`; `ENOENT` → that root contributes nothing; any other error → rethrown for the first root, a warning `"<projectDir>: unreadable (<message>)"` for later roots. **Stability rule:** `worktree` is set on the files only when at least two roots contributed at least one session; otherwise output is identical to today whatever git lists (a developer checkout with worktrees, CI with one).

D4. **CLI** (`cli.ts`, `export.ts`, `format.ts`):
  - New boolean flag `--no-worktrees`; help line `  --no-worktrees         only the sessions of --dir, not of the repository's other git worktrees`; the usage line gains `[--no-worktrees]`. It combines with every mode.
  - `roots = await sessionRoots(dir, projectsDir, archiveRoot, { worktrees: values["no-worktrees"] !== true })`, computed once after the flag checks.
  - `--archive`: the first root exactly as today (error → exit 1); every later root whose project dir exists is archived too (missing → skipped silently); one output line per archived root, prefixed `[worktree <label>] ` when more than one root was archived.
  - list/json/summary: `discoverRootSessions(roots, discoveryWarnings)` instead of `discoverAllSessions`; `loadRepoScripts(f.root ?? dir)` cached per root; `if (f.worktree !== undefined) a.worktree = f.worktree` next to the existing `archived` copy.
  - `serve()` passes `roots` (and keeps `dir`, `projectsDir`, `archiveDir: roots[0].archiveDir ?? undefined`).
  - `export.ts`: `ExportCommand.roots?: SessionRoot[]` (default: the single root built from `dir`/`projectsDir`/`archiveDir`); discovery through `discoverRootSessions`; `loadRepoScripts(f.root ?? cmd.dir)` per file; worktree copied like `archived`; redaction `repoDir: file.root ?? cmd.dir`.
  - `format.ts`: the header line appends ` [worktree <label>]` after ` (archived)` when `s.worktree` is set and not `"."`.

D5. **Server/API** (`server.ts`, `api.ts`):
  - `ServerOptions.roots?: SessionRoot[]` ("from `sessionRoots`; default: `dir` alone"). `createApi`: `roots = opts.roots ?? [{ dir: opts.dir, worktree: ".", projectDir: projectDirFor(opts.dir, opts.projectsDir), archiveDir: opts.archiveDir ?? null }]`; `discover()` uses `discoverRootSessions(roots)`.
  - Per session file: `loadRepoScripts(f.root ?? opts.dir)` in `analysisFor`/`detailFor`, worktree copied onto the analysis; map and play use `const rootDir = file.root ?? opts.dir` for `planImportMap`, `realpathSync` and `toRepoRelative`.
  - `summarize()` copies `worktree` when set (`...(s.worktree !== undefined ? { worktree: s.worktree } : {})`). `/api/sessions` keeps `dir: opts.dir`. ETags already cover every discovered file.
  - Paths still never come from a request: ids are matched against the discovered list only.

D6. **Web**:
  - Routes (`viewmodel.ts`): list route `{ kind: "list"; show?: "attention"; worktree?: string }`. `parseRoute`: a hash starting with `#/?` is parsed as `&`-separated `key=value` pairs; allowed: `show=attention` and `worktree=<percent-encoded, non-empty after decoding>`, each at most once; anything else → `{ kind: "list" }`. `routeHref` writes `show` then `worktree` (`encodeURIComponent`); without parameters `#/`. Session routes are unchanged.
  - New `worktree.ts`:

```ts
import type { SessionSummary } from "@lgtm/core";
/** Distinct labels of the sessions ("." first, then sorted); sessions without a label count as ".". */
export function worktreeLabels(sessions: readonly Pick<SessionSummary, "worktree">[]): string[];
/** The Worktree column and filter appear only when the sessions come from at least two worktrees. */
export function hasWorktrees(sessions: readonly Pick<SessionSummary, "worktree">[]): boolean;
/** "main checkout" for ".", the relative path otherwise. */
export function worktreeName(label: string): string;
```

  - `SessionList({ data, show = "all", worktree })`: when `hasWorktrees(data.sessions)`: a Worktree column after Branch (`<td className="mono">{worktreeName(s.worktree ?? ".")}</td>`), and a second nav `aria-label="Filter by worktree"` with **All worktrees** and one link per label (hrefs keep `show`; `aria-current="page"` on the active one). Rows are filtered by worktree first, then by attention; counts in the header line and the attention links are computed on the worktree-filtered set; the S-17 links keep `worktree`; `Showing x of n sessions.` appears when any filter is active. When `hasWorktrees` is false the markup is exactly the S-17 markup (no column, no second nav, `worktree` ignored).
  - `PromptTable` header: after the branch, ` · main checkout` when `session.worktree === "."`, ` · worktree <label>` for any other label, nothing when unset.
  - `App.tsx`: `ListView` passes `route.worktree` through.

## Working rules for implementers

- Branch `change/worktree-sessions` in `../lgtm-review-worktree-sessions`, created by the orchestrator from the schema pre-commit. One commit per phase, `feat(worktree-sessions): phase N — <summary>`; tick Progress in the same commit.
- Node 22, pnpm 11; without `pnpm` on the PATH put `$HOME/.local/opt/node22/bin` first and use `corepack pnpm`. Web and CLI tests use the built core: run `pnpm build` after core changes.
- Tests build their own git repositories in temp dirs (`realpathSync(mkdtempSync(...))`, `git -c user.name=t -c user.email=t@t`, as `api.map.test.ts` does); never read `~/.claude`; synthetic sessions only (copy fixtures and prefix their uuids as `e2e.test.ts` does).
- Every git call: `execFile` with a fixed argument array, never a shell string.
- Run the guard check before every commit; no golden may change.

## Phase 1: Worktree listing, roots and discovery (core node)

Suggested worker: Sonnet or OpenCode. **Files**: new `packages/core/src/node/worktrees.ts`, new `packages/core/src/node/worktrees.test.ts`, `packages/core/src/node/discover.ts`, `packages/core/src/node/index.ts` (export `listWorktrees`, `parseWorktreeList`, `sessionRoots`, `discoverRootSessions`, types `Worktree`, `SessionRoot`).

Tests (`worktrees.test.ts`):
- `parseWorktreeList` on hand-written `-z` output: main + two linked worktrees (one detached) → three entries, branches without `refs/heads/`; a `bare` main record → excluded from `worktrees`, `main` still its path; a `prunable` record → excluded; empty string → `{ main: null, worktrees: [] }`; trailing NULs tolerated.
- `sessionRoots` with an injected `list`: `--dir` = main → roots `[main ".", wt "../wt"]`; `--dir` = the linked worktree → first root is the worktree (label `../wt`), then main (`.`); `--dir` inside a subfolder of main → first root is that subfolder with label `.`, main itself not repeated; `worktrees: false`, `list` → null, or one worktree → a single root with label `.`; nested `.claude/worktrees/x` → label `.claude/worktrees/x`; `archiveRoot` null → `archiveDir` null.
- `listWorktrees` integration (real git in a temp dir): `git init`, commit, `git worktree add ../wt -b feature` → main and `wt` listed with branch `feature`; a non-repository dir and a missing dir → null.
- `discoverRootSessions` with temp project dirs: sessions of two roots merged newest first, each with `root`; `worktree` labels present only when both roots contributed; a duplicate id in the second root is dropped; a missing project dir of the second root is skipped; both missing → `[]`; archived-only sessions of a second root are included with `archived: true`.

### Success Criteria

- `pnpm --filter @lgtm/core test` passes; no golden change; guard prints nothing; `pnpm check` green.

## Phase 2: CLI commands (list, json, summary, export, archive)

Suggested worker: Sonnet. Depends on phase 1. **Files**: `packages/cli/src/cli.ts`, `export.ts`, `format.ts`, `format.test.ts`, new `worktrees.e2e.test.ts`.

D4. Tests:
- `format.test.ts`: header shows `[worktree ../wt]` for a session with that label, nothing for `.` or unset.
- `worktrees.e2e.test.ts` (built CLI, temp git repo `repo` with a commit and `git worktree add ../wt -b feature`, temp projects dir with `projectDirFor(repo)` holding a copy of `checked-basic.jsonl` and `projectDirFor(wt)` holding a copy of `failing-check.jsonl`, uuids prefixed per file):
  - `--list --json --dir <repo>` → two sessions with `worktree` `.` and `../wt`; the same from `--dir <wt>`;
  - `--no-worktrees` → one session, no `worktree` key anywhere in the JSON;
  - `--list` text contains `[worktree ../wt]` once;
  - `--summary --session <wt session id prefix>` exits 0; `--export <wt prefix> --out <tmp>/x.html` exits 0 and the file contains `&lt;repo&gt;` instead of the worktree path;
  - `--archive --archive-dir <tmp>/arch` exits 0, prints two lines, and both archive dirs exist;
  - `--list --json --dir <non-repo temp dir>` behaves as before (its own sessions only, no `worktree`).
- Every existing CLI test passes unchanged.

### Success Criteria

- `pnpm build`, then `pnpm --filter lgtm-review test` passes; no golden change; guard prints nothing; `pnpm check` green.

## Phase 3: Server and API

Suggested worker: Sonnet. Depends on phase 1 (phase 2 independent). **Files**: `packages/cli/src/server.ts`, `api.ts`, new `api.worktrees.test.ts`.

D5. Tests (`api.worktrees.test.ts`, same temp layout as phase 2; the worktree session edits `src/only-in-wt.ts`, a file committed only on the `feature` branch inside `wt`):
- `GET /api/sessions` lists both sessions with `worktree`; `GET /api/sessions/<wt id>` has `worktree: "../wt"`;
- `GET /api/sessions/<wt id>/map` → 200 and a node `src/only-in-wt.ts` (the worktree's own tree was scanned);
- appending to the worktree session file changes the list ETag; an unchanged list answers 304;
- a server started without `roots` behaves as before (existing `api*.test.ts` unchanged and green).

### Success Criteria

- `pnpm build`, then `pnpm --filter lgtm-review test` passes; guard prints nothing; `pnpm check` green.

## Phase 4: Web list, filter and session header

Suggested worker: Haiku or OpenCode. Depends on the schema pre-commit only (the UI reads the optional field). **Files**: `packages/web/src/viewmodel.ts`, `viewmodel.test.ts`, new `worktree.ts`, new `worktree.test.tsx`, `SessionList.tsx`, `SessionList.test.tsx` (only if an existing case needs a new prop; prefer adding cases to `worktree.test.tsx`), `PromptTable.tsx`, `App.tsx`.

D6. Tests:
- Routes: `#/?worktree=..%2Fwt` → `{ kind: "list", worktree: "../wt" }`; `#/?show=attention&worktree=.` → both; `#/?worktree=.&show=attention` → both; `routeHref` writes `show` first and round-trips; `#/?worktree=` (empty), duplicate keys, unknown keys, bad percent-encoding → `{ kind: "list" }`; every existing routing test unchanged.
- `worktree.ts`: labels ordering, `hasWorktrees` false for one label or none, `worktreeName(".")` = `main checkout`.
- `SessionList` (SSR): one worktree → markup identical to the S-17 case (assert no `Worktree` header and no "Filter by worktree"); two worktrees → column with `main checkout` and `../wt`, worktree links `#/?worktree=.` and `#/?worktree=..%2Fwt`; `worktree="../wt"` shows only that session and `Showing 1 of 2 sessions.`; with `show="attention"` the worktree links keep `show=attention` and the attention links keep `worktree`.
- `PromptTable` (SSR): header contains `· worktree ../wt` for that label, `· main checkout` for `.`, neither when unset.

### Success Criteria

- `pnpm --filter @lgtm/web typecheck` and `pnpm --filter @lgtm/web test` pass; existing web tests unchanged; guard prints nothing; `pnpm check` green.

## Phase 5: README, synthetic check, docs (orchestrator only)

1. Paste into `packages/cli/README.md` on main after the merge:
   - usage line and option list: `--no-worktrees` ("only the sessions of --dir, not of the repository's other git worktrees");
   - new section after "Resumed and forked sessions":

     `## Worktrees` — "Claude Code stores each session under the directory it was started in, so sessions of a linked git worktree (\`git worktree add\`, or \`claude --worktree\`, which creates worktrees under \`.claude/worktrees/\`) belong to that worktree. lgtm-review asks git once per run for the repository's worktrees (\`git worktree list\`, read-only) and shows the sessions of all of them: the terminal list marks them \`[worktree ../name]\`, \`--json\` and the API carry \`worktree\` (the path relative to the main checkout, \`.\` for the main checkout), and the web list gets a Worktree column and filter. Steps, diffs, the import map and play of a worktree session use that worktree's directory; \`--export\` redacts its path as \`<repo>\`. \`--archive\` mirrors every worktree's sessions. Worktrees that git no longer lists, and their archived sessions, are not shown; a worktree added while the UI runs appears after a restart. Use \`--no-worktrees\` for the sessions of \`--dir\` only."
2. Synthetic check in a browser (owner, or orchestrator with a browser tool): the phase-2 layout served with `--projects-dir`; Worktree column, filters combined with Needs attention, session header, map of the worktree session. Record the result or "not viewed" in `context/changes/worktree-sessions/reviews/check.md`.
3. Roadmap S-19 → done, PRD FR-018 unchanged unless something differs, archive.

## Progress

### Phase 1: Core node

- [x] 1.1 `worktrees.ts`, `SessionRoot`, `discoverRootSessions` + tests; `pnpm check` green

### Phase 2: CLI commands

- [x] 2.1 `--no-worktrees`, roots in list/json/summary/export/archive, `[worktree …]` in the list; e2e green; `pnpm check` green

### Phase 3: Server and API

- [x] 3.1 roots in `createApi`, per-session root for scripts/map/play, `worktree` in summaries; tests green; `pnpm check` green

### Phase 4: Web

- [x] 4.1 routes, `worktree.ts`, list column and filter, session header; tests green; `pnpm check` green

### Phase 5: Orchestrator

- [x] 5.1 README text, synthetic check recorded
- [x] 5.2 roadmap, PRD, archive
