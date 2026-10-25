# Scoped checks (S-18, FR-017) Implementation Plan

## Overview

`checked` means "a check passed after the last edit", but the check may have run on only part of the repository: `cd packages/web && pnpm test` while `packages/core` was edited, `pytest tests/test_cart.py` while `src/orders.py` was edited. This slice works out, from the command text and the working directory of the tool call, where each check ran ("scope"), and for a `checked` prompt flags every edited code file that no later passing check covered: a `check-scope` hint (severity warn) on the file and "(scoped to <scope>)" in the reason. The status never changes; nothing is resolved through the file system (named package filters stay unresolved, no hint).

## Current State Analysis

- `packages/core/src/check-patterns.ts` (398 lines): `splitSegments` (L69), `stripPrefixes` (L145), `normalizeFirstToken` (L162), `SIMPLE_RES` (L255), `matchSegment` (L272, decides whether one segment is a check), `classifyCommand` (L316: `{ isCheck, label, unreliable, mutationProbe }`; `check-patterns.test.ts` L176 asserts the exact object for non-checks, so `CommandClass` must not gain a field).
- `packages/core/src/parse.ts`: `ToolUseEvent` (L49-60) has no working directory; `handleAssistant` (L525-546) builds it from the record; `meta.cwd` (L559) is the first record's `cwd` only. Claude Code keeps the Bash working directory between calls and writes the current `cwd` on every record.
- `packages/core/src/analyze.ts` (768 lines): `CheckRec` (L84-114), checks created on `tool_use` (L433-453: `classifyCommand`), `judge()` (L222-276, checked branch L252-262 with the S-16 documentation tail), `finish()` (L675: `judge` then `computeHints({ edits, lastCheckSeq, cwd })` at L688-689).
- `packages/core/src/hints.ts`: `HintInput` (L228-234), `computeHints` (L262-322; documentation files get only `large-change` since S-16).
- `packages/core/src/shell-edits.ts` exports `normalizePath` (pure `.`/`..` handling).
- Fixture commands (all of `packages/core/fixtures/sessions/**/*.jsonl`): plain `pnpm test|lint|typecheck|build`, `pytest -q …`, `cd /home/user/project && pnpm test`, `python manage.py test app.tests`, `python -m unittest …`, `mvn -q test …`, `dotnet test …`, `gh run watch …`, `bash scripts/*.sh …`. With D3's whole-project rule none of them is scoped, so no existing golden may change.
- `scripts/audit-status.mjs` prints 10 text lines; `packages/cli/src/audit-status.test.ts` L61 allows at most 10.

## Desired End State

- `checkScope(command, repo?)` (check-patterns.ts) returns the scope roots of a check command as written, or `null` when it cannot be placed (D2).
- Tool-call events carry the record's `cwd`; every check gets a resolved scope (absolute roots + a short label) or `null` = whole project (D3).
- For a `checked` prompt: an edited code file is covered when some passing check that finished after the file's last edit is unscoped or covers it (D4). Each uncovered file gets `{ rule: "check-scope", severity: "warn", reason: "outside the scope of the passing check (<label>)" }`, and the reason reads e.g. `pnpm test passed after last edit (scoped to packages/web)`.
- Prompts that are not `checked`, documentation files and git-operation edits are never flagged; the recommendation rule is unchanged (warn hints do not raise it; the prompt does count as "needs attention" through its hint).
- `scripts/audit-status.mjs` counts prompts whose reason carries "(scoped to …)".

## What We're NOT Doing

- No new status, no severity above warn, no change to `recommend()`, `needsAttention`, steps, diffs, play beats, the map, summary/export formatting or the web (rule names render generically).
- No Node IO in core and no reading of `package.json`/workspace files: named filters (`--filter @scope/pkg`, `-w name`, `yarn workspace`, `cargo -p`, `mvn -pl`, `mypy -p|-m`) mean "cannot place", so no hint.
- No configuration, no Windows paths (POSIX paths only), no import-graph coverage analysis.
- No `schema.ts` edit in this branch (see "Schema pre-commit"), no README edit (orchestrator, phase 6).

