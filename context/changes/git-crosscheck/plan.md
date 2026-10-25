# Git cross-check (S-21, FR-019) Implementation Plan

## Overview

The file list of a session comes from the log only ("agent edits, not final git state"). Formatters, generators, shell edits the log missed, or the user's own changes never appear there, and an edit the agent later reverted still does. This slice adds a **Git cross-check** per session: one API route and one web view that put what git shows for the session's directory next to what the session's own prompts edited:

- **Not in the log**: files git reports (uncommitted changes, and files changed by non-merge commits of the session's branch inside the session's time window) that no prompt of the session edited;
- **Not in git**: files the session edited that git shows neither as uncommitted nor in those commits (reverted, deleted again, already committed earlier);
- files outside the repository are only counted.

It is a snapshot computed on request (open the view or press Refresh), read-only, and never changes statuses, reasons, hints or anything else.

## Current State Analysis

- `packages/cli/src/api.ts` `createApi`: the route regex at L424 (`/api/sessions`, `/:id`, `/:id/prompts/:index[/diff|/play]`, `/:id/map`); per-session directory `file.root ?? opts.dir` (S-19, L308, L353, L382); `versionOf`, `allAnalyses`, `reply`, `etagFor` helpers; ids are only matched against the discovered list.
- `packages/core/src/node/worktrees.ts` runs `git` with `execFile` and a fixed argument list (S-19) — the pattern to follow. `packages/cli/src/map.ts` does the same for `git ls-files`.
- Session facts available in the API: `SessionAnalysis.startedAt` (first record), `SessionAnalysis.branch` (`"unknown"` when the log has none), `SessionFile.mtimeMs` (last write of the log; kept by the archive), `PromptAnalysis.files[].path` and `inheritedFrom`.
- `packages/web/src/viewmodel.ts`: `Route` union (L124-130), `parseRoute` (session regex with actions `map|diff|play`), `routeHref`; `packages/web/src/App.tsx`: local `Status` loader component, `SessionView` header links "← All sessions · Map" (L31-35), exhaustive `Routed` switch; `packages/web/src/api.ts`: `getConditional` + one `fetchX` per route, schemas from `@lgtm/core`.
- zod is 4.6.6; `schema.ts` keeps the `z.number().int().nonnegative()` style.

## Desired End State

- `GET /api/sessions/<id>/git` (token, Host and Origin checks as for every route) returns a `GitCrosscheckResponse` (Schema pre-commit) computed by `gitCrosscheck` (D2) in the session's directory; 404 for unknown sessions.
- The web route `#/session/<id>/git`, linked as **Git cross-check** next to **Map** in the session view, shows the window, the ref, both lists, the outside count and notes, with a **Refresh** button; no polling.
- Nothing else changes: no status, reason, hint, summary, export or CLI output.

## What We're NOT Doing

