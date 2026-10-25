# Documentation-only edits (S-16, FR-015) Implementation Plan

## Overview

Every successful edit counts for the status rule today, except edits made only by git operations (S-11). So a Markdown edit after the last passing check turns a prompt `unchecked` ("1 edit after last check"), and a prompt that only updates docs is `unchecked` ("no checks ran"), although no check can verify prose. This slice treats documentation-only edits like git-operation edits: they stay in the file list, the steps, the diffs and the time split, but they never make a prompt `unchecked` and never invalidate an earlier passing check. Documentation files also stop receiving the verification-oriented hints.

## Current State Analysis

- `packages/core/src/analyze.ts`
  - `interface EditRec` (L69-80): `{ seq, files: FileTouch[], gitOp, thread }`.
  - Edits are recorded in `onEvent`, `case "tool_result"`, at L581: `use.prompt.edits.push({ seq: seqAt, files: touches, gitOp, thread: use.thread })`. `touches` come from Edit/MultiEdit/Write/NotebookEdit (`editTouch`, one file), from `bashEditDiff` (one or more files) or from the shell-command heuristic (`classifyShellMutation` + `resolveTarget`; an unparseable target becomes the placeholder path `(shell edit)`). Subagent edits arrive through the same code path (merged events, `thread` = agent id).
  - `judge()` (L220-263): `if (p.edits.length === 0)` → "no edits"; `const edits = p.edits.filter((e) => !e.gitOp)`; empty → "no edits (git operations only)"; then `lastEdit`, `incompleteAfter`, the checked / failing branch (`lastCompleted.coveredSeq > lastEdit`), "check stopped", "no checks ran", "edit in the same command as the last check", "N edits after last check".
  - `reasonOf()` (L265-272) appends " (shell edits may be incomplete)" and the subagent suffixes.
  - `evidenceOf()` (L178-185) passes every non-gitOp edited file to `computeHints`.
- `packages/core/src/hints.ts`: path classifiers `isTestPath` (L93), `sensitiveMatch`, `isManifestPath`, `publicSurfaceKind`, `isConfigPath` (L189); `computeHints` (L250-307) applies, per file: test rules (`test-modified-during-fix`, `assertions-removed`, `test-skipped`), `sensitive-path`, `unchecked-edit`, `dependency-change`, `public-surface` (non-test files), `config-change`, `large-change`; `recommend` (L313) returns `skim` for `no-changes`.
- Fixtures: only `shell-edits.jsonl` prompt 1 edits a documentation file (`sed -i.bak … docs/limits.md`, then a passing `pnpm test`; labelled `checked`). `hints-sensitive-config.jsonl` only reads `README.md`. The demo session (`scripts/build-demo.mjs`) edits no documentation.
- Goldens: `packages/core/fixtures/sessions/__golden__/<fixture>.{analysis,steps,diffs}.json` come from `packages/core/src/golden.test.ts`; `<fixture>.summary.md` from `packages/cli/src/summary.test.ts`, which iterates every fixture. The `.export.html` goldens cover only `failing-check`, `hints-test-edits`, `steps-mixed` (unaffected).
- `scripts/audit-status.mjs` prints aggregate counts (9 text lines); `packages/cli/src/audit-status.test.ts` allows at most 10 lines and asserts that only numbers are printed.
- `packages/cli/README.md` section "Status accuracy and limits" documents shell edits, git operations and masked exit codes; its bullet "**Not analysed.** Subagent activity (prompts are marked partial)." is outdated since S-12.

## Desired End State

- A "documentation file" is decided by its file name only (D1). An edit whose files are all documentation files is a "doc edit".
- Status rule: doc edits are ignored like git-operation edits. Exact reasons:
  - only doc edits (with or without git-operation edits): `no-changes`, reason `no code edits (documentation only)`;
  - only git-operation edits: unchanged, `no edits (git operations only)`;
  - passing check after the last code edit and N >= 1 doc edits after that check: `checked`, reason `<label> passed after last code edit<note><via>; N documentation edit(s) after it` (for example `pnpm test passed after last code edit; 1 documentation edit after it`);
  - no doc edit after the deciding check: every reason is byte-identical to today (`... passed after last edit`, `N edits after last check`, ...), where N now counts code edits only.