## Ownership and guard (S-19 runs in parallel)

S-18 owns, and only S-18 edits in wave 2: `packages/core/src/{check-patterns,parse,analyze,hints}.ts` and their `*.test.ts`, new `packages/core/src/scope.ts` + `scope.test.ts`, `packages/core/fixtures/sessions/scoped-checks.{jsonl,labels.json}` (new), `packages/core/fixtures/sessions/__golden__/scoped-checks.*` (new), `scripts/audit-status.mjs`, `packages/cli/src/audit-status.test.ts`.

S-18 must NOT touch: `packages/core/src/schema.ts`, `packages/core/src/index.ts`, anything under `packages/core/src/node/`, every other file under `packages/cli/src/`, everything under `packages/web/`, `packages/cli/README.md`, existing fixtures and existing golden files, `package.json`/`pnpm-lock.yaml`, `context/foundation/**`. S-19 owns those it needs (its plan lists them) and never touches S-18's files. **S-18 is the only wave-2 slice that writes golden files**, and only the four new `scoped-checks.*` ones.

Check before every phase commit (prints nothing):

```
git diff --name-only "$(git merge-base main HEAD)" HEAD -- . ':!context/changes/scoped-checks' \
  | grep -vE '^packages/core/src/(check-patterns|parse|analyze|hints|scope)(\.test)?\.ts$|^packages/core/fixtures/sessions/(scoped-checks\.(jsonl|labels\.json)|__golden__/scoped-checks\.(analysis\.json|steps\.json|diffs\.json|summary\.md))$|^scripts/audit-status\.mjs$|^packages/cli/src/audit-status\.test\.ts$'
```

## Schema pre-commit (orchestrator, before S-18 and S-19 start)

The orchestrator lands these three additions on main in one commit (`chore(schema): wave-2 schema additions (S-18, S-19)`), runs `pnpm check`, and only then creates both branches from that commit. The lines use only `z.enum([...])` and `.optional()`, which read the same in zod 3 and zod 4, so the pending `chore/zod-4` change and this commit merge in either order (resolve a textual conflict by keeping both).

In `packages/core/src/schema.ts`:

1. `HintRule`: append `"check-scope"` as the last value.

```ts
export const HintRule = z.enum([
  "test-modified-during-fix",
  "assertions-removed",
  "test-skipped",
  "sensitive-path",
  "unchecked-edit",
  "dependency-change",
  "public-surface",
  "config-change",
  "large-change",
  "check-scope",
]);
```

2. `SessionAnalysis`: after the `archived` field.

```ts
  /** Worktree of the session as a path relative to the main checkout ("." for the main checkout). Set by the CLI only when the listed sessions come from more than one worktree (S-19). */
  worktree: z.string().optional(),
```

3. `SessionSummary`: after the `attentionCount` field.

```ts
  /** Same as `SessionAnalysis.worktree` (S-19). */
  worktree: z.string().optional(),
```

Nothing produces these values until the slices land, so `pnpm check` stays green and no golden changes.

## Design decisions (binding)

D1. **Event working directory.** `ToolUseEvent` gains `/** Working directory recorded on the tool call's record (Claude Code keeps the Bash working directory between calls). */ cwd?: string;`, set in `handleAssistant` from `nonEmptyStr(rec.cwd)` when present (main and sidechain parsers alike).