- No CLI flag or terminal output for the cross-check; no use of it in `--summary`/`--export`.
- No `git diff` content, no line counts, no blame; no merge commits (`--no-merges`), no other branches, no remote refs.
- No caching between requests and no live polling of this view (git runs only on open/Refresh).
- No writes of any kind to a repository.
- No golden files (S-20 owns the wave's goldens); no `schema.ts`/`index.ts` edits in this branch.

## Ownership and guard (S-20 runs in parallel)

S-21 owns, and only S-21 edits in wave 3: new `packages/core/src/node/git.ts`, new `packages/core/src/node/git.test.ts`, `packages/core/src/node/index.ts` (one export line), `packages/cli/src/api.ts`, new `packages/cli/src/api.git.test.ts`, `packages/web/src/{api.ts,viewmodel.ts,viewmodel.test.ts}`, `packages/web/src/App.tsx`, new `packages/web/src/GitView.tsx`, new `packages/web/src/git.test.tsx`.

S-21 must NOT touch: `packages/core/src/schema.ts`, `packages/core/src/index.ts` (both via the pre-commit only), any other file in `packages/core/src/` (S-20 owns `analyze`, `hints`, `map-extract-py`), anything under `packages/core/fixtures/` (**no golden file may change or be added**), `scripts/**`, `packages/cli/README.md`, other `packages/cli/src` files, other `packages/web/src` files, `package.json`/`pnpm-lock.yaml`, `context/foundation/**`.

Check before every phase commit (prints nothing):

```
git diff --name-only "$(git merge-base main HEAD)" HEAD -- . ':!context/changes/git-crosscheck' \
  | grep -vE '^packages/core/src/node/(git(\.test)?|index)\.ts$|^packages/cli/src/(api|api\.git\.test)\.ts$|^packages/web/src/(api|viewmodel|viewmodel\.test)\.ts$|^packages/web/src/(App|GitView|git\.test)\.tsx$'
```

## Schema pre-commit (orchestrator, before S-20 and S-21 start)

S-20 needs no schema change; S-21 needs one response type. The orchestrator lands it on main in one commit (`chore(schema): wave-3 schema additions (S-21)`), runs `pnpm check`, and creates both branches from that commit.

1. Append to `packages/core/src/schema.ts` (after `PlayResponse`):

```ts
/** One file git reports for a session's directory (`GET /api/sessions/:id/git`). */
export const GitFileEntry = z.object({
  /** Path relative to the repository's top level, "/"-separated. */
  path: z.string(),
  /** Porcelain status of the uncommitted change (`M`, `A`, `D`, `R`, `??`, …) or the name-status letter of the newest commit that touched it. */
  status: z.string(),
  /** True when a prompt of the session (not an inherited one) edited this file. */
  inLog: z.boolean(),
});
export type GitFileEntry = z.infer<typeof GitFileEntry>;

/** Body of `GET /api/sessions/:id/git`: what git shows next to what the session edited. Read-only; never changes statuses. */
export const GitCrosscheckResponse = z.object({
  sessionId: z.string(),
  /** False when the directory is not in a git repository or git is unavailable; the lists are then empty. */
  available: z.boolean(),
  /** Branch whose commits were read, `HEAD` as a fallback, or null when commits were not read. */
  ref: z.string().nullable(),
  /** Commit window (ISO): session start - 10 min to the log's last write + 10 min; null when the start is unknown. */
  since: z.string().nullable(),
  until: z.string().nullable(),
  /** Non-merge commits read in the window (at most 500). */
  commitCount: z.number().int().nonnegative(),
  /** Uncommitted changes, sorted by path. */
  uncommitted: z.array(GitFileEntry),
  /** Files changed by the window's commits, sorted by path. */
  committed: z.array(GitFileEntry),
  /** Repository-relative files the session edited that git shows neither as uncommitted nor in the window's commits, sorted. */
  notInGit: z.array(z.string()),
  /** Edited files outside the repository (scratch files, other repositories); not compared. */
  outsideRepo: z.number().int().nonnegative(),
  /** A list was cut at 2000 entries or the commit scan stopped at 500 commits. */
  truncated: z.boolean(),
  notes: z.array(z.string()),
});
export type GitCrosscheckResponse = z.infer<typeof GitCrosscheckResponse>;
```

2. In `packages/core/src/index.ts`, add `GitFileEntry,` and `GitCrosscheckResponse,` to the `export { … } from "./schema.js";` list, right after `PlayResponse,`.

Nothing produces these values until S-21 lands, so `pnpm check` stays green and no golden changes.

## Design decisions (binding)

D1. **Git runner and parsers**, new `packages/core/src/node/git.ts`:

```ts
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import type { GitCrosscheckResponse, GitFileEntry } from "../schema.js";

export type RunGit = (dir: string, args: readonly string[]) => Promise<string | null>;

/** `git -C <dir> <args>` via execFile (fixed arguments, no shell, timeout 10 s, maxBuffer 32 MB, windowsHide, utf8); stdout, or null on any failure. */
export const runGit: RunGit = (dir, args) =>
  new Promise((resolve) => {
    try {
      execFile("git", ["-C", dir, ...args], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout) =>
        resolve(err ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });

/** `git status --porcelain=v1 -z`: entries `XY path`; for renames and copies (`R`/`C` in X or Y) the next NUL field is the source path and is skipped. Status = XY with spaces removed (`M`, `MM`, `A`, `D`, `R`, `??`). */
export function parseStatusZ(out: string): { path: string; status: string }[];

/** `git log --name-status --format=%x01%H`: a line starting with \x01 starts a commit; other non-empty lines are `<status>\t<path>` or `<R|C><score>\t<old>\t<new>` (the last field is the path, the first letter the status). The first occurrence of a path (newest commit) wins. */
export function parseLogNameStatus(out: string): { commits: number; files: { path: string; status: string }[] };
```

D2. **`gitCrosscheck`** (same file):

```ts
export interface GitCrosscheckInput {
  /** The session's directory (its worktree root, `file.root ?? --dir`). */
  dir: string;
  /** `SessionAnalysis.branch` ("unknown" or "" when the log has none). */
  branch: string;
  /** `SessionAnalysis.startedAt`. */
  startedAt: string | null;
  /** Last write of the session log (`SessionFile.mtimeMs`). */
  endedAtMs: number;
  /** Paths edited by the session's own (non-inherited) prompts, as in `PromptAnalysis.files[].path`. */
  sessionFiles: readonly string[];
}
export const GIT_FILES_MAX = 2000;
export const GIT_COMMITS_MAX = 500;
export const GIT_WINDOW_MARGIN_MS = 10 * 60 * 1000;
export async function gitCrosscheck(input: GitCrosscheckInput, run: RunGit = runGit): Promise<Omit<GitCrosscheckResponse, "sessionId">>;
```

  Steps, in order:
  1. `top = run(dir, ["rev-parse", "--show-toplevel"])`, trimmed. `null` → return `{ available: false, ref: null, since: null, until: null, commitCount: 0, uncommitted: [], committed: [], notInGit: [], outsideRepo: 0, truncated: false, notes: ["Not a git repository, or git is not available."] }`.
  2. `status = run(dir, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"])` → `parseStatusZ` (`null` → empty list and the note `git status failed.`).
  3. Window: when `startedAt` parses, `since = new Date(Date.parse(startedAt) - GIT_WINDOW_MARGIN_MS).toISOString()` and `until = new Date(endedAtMs + GIT_WINDOW_MARGIN_MS).toISOString()`; otherwise `since`/`until`/`ref` are null, `committed` is empty, `commitCount` 0, note `The session start is unknown, so commits were not read.`, and step 4 is skipped.
  4. Ref: when `branch` is non-empty, not `unknown` and not `HEAD`, and both `run(dir, ["check-ref-format", "--branch", branch])` and `run(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])` succeed → `ref = branch`, `refArg = "refs/heads/" + branch`; otherwise `ref = "HEAD"`, `refArg = "HEAD"`, note `Branch "<branch, at most 60 chars>" was not found; commits of HEAD were read.` (or `The log names no branch; commits of HEAD were read.` when there is none). Then `log = run(dir, ["-c", "core.quotePath=false", "log", "--no-merges", "--name-status", "--format=%x01%H", `--max-count=${GIT_COMMITS_MAX}`, `--since=${since}`, `--until=${until}`, "--end-of-options", refArg, "--"])` → `parseLogNameStatus` (`null` → empty and the note `git log failed.`). `commits === GIT_COMMITS_MAX` → `truncated`.
  5. Session paths: roots = `[top]` plus `realpathSync(top)` when different (wrapped in try). For each session path: skip non-absolute ones (e.g. `(shell edit)`); the first root `r` with `path.startsWith(r + "/")` gives the repo-relative path; no root matches → `outsideRepo++`. Use a `Set` of relative paths.
  6. Entries: `uncommitted` and `committed` map to `{ path, status, inLog: sessionSet.has(path) }`, sorted by path, cut at `GIT_FILES_MAX` (→ `truncated`). `notInGit` = sorted session paths found in neither list (cut at `GIT_FILES_MAX`).
  7. Return `{ available: true, ref, since, until, commitCount, uncommitted, committed, notInGit, outsideRepo, truncated, notes }`.

  The branch name comes from the log, so it is untrusted: it is only ever passed as one argv element after `check-ref-format` validated it, and the log call puts it after `--end-of-options`.

D3. **API route** (`api.ts`): extend the route regex to `/^\/api\/sessions(?:\/([^/]+)(?:\/prompts\/([^/]+)(\/diff|\/play)?|(\/map)|(\/git))?)?$/` and, right after the map dispatch, `if (match[5] !== undefined) return await gitRoute(req, res, file, files);` with:

```ts
async function gitRoute(req: IncomingMessage, res: ServerResponse, file: SessionFile | undefined, files: SessionFile[]): Promise<boolean> {
  if (!file || (await versionOf(file)) === null) return false;
  const analysis = (await allAnalyses(files)).find((x) => x.sessionId === file.id);
  if (!analysis) return false;
  const sessionFiles = [...new Set(analysis.prompts.filter((p) => p.inheritedFrom === undefined).flatMap((p) => p.files.map((f) => f.path)))];
  const result = await gitCrosscheck({ dir: file.root ?? opts.dir, branch: analysis.branch, startedAt: analysis.startedAt, endedAtMs: file.mtimeMs, sessionFiles });
  const body: GitCrosscheckResponse = { sessionId: file.id, ...result };
  reply(req, res, etagFor(`git\0${file.id}\0${JSON.stringify(body)}`), body);
  return true;
}
```

  No early 304 (the body is always computed); `reply` still answers 304 when the client's tag matches. `gitCrosscheck` comes from `@lgtm/core/node` (export added in phase 1).

D4. **Web**:
  - `api.ts`: `export const fetchGitCrosscheck = (token: string | null, id: string, etag: string | null, signal?: AbortSignal): Promise<Conditional<GitCrosscheckResponse>> => getConditional(`api/sessions/${encodeURIComponent(id)}/git`, token, GitCrosscheckResponse, etag, signal);`
  - `viewmodel.ts`: `Route` gains `| { kind: "git"; id: string }`; in `parseRoute` the action group becomes `(map|diff|play|git)` and, in the `index === undefined` branch, `if (action === "git" && query === undefined) return { kind: "git", id };` (a `git` action with a prompt index or a query → list); `routeHref`: `case "git": return `#/session/${encodeURIComponent(r.id)}/git`;`.
  - `App.tsx`: `SessionView` header becomes `← All sessions · Map · Git cross-check` (`routeHref({ kind: "git", id })`); `Routed` gets `case "git": return <GitRoute token={token} id={route.id} />;`; `GitRoute` (in App.tsx, using the local `Status` component) loads once on mount and on Refresh:

```tsx
function GitRoute({ token, id }: { token: string | null; id: string }) {
  const [tick, setTick] = useState(0);
  const [res, setRes] = useState<Load<GitCrosscheckResponse>>({ state: "loading" });
  useEffect(() => {
    const ac = new AbortController();
    setRes({ state: "loading" });
    fetchGitCrosscheck(token, id, null, ac.signal).then(
      (r) => { if (r.kind === "ok") setRes({ state: "ok", data: r.data }); },
      (e) => { if (!ac.signal.aborted) setRes({ state: "error", message: errorMessage(e) }); },
    );
    return () => ac.abort();
  }, [token, id, tick]);
  return <Status res={res} back={routeHref({ kind: "session", id })} backLabel="← Back to session">{(d) => <GitView data={d} onRefresh={() => setTick((t) => t + 1)} />}</Status>;
}
```

  - New `GitView.tsx`: `export function GitView({ data, onRefresh }: { data: GitCrosscheckResponse; onRefresh?: () => void })`, all log/git text as React text nodes:
    - first `<p><a href={routeHref({ kind: "session", id: data.sessionId })}>← Back to session</a></p>` (the `Status` wrapper shows its back link only while loading or on error),
    - `<h2>Git cross-check</h2>`, a `<button type="button" className="more" onClick={onRefresh}>Refresh</button>`, and the lead line `What git shows for this session's directory, next to the files its prompts edited. A snapshot: Refresh runs git again.`
    - `available === false`: only the notes as `<p className="empty">` lines.
    - Otherwise a meta line: `Commits of <ref> between <since> and <until> (<n> commits, merges excluded).` (local `formatStarted` times) or `Commits were not read.` when `ref` is null.
    - Section `Changed in git but not in the log (<k>)`: a table Path · Where · Status over `uncommitted` (Where `uncommitted`) and `committed` (Where `committed in the window`) entries with `inLog === false`; when `k` is 0: `<p className="muted">Nothing: every file git shows was edited by this session.</p>`.
    - Section `Edited in the log but not changed in git (<m>)`: a list of `notInGit`; when empty: `<p className="muted">Nothing.</p>`.
    - A line `<j> files appear in both.` (entries with `inLog`, a path counted once).
    - When `outsideRepo > 0`: `<p className="muted"><n> edited files outside the repository were not compared.</p>`; when `truncated`: `<p className="muted">Lists were cut at 2000 files or 500 commits.</p>`; every note as a `<p className="muted">`.
    - Footer `<p className="muted">`: `Not in the log can be your own change, a formatter or generator, or a shell edit the log does not show. Commits are matched by committer date; rebased or amended commits can fall outside the window. This view never changes a status.`

## Working rules for implementers

- Branch `change/git-crosscheck` in `../lgtm-review-git-crosscheck`, created by the orchestrator from the schema pre-commit. One commit per phase, `feat(git-crosscheck): phase N — <summary>`; tick Progress in the same commit.
- Node 22, pnpm 11; without `pnpm` on the PATH put `$HOME/.local/opt/node22/bin` first and use `corepack pnpm`. CLI and web tests use the built core: run `pnpm build` after core changes.
- Tests build their own git repositories in `realpathSync(mkdtempSync(join(tmpdir(), "lgtm-git-")))` with `git init -q -b main` and `git -c user.name=t -c user.email=t@t commit …`; commit dates via the env `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`. Never read `~/.claude`.
- Every git call is `execFile` with an argument array; never a shell string; never a write command.
- Before every commit: guard prints nothing, no golden changes, `pnpm check` green. Follow names over line numbers; report differences in the commit message.

## Phase 1: Git runner, parsers and `gitCrosscheck` (core node)

Suggested worker: OpenCode. **Files**: new `packages/core/src/node/git.ts`, new `packages/core/src/node/git.test.ts`, `packages/core/src/node/index.ts` (append `export { runGit, parseStatusZ, parseLogNameStatus, gitCrosscheck, GIT_FILES_MAX, GIT_COMMITS_MAX, type RunGit, type GitCrosscheckInput } from "./git.js";`).

Tests:
- `parseStatusZ`: `" M a.txt\0?? c.txt\0R  e.txt\0d.txt\0A  new.ts\0"` → `[{a.txt, M}, {c.txt, ??}, {e.txt, R}, {new.ts, A}]`; `""` → `[]`; paths with spaces kept whole.
- `parseLogNameStatus`: two commits (`"\x01h2\nM\tsrc/a.ts\nR100\told.ts\tnew.ts\n\n\x01h1\nA\tsrc/a.ts\nD\tgone.ts\n"`) → `commits: 2`, files `src/a.ts` M (newest wins), `new.ts` R, `gone.ts` D; `""` → `{ commits: 0, files: [] }`.
- `gitCrosscheck` with a fake `run` (a function returning canned outputs per first argument): not a repository → `available: false` with the note; unknown branch → `ref: "HEAD"` plus the note; `startedAt: null` → no log call, `committed: []`, the note; a session path `(shell edit)` is ignored and `/elsewhere/x.ts` counts in `outsideRepo`.
- Integration with real git (temp repo, branch `main`): commit `a.txt` dated `2026-01-01T08:00:00Z`; commit `b.txt` dated `2026-01-01T10:05:00Z`; then modify `a.txt`, create untracked `c.txt`, `git mv` a committed `d.txt` to `e.txt` (commit `d.txt` in the first commit). Input: `branch: "main"`, `startedAt: "2026-01-01T10:00:00Z"`, `endedAtMs: Date.parse("2026-01-01T11:00:00Z")`, `sessionFiles: [<repo>/a.txt, <repo>/b.txt, <repo>/x.txt, "/elsewhere/y.txt"]` → `available: true`, `ref: "main"`, `commitCount: 1`, `committed: [{ b.txt, A, inLog: true }]` (the 08:00 commit is outside the window), `uncommitted` = `a.txt` (M, inLog true), `c.txt` (??, false), `e.txt` (R, false), `notInGit: ["x.txt"]`, `outsideRepo: 1`, `truncated: false`.
- `runGit` on a missing directory → `null`.

### Success Criteria

- `pnpm --filter @lgtm/core test` passes; no golden change; guard prints nothing; `pnpm check` green.

## Phase 2: API route (CLI)

Suggested worker: OpenCode. Depends on phase 1. **Files**: `packages/cli/src/api.ts`, new `packages/cli/src/api.git.test.ts`.

D3. Tests (`api.git.test.ts`, server started as in `api.map.test.ts` with `startServer({ dir: repo, projectsDir, webRoot })`): the temp repo of the phase-1 integration test; a projects dir holding `projectDirFor(repo)/git-session.jsonl` written with records whose `cwd` is `repo`, `gitBranch` `main`, first timestamp `2026-01-01T10:00:00Z`, and two Edit tool calls on `<repo>/a.txt` and `<repo>/x.txt` (shape of `doc-edits.jsonl`); `utimesSync` sets the file's mtime to `2026-01-01T11:00:00Z`.
- `GET /api/sessions/git-session/git` → 200, `GitCrosscheckResponse.safeParse` succeeds, `ref` `main`, `notInGit` `["x.txt"]`, `uncommitted` contains `a.txt` with `inLog: true` and `c.txt` with `inLog: false`;
- the same request with `If-None-Match` set to the returned `ETag` → 304;
- `GET /api/sessions/nope/git` → 404; `GET /api/sessions/git-session/git/x` → 404; without the token → 403;
- a session whose `cwd` directory is not a repository → 200 with `available: false`.
- Every existing API test passes unchanged.

### Success Criteria

- `pnpm build`, then `pnpm --filter lgtm-review test` passes; guard prints nothing; `pnpm check` green.

## Phase 3: Web route and view

Suggested worker: OpenCode. Depends on the schema pre-commit (phase 2 not needed for its tests). **Files**: `packages/web/src/api.ts`, `viewmodel.ts`, `viewmodel.test.ts`, `App.tsx`, new `GitView.tsx`, new `git.test.tsx`.

D4. Tests:
- `viewmodel.test.ts`: `parseRoute("#/session/abc/git")` toStrictEqual `{ kind: "git", id: "abc" }`; `routeHref({ kind: "git", id: "a/b" })` = `#/session/a%2Fb/git` and round-trips; `#/session/abc/prompt/1/git` and `#/session/abc/git?x=1` → `{ kind: "list" }`; existing routing tests unchanged.
- `git.test.tsx` (SSR with `renderToStaticMarkup`, a `makeGit(over)` builder for `GitCrosscheckResponse`):
  - unavailable → only the note text, no table;
  - two not-in-log entries (one uncommitted, one committed) → heading `Changed in git but not in the log (2)`, both paths, `uncommitted` and `committed in the window`;
  - in-log entries are not in that table and are counted in `files appear in both`;
  - `notInGit` list and its heading count; empty lists show `Nothing` texts;
  - `outsideRepo: 2` and `truncated: true` lines appear; `ref: null` shows `Commits were not read.`;
  - log-derived text with `<img src=x onerror=alert(1)>` as a path is escaped (no `<img` in the markup).

### Success Criteria

- `pnpm --filter @lgtm/web typecheck` and `pnpm --filter @lgtm/web test` pass; existing web tests unchanged; guard prints nothing; `pnpm check` green.

## Phase 4: README, browser check, docs (orchestrator only)

1. Paste into `packages/cli/README.md`, a new section after "Worktrees":

   `## Git cross-check` — "Each session has a **Git cross-check** view (link next to Map; API \`GET /api/sessions/<id>/git\`). It runs read-only git in the session's directory (\`rev-parse\`, \`status\`, \`check-ref-format\`, \`log --no-merges\`) when you open it or press Refresh, and compares what git shows with the files the session's own prompts edited: files that are uncommitted, or changed by commits of the session's branch between its start and its log's last write (±10 minutes, by committer date), but edited by no prompt are listed as **not in the log** (your own change, a formatter or generator, or a shell edit the log does not show); files the session edited that git shows neither way are **not in git** (reverted, deleted again, or committed outside the window). Files outside the repository are only counted. The view never changes a status, a reason or a hint."
2. Browser check (owner, or orchestrator with a browser tool) on the phase-2 layout: link, both lists, Refresh, the unavailable state. Record it (or "not viewed") in `context/changes/git-crosscheck/reviews/check.md`.
3. Roadmap S-21 → done; PRD FR-019 unchanged unless something differs; archive.

## Progress

### Schema pre-commit (orchestrator)

- [ ] 0.1 `GitFileEntry`, `GitCrosscheckResponse` and their exports on main; `pnpm check` green

### Phase 1: Core node

- [x] 1.1 `git.ts` runner, parsers, `gitCrosscheck` + tests; `pnpm check` green

### Phase 2: API

- [x] 2.1 `/api/sessions/:id/git` + tests; `pnpm check` green

### Phase 3: Web

- [x] 3.1 route, fetch, `GitView`, link, Refresh + tests; `pnpm check` green

### Phase 4: Orchestrator

- [ ] 4.1 README text, browser check recorded
- [ ] 4.2 roadmap, PRD, archive