- Hints: documentation files get only `large-change`; code files are unaffected.
- Everything else is unchanged: file list, diffs, steps, time split, play beats, import map, inheritance, summary/export/web rendering, schema.
- `scripts/audit-status.mjs` prints one more aggregate: prompts whose reason shows that documentation edits were not counted.
- README documents the rule and the exact patterns; the outdated subagent bullet is corrected.

## What We're NOT Doing

- No schema change (no `doc` flag on `FileChange`), no new status value, no UI or terminal rendering change.
- No configuration: the pattern list is a constant, like the check patterns.
- No change to timing, steps, diffs, play beats, the import map, `markInherited`, `--summary`/`--export` formatting.
- Scratch files outside the work tree (Write/Edit to temp directories) are not covered here; that is roadmap S-20.
- `.mdx`, other `.txt` files, notebooks, HTML and images stay code.

## Design decisions (binding)

D1. Classifier in `packages/core/src/hints.ts`, next to the other path classifiers (pure string logic, no Node imports):

```ts
/** File names (lower-cased, optionally with `.txt`) that are documentation wherever they are. */
const DOC_NAME_RE = /^(?:readme|licen[cs]e|copying|notice|authors|contributors|changelog|changes|history)(?:\.txt)?$/;
/** Documentation extensions. `.mdx` (compiled by site generators) and other `.txt` files are code on purpose. */
const DOC_EXT_RE = /\.(?:md|markdown|mdown|mkdn?|rst|adoc|asciidoc)$/;

/** Documentation file (FR-015): edits to it need no check. Decided by the file name only. */
export function isDocPath(path: string): boolean {
  const name = (path.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  if (name === "") return false;
  return DOC_EXT_RE.test(name) || DOC_NAME_RE.test(name);
}
```

Not exported from `packages/core/src/index.ts` (nothing outside core needs it in this slice).

D2. `EditRec` gets `doc: boolean` ("every file of the edit is documentation; listed, never changes the status"). It is set where the record is pushed (L581): `doc: touches.every((t) => isDocPath(t.path))` (`touches` is non-empty there). A command that edits a doc file and a code file is a code edit. The placeholder path `(shell edit)` is not documentation.

D3. `judge()` (exact shape; keep the rest of the function as is):

```ts
if (p.edits.length === 0) return { status: "no-changes", reason: "no edits" };
// Git operations bring in other people's changes and documentation needs no check (FR-015): neither moves the status.
const edits = p.edits.filter((e) => !e.gitOp && !e.doc);
if (edits.length === 0) {
  return p.edits.some((e) => !e.gitOp)
    ? { status: "no-changes", reason: "no code edits (documentation only)" }
    : { status: "no-changes", reason: "no edits (git operations only)" };
}
```

and in the passing branch (`lastCompleted.exit === 0`):

```ts
const note = /* unchanged */;
const docsAfter = p.edits.filter((e) => e.doc && !e.gitOp && e.seq > lastCompleted.coveredSeq).length;
if (docsAfter > 0) {
  return { status: "checked", reason: `${lastCompleted.label} passed after last code edit${note}${via(lastCompleted.thread)}; ${plural(docsAfter, "documentation edit")} after it` };
}
return { status: "checked", reason: `${lastCompleted.label} passed after last edit${note}${via(lastCompleted.thread)}` };
```

`lastEdit`, `incompleteAfter`, "check stopped", the failing branches and `afterEdits` all use the filtered `edits` (code edits) without further change. Consequence (intended): a failing check followed only by doc edits stays `failing`; a doc edit after a failing or missing check does not add to "N edits after last check".

D4. `reasonOf()` is unchanged, so a doc edit found by the shell heuristic still appends " (shell edits may be incomplete)" after the D3 text.