D2. **`checkScope(command: string, repo?: RepoScripts): string[] | null`** in `check-patterns.ts`, exported from that module only (not from `index.ts`). Pure, never throws (`try`/`catch` → `null`). It walks `splitSegments(stripHeredocs(command))` in order, keeping a `cd` prefix, and looks only at segments for which `matchSegment` is true.
  - **`cd` / `pushd`** segments (`cd <p>`, `pushd <p>`, after `stripPrefixes`) append `<p>` to the prefix (an absolute `<p>` replaces it). `cd` without an argument, `cd -`, or a target starting with `~` or `$` or containing a backtick or `$(` → the result is `null`.
  - **Tokens**: split on whitespace; strip one pair of matching surrounding quotes from a token. Options that take a separate value (tables below) skip their value; `--opt=value` is one token; unknown options are flags.
  - **Roots of one check segment** (after `stripPrefixes` + `normalizeFirstToken`; `<pos>` = positional, non-option tokens after the subcommand):

  | Segment | Roots |
  | ------- | ----- |
  | `vitest [run\|watch] …` | `<pos>`; else `--dir`/`--root` value; `vitest related …` → `null`; else `["."]`. Value options: `-c --config -r --root --dir --project -t --testNamePattern --reporter --environment --pool --shard --outputFile --mode` |
  | `jest …` | `<pos>` plus `--testPathPattern` values; else `["."]`. Value options: `-c --config -t --testNamePattern --selectProjects --shard --reporters --outputFile --rootDir -w --maxWorkers --testPathPattern` |
  | `pytest`, `py.test`, `python -m pytest` | `<pos>` with any `::…` suffix removed; else `["."]`. Value options: `-k -m -c -p -n -o --rootdir --maxfail --tb --junitxml --cov --ignore --deselect --durations` |
  | `go test\|vet\|build` | per package argument: `./...` → `"."`; `./x/...` → `x`; `./x` → `x`; `.` → `"."`; an argument not starting with `.` (import path) → `null`; none → `["."]`. Value options: `-run -bench -count -timeout -tags -coverprofile -cpu -parallel -p -benchtime -o -exec -covermode -coverpkg -ldflags -gcflags` |
  | `tsc` | `-p`/`--project <p>`, `-b`/`--build <p…>`: `p`, or its directory when it ends in `.json`; else positional files; else `["."]` |
  | `eslint`, `ruff check`, `ruff format --check`, `mypy`, `pyright`, `flake8`, `biome check\|lint\|ci`, `shellcheck`, `hadolint`, `bats`, `node --test` | `<pos>`; a glob keeps its part before the first `*?[{` up to the last `/` (a bare glob → `"."`); `mypy -p\|-m` → `null`; else `["."]`. Value options: eslint `-c --config --ext -f --format --max-warnings -o --output-file --rule --parser --ignore-path --cache-location`; ruff `--config --select --ignore --extend-select --target-version --line-length --output-format`; mypy `--config-file --python-version --cache-dir` |
  | `cargo …` | `-p --package --manifest-path --workspace` → `null`; else `["."]` |
  | `dotnet test\|build [p]` | `p`, or its directory when it ends in `.sln`/`.csproj`/`.fsproj`; else `["."]` |
  | `mvn`, `gradle` (and wrappers) | `-pl -f -p` → `null`; else `["."]` |
  | `python manage.py test …`, `python -m unittest …` | `["."]` (test labels are not paths) |
  | `make` | `-C <d>`, `--directory=<d>` → `d`; else `["."]` |
  | `pnpm` | `-C <d>`, `--dir <d>`, `--dir=<d>` → `d`; `--filter`/`-F <f>` (also `=`): path-style when `f` (quotes and braces removed, leading `...`/`^` and trailing `...` removed) starts with `./` or `../` or came in `{…}` → that path; any other filter → `null`; `-r`/`--recursive` → `["."]`; else `["."]`. Script arguments are ignored |
  | `npm` | `--prefix <d>` → `d`; `-w`/`--workspace <x>` (also `=`): contains `/` and does not start with `@` → `x`, else `null`; `--workspaces`/`-ws` → `["."]`; else `["."]` |
  | `yarn` | `--cwd <d>` → `d`; `yarn workspace …` → `null`; else `["."]` |
  | `bun` | `--cwd <d>` → `d`; `--filter` as for pnpm; else `["."]` |
  | `gh pr checks`, `gh run watch` | `null` (CI runs the whole repository) |
  | a script file (`bash scripts/check.sh`, `./verify.sh`, `scripts/x.sh`) | `null` (the script decides) |
  | any other check | `["."]` |

  - **Joining**: each relative root is joined to the current `cd` prefix with `/` (root `"."` → the prefix itself, no prefix → `"."`); a leading `./` and trailing `/` are dropped from every part; absolute roots ignore the prefix. No other normalisation here.
  - **Combining**: any check segment `null` → the command is `null`; otherwise the union of all check segments' roots in order, without duplicates. A non-check command → `null`.

D3. **Resolution**, new `packages/core/src/scope.ts` (pure; imports `normalizePath` from `./shell-edits.js`):

```ts
export interface ResolvedScope {
  /** Absolute, normalised paths the check ran on. */
  roots: string[];
  /** Roots relative to the session root ("…/a/b" for roots outside it), at most two then "+N", <= 60 chars. */
  label: string;
}
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);
export const SCOPE_LABEL_MAX = 60;
export function resolveScope(raw: readonly string[] | null, base: string | null, sessionRoot: string | null): ResolvedScope | null;
```

  `null` when `raw` is null or empty, when `base` or `sessionRoot` is null or not absolute, or when any resolved root (`normalizePath(raw.startsWith("/") ? raw : base + "/" + raw)`) is the session root, an ancestor of it, or `/` (the whole project), or lies inside the session root and consists only of `TEST_DIRS` segments (the whole test suite, e.g. `pytest tests/`). Otherwise the deduplicated roots and their label.

D4. **Coverage** (`scope.ts`):

```ts
/** Does a check that ran on `root` cover the edited `file`? Both absolute. */
export function scopeCovers(root: string, file: string): boolean;
export interface ScopeCheck { coveredSeq: number; passed: boolean; scope: ResolvedScope | null }
export interface EditedFile { path: string; lastSeq: number }
/** Paths of edited files that no passing check finishing after their last edit covers (in input order). */
export function scopeGaps(files: readonly EditedFile[], checks: readonly ScopeCheck[]): string[];
```

  - `scopeCovers`: true when `file === root` or `file` starts with `root + "/"`. Otherwise take the root's key: when its last segment contains a `.` (a file), the key is its stem; else the last segment that is not a `TEST_DIRS` name (lower-cased); no key → false. The file is covered when one of its directory segments (lower-cased) equals the key or its stem equals the key. Stem = name up to the first `.`, lower-cased, with a `test_` prefix or a `_test`/`_spec` suffix removed (`cart.test.ts`, `test_cart.py`, `cart_test.go` → `cart`). So `tests/api` covers `src/api/route.ts`, `tests/test_cart.py` covers `src/cart.py`, `packages/web` covers everything under it.
  - `scopeGaps`: a file is covered when some check with `passed` and `coveredSeq > file.lastSeq` has `scope === null` or a root that `scopeCovers` the file. Files whose path is not absolute (e.g. the `(shell edit)` placeholder) are never gaps.

D5. **Analyzer wiring** (`analyze.ts`):
  - `CheckRec.scope: ResolvedScope | null`, set where the check is created: `resolveScope(checkScope(ev.input.command, opts.repo), ev.cwd ?? parser.meta().cwd, parser.meta().cwd)`.
  - `judge()` returns `{ status, reason, outOfScope: Map<string, string> }` (empty map unless `checked`). In the passing branch, before building the reason: files = every file of the code edits (`edits`, already without git operations and documentation edits) whose path is not `isDocPath`, with its last `seq`; checks = completed, not ignored checks with `passed = exit === 0 && !masked`; `gaps = scopeGaps(files, checks)`. When `gaps.length > 0`, `scopeNote = ` (scoped to ${lastCompleted.scope!.label})`` (when the deciding check is unscoped it covers every file, so gaps imply a scope) and every gap maps to that label.
  - Reason: `${label} passed after last ${docsAfter > 0 ? "code " : ""}edit${note}${scopeNote}${via}` plus the S-16 documentation tail. Without gaps every reason is byte-identical to today.
  - `finish()`: `computeHints({ edits: evidenceOf(p), lastCheckSeq: lastCheckSeq(p), cwd: meta.cwd, outOfScope: j.outOfScope })`.