D5. `computeHints()`: compute `const doc = isDocPath(f.rel)` per file and skip every rule except `large-change` for documentation files (wrap the existing rules in `if (!doc) { … }`; do not duplicate the `large-change` reason string). `evidenceOf()` and `recommend()` are unchanged.

D6. `scripts/audit-status.mjs`: `aggregate()` adds `docEditPrompts` (prompts whose `reason` matches `/^no code edits \(documentation only\)|; \d+ documentation edits? after it/`) and `docEditPct` (same `pct` helper); `render()` adds one line after the shell-edit line: `prompts with documentation edits not counted: N (x%)`. Output stays numbers only and at most 10 text lines.

D7. Fixtures and goldens: one new synthetic fixture `doc-edits` (Phase 2 spec below). `shell-edits.labels.json` prompt 1 becomes `no-changes` (only `docs/limits.md` was edited). Golden files that may change in this slice, and no others:
- new: `doc-edits.analysis.json`, `doc-edits.steps.json`, `doc-edits.diffs.json`, `doc-edits.summary.md`;
- changed: `shell-edits.analysis.json`, `shell-edits.steps.json`, `shell-edits.summary.md` (prompt 1 status and reason, and the counts line of the summary).

If any other golden or any other existing test changes behaviour, stop and report the file and the difference instead of updating it.

## Working rules for implementers

- Branch `change/doc-edits` in the worktree `../lgtm-review-doc-edits` (the orchestrator creates both). One commit per phase, message `feat(doc-edits): phase N — <summary>`; tick the phase's Progress boxes in the same commit.
- Node 22 and pnpm 11 (root `packageManager`). If `pnpm` is not on the PATH, put `$HOME/.local/opt/node22/bin` first on the PATH and run `corepack pnpm <args>` instead of `pnpm <args>`.
- Fixtures are synthetic. Do not read `~/.claude` and do not send repository content to external services.
- Core stays free of Node imports outside `src/node/` and tests. Check: `grep -rln 'from "node:' packages/core/src --include=*.ts | grep -v '/node/\|\.test\.ts\|/testing/'` prints nothing.

## Phase 1: Documentation classifier and hints (core)

Suggested worker: Haiku or Sonnet. Expected size: about 60 changed lines.

**Files**: `packages/core/src/hints.ts`, `packages/core/src/hints.test.ts`.