D6. **Hint** (`hints.ts`): `HintInput.outOfScope?: ReadonlyMap<string, string>` ("path → label of the scoped check; only for a checked prompt"). Inside the existing `if (!doc)` block: `const sc = input.outOfScope?.get(f.path); if (sc !== undefined) add("check-scope", "warn", f.path, `outside the scope of the passing check (${sc})`);` (reasons stay under 120 characters because labels are at most 60).

D7. **Audit counter** (`scripts/audit-status.mjs`): `aggregate()` adds `scopedCheckPrompts` (prompts whose `reason` matches `/\(scoped to [^)]*\)/`) and `scopedCheckPct`; `render()` adds the line `checked prompts with files outside the check's scope: N (x%)` after the documentation line (11 lines).

## Working rules for implementers

- Branch `change/scoped-checks` in `../lgtm-review-scoped-checks`, created by the orchestrator from the schema pre-commit. One commit per phase, `feat(scoped-checks): phase N — <summary>`; tick Progress in the same commit.
- Node 22, pnpm 11; without `pnpm` on the PATH put `$HOME/.local/opt/node22/bin` first and use `corepack pnpm`.
- Synthetic data only; do not read `~/.claude`. Core stays free of Node imports: `grep -rln 'from "node:' packages/core/src --include=*.ts | grep -v '/node/\|\.test\.ts\|/testing/'` prints nothing.
- Run the guard check before every commit. If any existing golden changes, stop and report.

## Phase 1: `checkScope` (core, pure)

Suggested worker: Sonnet or OpenCode. **Files**: `packages/core/src/check-patterns.ts`, `packages/core/src/check-patterns.test.ts`.

Implement D2 with small helpers (`segmentRoots(tokens)` per tool family, `joinPrefix`). Tests: a `describe("checkScope")` `test.each` table, at least:

| Command | Expected |
| ------- | -------- |
| `pnpm test` | `["."]` |
| `cd packages/web && pnpm test` | `["packages/web"]` |
| `cd packages/web && cd src && pnpm test` | `["packages/web/src"]` |
| `cd /abs/x && pnpm test` | `["/abs/x"]` |
| `cd $DIR && pnpm test`, `cd && pnpm test`, `cd - && pnpm test`, `cd ~/x && pnpm test` | `null` |
| `pushd packages/core && pnpm test` | `["packages/core"]` |
| `pnpm -C packages/web test`, `pnpm --dir=packages/web test` | `["packages/web"]` |
| `pnpm --filter ./packages/web test`, `pnpm --filter '{packages/web}' test`, `pnpm --filter ./packages/web... test` | `["packages/web"]` |
| `pnpm -F @acme/web test`, `pnpm --filter web test` | `null` |
| `pnpm -r test` | `["."]` |
| `npm --prefix packages/web test`, `npm -w packages/web test` | `["packages/web"]` |
| `npm --workspace=@acme/web test`, `yarn workspace web test` | `null` |
| `yarn --cwd packages/web test` | `["packages/web"]` |
| `pnpm exec vitest run tests/api` | `["tests/api"]` |
| `vitest run -t adds src/math` | `["src/math"]` |
| `vitest related src/a.ts` | `null` |
| `npx vitest --dir packages/core` | `["packages/core"]` |
| `jest --testPathPattern api` | `["api"]` |
| `pytest tests/test_cart.py::test_total -q`, `uv run pytest tests/test_cart.py` | `["tests/test_cart.py"]` |
| `pytest -k total` | `["."]` |
| `python -m pytest tests/unit` | `["tests/unit"]` |
| `go test ./...` | `["."]` |
| `go test -run TestX ./internal/foo/...` | `["internal/foo"]` |
| `go test github.com/x/y` | `null` |
| `tsc -p packages/core/tsconfig.json`, `tsc -p packages/core` | `["packages/core"]` |
| `tsc --noEmit` | `["."]` |
| `eslint 'src/**/*.ts'` | `["src"]` |
| `ruff check app/` | `["app"]` |
| `mypy -p pkg`, `cargo test -p core` | `null` |
| `make -C backend test` | `["backend"]` |
| `bash scripts/check.sh`, `gh run watch 1 --exit-status` | `null` |
| `pnpm lint && cd packages/web && pnpm test` | `[".", "packages/web"]` |
| `pnpm test && pnpm --filter @x/y test` | `null` |
| `ls src` (not a check) | `null` |

Existing `classifyCommand` tests stay unchanged.

### Success Criteria

- `pnpm --filter @lgtm/core exec vitest run src/check-patterns.test.ts` and `pnpm --filter @lgtm/core test` pass with no golden change; node-free grep and guard print nothing; `pnpm check` green.

## Phase 2: Scope resolution and coverage (core, pure)

Suggested worker: Haiku or OpenCode. **Files**: new `packages/core/src/scope.ts`, new `packages/core/src/scope.test.ts`.

Implement D3 and D4 exactly. Tests (session root `/r`):
- `resolveScope`: `["."]` with base `/r` → `null`; with base `/r/packages/web` → roots `["/r/packages/web"]`, label `packages/web`; `["tests"]` and `["tests/unit/../e2e"]` → `null` (test suite); `["tests/api"]` → label `tests/api`; `["/x/other/pkg"]` → label `…/other/pkg`; `[".."]` with base `/r` → `null` (ancestor); three roots → label `a, b +1`; a 100-character root → label of at most 60 characters ending in `…`; base or root `null`, relative base, `null`/`[]` raw → `null`.
- `scopeCovers`: `/r/packages/web` covers `/r/packages/web/src/a.ts`, not `/r/packages/core/src/b.ts`; `/r/tests/api` covers `/r/src/api/route.ts`; `/r/tests/test_cart.py` covers `/r/src/cart.py`, not `/r/src/orders.py`; `/r/src/cart.test.ts` covers `/r/src/cart.ts`; `/r/internal/foo` does not cover `/r/internal/bar/b.go`.
- `scopeGaps`: a file edited before an unscoped passing check is covered even if a later scoped check misses it; a failing check never covers; a passing check that finished before the file's last edit does not cover it; a relative path is never a gap; output keeps input order.

### Success Criteria

- `pnpm --filter @lgtm/core test` passes with no golden change; node-free grep and guard print nothing; `pnpm check` green.

## Phase 3: Analyzer and hint wiring (core)

Suggested worker: Sonnet. Depends on phases 1-2 and the schema pre-commit.

**Files**: `packages/core/src/parse.ts`, `parse.test.ts`, `analyze.ts`, `analyze.test.ts`, `hints.ts`, `hints.test.ts`.

Steps: D1, D5, D6. Tests:
- `parse.test.ts`: a `tool_use` from a record with `cwd: "/home/user/project/packages/web"` carries that `cwd`; a record without `cwd` gives an event without the key.
- `analyze.test.ts`, new `describe("scoped checks (FR-017)")` with the `records.ts` builders (the `rec` helper writes `cwd: "/home/user/project"`; add a local variant that overrides `cwd` for one record):
  - SC-1: edits `/home/user/project/packages/web/src/a.ts` and `/home/user/project/packages/core/src/b.ts`, then `bash("b1", "cd packages/web && pnpm test")` → `checked`, reason exactly `pnpm test passed after last edit (scoped to packages/web)`; hints include `check-scope` on `b.ts` only.
  - SC-2: same edits, `pnpm test` (no cd) → reason `pnpm test passed after last edit`, no `check-scope`.
  - SC-3: edit `b.ts`, `pnpm test` passes, edit `a.ts`, `pnpm --filter ./packages/web test` passes → no `check-scope` (b.ts covered by the full run).
  - SC-4: `pnpm --filter @acme/web test` → no `check-scope`.
  - SC-5: `Bash pnpm test` whose record `cwd` is `/home/user/project/packages/web`, edits in `packages/core` → `check-scope` on the core file, reason contains `(scoped to packages/web)`.
  - SC-6: the scoped check fails → `failing`, no `check-scope`; an edit after the scoped check → `unchecked`, no `check-scope`.
  - SC-7: a documentation file and a git-operation edit outside the scope are never flagged.
  - SC-8: SC-1 plus a `README.md` edit after the check: reason exactly `pnpm test passed after last code edit (scoped to packages/web); 1 documentation edit after it`, and no hint on `README.md`.