Steps:
1. Add D1 (`DOC_NAME_RE`, `DOC_EXT_RE`, `isDocPath`) next to `isConfigPath`.
2. Apply D5 in `computeHints`.
3. Tests in `hints.test.ts`:
   - `describe("isDocPath")` with a `test.each` of true cases: `README.md`, `docs/guide.MD`, `/home/user/project/notes.markdown`, `a.mdown`, `b.mkd`, `c.mkdn`, `x.rst`, `y.adoc`, `z.asciidoc`, `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, `AUTHORS`, `CONTRIBUTORS`, `CHANGELOG`, `CHANGES`, `HISTORY`, `README`, `readme.txt`, `LICENSE.txt`, `C:\\repo\\README.md`, `.github/pull_request_template.md`; and false cases: `page.mdx`, `notes.txt`, `requirements.txt`, `README.md.ts`, `src/index.ts`, `Makefile`, `Dockerfile`, `.env`, `(shell edit)`, `` (empty string), `docs/`, `docs/guide`, `CHANGELOG.json`, `history.py`.
   - Rows added to the existing `describe("computeHints rules")` table (it uses `base = { lastCheckSeq: 100, cwd: "/p" }` and the `ev()` / `rules()` helpers):
     - `["doc: sensitive name ignored", [ev("/p/SECURITY.md")], []]`
     - `["doc: sensitive directory ignored", [ev("/p/docs/auth/login.md")], []]`
     - `["doc: unchecked edit ignored", [ev("/p/README.md", { seq: 101 })], []]`
     - `["doc: README in a test directory gets no test rules", [ev("/p/tests/README.md", { inFix: true, stats: { assertRemoved: 2 } })], []]`
     - `["doc: public surface ignored", [ev("/p/src/api/README.md")], []]`
     - `["doc: large change still flagged", [ev("/p/docs/big.md", { changed: 301 })], ["large-change:/p/docs/big.md"]]`
     - `["mdx is code", [ev("/p/src/auth/page.mdx")], ["sensitive-path:/p/src/auth/page.mdx"]]`
     - `["code file next to a doc file keeps its hints", [ev("/p/README.md", { seq: 101 }), ev("/p/src/a.ts", { seq: 101 })], ["unchecked-edit:/p/src/a.ts"]]`

### Success Criteria

- `pnpm --filter @lgtm/core typecheck` and `pnpm --filter @lgtm/core exec vitest run src/hints.test.ts` pass.
- `pnpm --filter @lgtm/core test` passes without `-u`, and `git status --porcelain packages/core/fixtures` prints nothing (no golden changes in this phase).
- Node-free grep (Working rules) prints nothing.
- `pnpm check` green.

## Phase 2: Status rule, fixture and goldens (core)

Suggested worker: Sonnet. Depends on Phase 1.

**Files**: `packages/core/src/analyze.ts`, `packages/core/src/analyze.test.ts`, new `packages/core/fixtures/sessions/doc-edits.jsonl` and `doc-edits.labels.json`, `packages/core/fixtures/sessions/shell-edits.labels.json`, goldens listed in D7.

Steps:
1. `analyze.ts`: import `isDocPath` from `./hints.js`; D2 (`EditRec.doc` with a doc comment, set at the push); D3 in `judge()`.
2. Unit tests in `analyze.test.ts`, new `describe("documentation edits (FR-015)")`, using the existing builders (`prompt`, `edit(id, file)`, `bash`, `toolUse`, `toolResult`) and a local `diffBash` helper like the one in `describe("git operations")`:
   - DOC-1: `edit("e1")`, `bash("b1", "pnpm test")`, `edit("e2", "/home/user/project/README.md")` → `checked`, reason exactly `pnpm test passed after last code edit; 1 documentation edit after it`.
   - DOC-2: as DOC-1 with two doc edits (`README.md`, `docs/a.rst`) → reason ends with `; 2 documentation edits after it`.
   - DOC-3: only `README.md` and `LICENSE` edits → `no-changes`, reason `no code edits (documentation only)`, `files` has 2 entries.
   - DOC-4: a `README.md` edit plus `diffBash("b1", "git merge main")` → `no-changes`, reason `no code edits (documentation only)`.
   - DOC-5: regression: only `diffBash("b1", "git merge main")` → reason `no edits (git operations only)`.
   - DOC-6: code edit, `bash("b1", "pnpm test", { exit: 1 })`, `README.md` edit → `failing`, reason starts with `pnpm test failed`.
   - DOC-7: code edit and `README.md` edit, no check → `unchecked`, reason `no checks ran`, hints exactly `["unchecked-edit"]` on the code file.
   - DOC-8: passing check, then an edit of `/home/user/project/src/page.mdx` → `unchecked`, reason `1 edit after last check`.
   - DOC-9: passing check, then one `diffBash` command whose `bashEditDiff` lists `README.md` and `src/e.js` → `unchecked`, reason `1 edit after last check` (extend the local helper to take several paths).
   - DOC-10: passing check, then `bash("b2", "sed -i 's/a/b/' README.md")` (no diff in the result: shell heuristic) → `checked`, reason exactly `pnpm test passed after last code edit; 1 documentation edit after it (shell edits may be incomplete)`.
   - DOC-11: code edit, passing check, code edit, `README.md` edit → `unchecked`, reason `1 edit after last check`.
   - DOC-12: `bash("b1", "pnpm test | tail -1")` passing after a code edit, then a `README.md` edit → reason contains `(exit code not verified); 1 documentation edit after it`.
   - DOC-13: no documentation edits → reason still `pnpm test passed after last edit` (byte-identical regression).
3. Fixture `doc-edits.jsonl`. Copy the record shape, key order and constants of `unchecked-edit-after-check.jsonl` exactly: `uuid` `00000000-0000-4000-8000-0000000000NN` counting up from `…01` over every record, `parentUuid` = previous record's uuid (null for the first), `sessionId` `00000000-0000-4000-8000-000000000001`, `timestamp` one second apart from `2026-01-01T00:00:01.000Z`, `cwd` `/home/user/project`, `gitBranch` `main`, `version` `2.1.0`. Tool ids `toolu_01`, `toolu_02`, … in order. Edit results use `toolUseResult: {"type":"update","filePath":…,"oldString":…,"newString":…,"structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-…","+…"]}]}`; Write-create results use `{"type":"create","filePath":…,"content":…,"structuredPatch":[]}` (as in `diffs-mixed.jsonl` line 7); a failing Bash result is `{"type":"tool_result","tool_use_id":…,"content":"Exit code 1\nTests: 1 failed, 2 passed","is_error":true}` (as in `failing-check.jsonl` line 5). All paths absolute under `/home/user/project/`. A throwaway generator script in your scratchpad is fine; commit only the `.jsonl`.

   | # | Prompt text | Actions in order | Expected status, reason | Hints | Recommendation |
   | - | ----------- | ---------------- | ----------------------- | ----- | -------------- |
   | 0 | `Fix add, run the tests, then note it in the changelog.` | Edit `src/add.js` (`a - b` → `a + b`); Bash `pnpm test` → `Tests: 3 passed`; Edit `CHANGELOG.md` (`## Unreleased` → `## Unreleased` + `- Fix add`, newLines 2) | `checked`, `pnpm test passed after last code edit; 1 documentation edit after it` | `[]` | `skim` |
   | 1 | `Update the guide and the README.` | Edit `docs/guide.md`; Write `README.md` (create, `# Project\n`) | `no-changes`, `no code edits (documentation only)` | `[]` | `skim` |
   | 2 | `Add sub and document it, no need to test.` | Write `src/sub.js` (create, `export const sub = (a, b) => a - b;\n`); Edit `README.md` | `unchecked`, `no checks ran` | `["unchecked-edit:src/sub.js"]` | `read-flagged` |
   | 3 | `Fix the parser and note what still fails.` | Edit `src/parser.js`; Bash `pnpm test` → failing result above; Edit `docs/notes.md` | `failing` | `[]` | `read-flagged` |
   | 4 | `Tighten the security policy and the auth docs.` | Edit `SECURITY.md`; Edit `docs/auth/login.md` | `no-changes`, `no code edits (documentation only)` | `[]` | `skim` |

   `doc-edits.labels.json`: `{ "fixture": "doc-edits", "source": "synthetic", "prompts": [ … ] }` with, per prompt, `index`, `expectedStatus`, `expectedRecommendation`, `expectedHints` (paths relative to `/home/user/project/`, as in the table) and a one-line `note`.