- `hints.test.ts`: rows for `outOfScope` (a code file gets `check-scope:<path>` warn with the label in the reason; a documentation path in `outOfScope` is ignored; absent map → no hint).

### Success Criteria

- `pnpm --filter @lgtm/core test` passes **without** `-u` and `git status --porcelain packages/core/fixtures` prints nothing (no existing fixture has a scoped check); `pnpm check` green; guard prints nothing.

## Phase 4: Fixture and goldens (core + CLI goldens)

Suggested worker: Sonnet. The only phase of wave 2 that writes golden files.

**Files**: new `packages/core/fixtures/sessions/scoped-checks.jsonl`, `scoped-checks.labels.json`; the four new goldens `__golden__/scoped-checks.{analysis.json,steps.json,diffs.json,summary.md}`.

Write the fixture in the exact record shape of `doc-edits.jsonl` (same keys, uuid/timestamp sequence, `cwd` `/home/user/project` except where stated); paths absolute under `/home/user/project/`; every check passes (`toolUseResult` with `stdout`, no error):

| # | Prompt text | Actions | Expected reason | Hints |
| - | ----------- | ------- | --------------- | ----- |
| 0 | `Change web and core, test web only.` | Edit `packages/web/src/a.ts`; Edit `packages/core/src/b.ts`; Bash `cd packages/web && pnpm test` | `pnpm test passed after last edit (scoped to packages/web)` | `["check-scope:packages/core/src/b.ts"]` |
| 1 | `Fix the API route and run its tests.` | Edit `src/api/route.ts`; Bash `pnpm exec vitest run tests/api` | `vitest run tests/api passed after last edit` | `[]` |
| 2 | `Fix cart totals and run the cart test.` | Edit `src/cart.py`; Edit `src/orders.py`; Bash `pytest tests/test_cart.py` | `pytest tests/test_cart.py passed after last edit (scoped to tests/test_cart.py)` | `["check-scope:src/orders.py"]` |
| 3 | `Run everything, then the web package again.` | Edit `packages/core/src/b.ts`; Bash `pnpm test`; Edit `packages/web/src/a.ts`; Bash `pnpm --filter ./packages/web test` | `pnpm --filter ./packages/web test passed after last edit` | `[]` |
| 4 | `Test the web package by name.` | Edit `packages/core/src/b.ts`; Bash `pnpm --filter @acme/web test` | `pnpm --filter @acme/web test passed after last edit` | `[]` |
| 5 | `Fix foo and bar, test foo.` | Edit `internal/foo/a.go`; Edit `internal/bar/b.go`; Bash `go test ./internal/foo/...` | `go test ./internal/foo/... passed after last edit (scoped to internal/foo)` | `["check-scope:internal/bar/b.go"]` |
| 6 | `Test from the project root.` | Edit `src/x.js`; Bash `cd /home/user/project && pnpm test` | `pnpm test passed after last edit` | `[]` |
| 7 | `Keep testing in the web folder.` | Edit `packages/core/src/c.ts`; Bash `pnpm test` on a record whose `cwd` is `/home/user/project/packages/web` | `pnpm test passed after last edit (scoped to packages/web)` | `["check-scope:packages/core/src/c.ts"]` |

Labels: every prompt `expectedStatus: "checked"`, `expectedRecommendation: "skim"`, `expectedHints` as above, one-line `note`. If a reason differs from the table only in the check label wording produced by `classifyCommand`, keep the analyzer's label and note it in the commit message; any other difference is a bug to fix in phase 3 code, not in the table.

Goldens: `pnpm build`, then `pnpm --filter @lgtm/core test -- -u` and `pnpm --filter lgtm-review test -- -u` (fallback `pnpm --filter <pkg> exec vitest run --exclude '**/*.perf.test.ts' -u`). `git status --porcelain packages/core/fixtures` must list exactly the two fixture files and the four `scoped-checks.*` goldens.

### Success Criteria

- Golden and label tests pass (status match reports no misses); exactly the six new files under `packages/core/fixtures/`; `pnpm check` green; guard prints nothing.

## Phase 5: Audit counter (scripts + CLI test)

Suggested worker: Haiku. **Files**: `scripts/audit-status.mjs`, `packages/cli/src/audit-status.test.ts`.

D7. Tests: `agg.scopedCheckPrompts` equals the number of CLI-JSON prompts whose reason matches the D7 regex and is greater than 0 (the new fixture); the text output matches `/^checked prompts with files outside the check's scope: \d+ \(/m`; raise the line limit at L61 from 10 to 11; the numbers-only assertion stays.

### Success Criteria

- `pnpm build`, then `pnpm --filter lgtm-review exec vitest run src/audit-status.test.ts` passes; `pnpm check` green; guard prints nothing.

## Phase 6: README, audit, docs (orchestrator only)

1. Paste into `packages/cli/README.md` on main after the merge:
   - in "Review hints", after the `large-change` rule: `- \`check-scope\` (warn): the prompt is checked, but the check that passed after this file's last edit ran on only part of the repository (a path argument, \`cd <dir> &&\`, \`pnpm -C\`/\`--filter ./dir\`, \`npm --prefix\`, \`go test ./pkg/...\`, or a Bash working directory below the session's). A scope also covers files whose path contains its last non-test folder name (\`tests/api\` covers \`src/api/\`) and the source file of a scoped test file (\`cart.test.ts\` covers \`cart.ts\`). Named package filters (\`--filter @scope/pkg\`) are not resolved. The hint means "confirm the scoped check covers this file", not "untested".`
   - in "Status accuracy and limits", a bullet: `- **Scoped checks.** A checked prompt whose deciding check ran on only part of the repository says "(scoped to <scope>)" in its reason and flags the edited files outside that scope with \`check-scope\`; the status stays checked.`
   - in the audit-script paragraph, add "and the share of checked prompts with files outside the check's scope".
2. Real-log audit (local Claude only, counts only): PRE/POST `node scripts/audit-status.mjs --json` per local project; no status may change (only reasons and hints); record `scopedCheckPrompts` and the number of `check-scope` hints in `context/changes/scoped-checks/reviews/audit-<date>.md`.
3. Roadmap S-18 → done, PRD FR-017 note with the measured numbers, archive.

## Progress

### Phase 1: checkScope

- [x] 1.1 `checkScope` + table tests; `pnpm check` green

### Phase 2: Resolution and coverage

- [x] 2.1 `scope.ts` + tests; `pnpm check` green

### Phase 3: Wiring

- [ ] 3.1 event `cwd`, `CheckRec.scope`, `judge` gaps and reason, `check-scope` hint; SC-1..SC-8; no golden change; `pnpm check` green

### Phase 4: Fixture and goldens

- [ ] 4.1 `scoped-checks` fixture + labels + four new goldens only; `pnpm check` green

### Phase 5: Audit counter

- [ ] 5.1 `scopedCheckPrompts`; `pnpm check` green

### Phase 6: Orchestrator

- [ ] 6.1 README text, real-log audit
- [ ] 6.2 roadmap, PRD, archive