4. `shell-edits.labels.json` prompt 1: `"expectedStatus": "no-changes"`, note `sed -i.bak on docs only: documentation edits need no check (FR-015); the passing pnpm test is not needed`.
5. Goldens: `pnpm build` (the CLI tests use the built core and CLI), then `pnpm --filter @lgtm/core test -- -u` and `pnpm --filter lgtm-review test -- -u` (if `-u` does not reach vitest, use `pnpm --filter <package> exec vitest run --exclude '**/*.perf.test.ts' -u`). Then `git status --porcelain packages/core/fixtures/sessions/__golden__` must list exactly the D7 files. Read the diffs of the three `shell-edits.*` goldens: only prompt 1 (status, reason) and the summary's counts line and row 2 may differ.

### Success Criteria

- All DOC-1..DOC-13 tests pass; the golden test "status match >= 95%" reports no misses (the new labels match).
- Exactly the D7 golden files are new or changed; no other test file was edited to make it pass.
- Node-free grep prints nothing; `pnpm check` green (typecheck, tests, build, pack smoke, perf).

## Phase 3: Audit counter and README (scripts + CLI docs)

Suggested worker: Haiku. Depends on Phase 2 (the counter test needs the new fixture).

**Files**: `scripts/audit-status.mjs`, `packages/cli/src/audit-status.test.ts`, `packages/cli/README.md`.

Steps:
1. D6 in `scripts/audit-status.mjs` (and the `--help` text stays one line).
2. `audit-status.test.ts`:
   - in "prints aggregates that match the CLI JSON": `agg.docEditPrompts` equals the number of prompts in the CLI JSON whose `reason` matches the D6 regex, and is greater than 0;
   - in "text output carries counts": `stdout` matches `/^prompts with documentation edits not counted: \d+ \(/m`; the existing at-most-10-lines assertion stays unchanged.
3. `packages/cli/README.md`, section "Status accuracy and limits":
   - add after the **Git operations** bullet: **Documentation edits.** Edits whose files are all documentation (`*.md`, `*.markdown`, `*.mdown`, `*.mkd`, `*.mkdn`, `*.rst`, `*.adoc`, `*.asciidoc`, and files named `README`, `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, `AUTHORS`, `CONTRIBUTORS`, `CHANGELOG`, `CHANGES` or `HISTORY`, also with `.txt`) stay in the file list, the steps and the diffs but need no check: they never make a prompt unchecked and never invalidate an earlier passing check (the reason then reads "pnpm test passed after last code edit; 1 documentation edit after it"). A prompt that only edited documentation is "no changes" with the reason "no code edits (documentation only)". `.mdx` and other `.txt` files count as code. If your build or tests consume Markdown (doctests, prompt templates), read those files yourself.
   - replace the bullet "**Not analysed.** Subagent activity (prompts are marked partial)." with: **Subagents.** Edits and checks from subagent transcripts count toward the prompt that started the subagent, merged by timestamp. A prompt is marked partial only when a transcript is missing or nested deeper than 3 levels; a transcript cut by a cap is named in the reason.
   - in the audit-script paragraph of the same section, add the new aggregate to the list ("… the share of checks with an unverified exit code and the share of prompts whose documentation edits were not counted").
   - in section "Review hints", after the rule list: "Documentation files (see "Documentation edits" under Status accuracy and limits) only get `large-change`."

### Success Criteria

- `pnpm build` then `pnpm --filter lgtm-review exec vitest run src/audit-status.test.ts` passes.
- `pnpm check` green; no golden changes in this phase (`git status --porcelain packages/core/fixtures` prints nothing).

## Phase 4: Real-log audit, PRD and roadmap (orchestrator only)

Not for implementers. Real logs are read only by local Claude subagents; nothing from them goes to external models or into the repository except aggregate counts.

1. PRE = build of main at the merge base, POST = build of the merged branch. For each local project of the owner, run `node scripts/audit-status.mjs --json --cli <PRE or POST>/packages/cli/dist/cli.js --dir <repo>` and, in the scratchpad, a PRE→POST status transition matrix matched by (session id, prompt index), counts only.
2. Record status distributions PRE/POST, `docEditPrompts`, and the transitions (expected only `unchecked → checked`, `unchecked → no-changes`, `unchecked → failing`) in `context/changes/doc-edits/reviews/audit-<date>.md`. Any other transition is a bug: report before archiving.
3. Roadmap S-16 → done with the measured effect; PRD Decision (S-16) gets the measured numbers; move `context/changes/doc-edits/` to `context/archive/doc-edits/` (`status: archived`, `archived_at`).

## Progress

### Phase 1: Documentation classifier and hints

- [x] 1.1 `isDocPath` + hints rule with tests; no golden changes; `pnpm check` green

### Phase 2: Status rule, fixture and goldens

- [x] 2.1 `EditRec.doc` + `judge()` with DOC-1..DOC-13
- [x] 2.2 fixture `doc-edits` + labels, `shell-edits` label, exactly the D7 goldens; `pnpm check` green

### Phase 3: Audit counter and README

- [x] 3.1 `docEditPrompts` in the audit script with tests; README; `pnpm check` green

### Phase 4: Audit and docs (orchestrator)

- [ ] 4.1 PRE/POST real-log aggregate audit recorded
- [ ] 4.2 roadmap, PRD, archive
