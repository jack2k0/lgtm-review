# Status accuracy, round 2 (S-20) Implementation Plan

## Overview

The v3 success criterion asks for >= 97% status match on the owner's real prompts (95.3% on 2026-10-23, measured before several later fixes). Re-checking the old mismatch categories against today's code with synthetic probes (2026-10-25) shows that the in-command order shapes, status-less task notifications and background notifications that cross the parent/subagent files already behave as the ground truth expects; this slice pins them with tests. It changes three things:

1. **Scratch files** written with Write/Edit (or a Bash diff) outside the work tree, in a temp or `scratch*` directory (for example Claude Code's own `/tmp/claude-<uid>/…/scratchpad/`), need no check, like documentation (S-16).
2. **Shell-heuristic edit targets** (Bash edits without a diff in the log) resolve against the tool call's recorded working directory (`ToolUseEvent.cwd`, added in S-18) instead of the session's first one.
3. **Python import extraction** no longer loses imports after a `#` comment that contains `"""` or after a string that contains `#`.

The orchestrator measures before (phase 0) and after (phase 5) on real logs, counts only.

## Current State Analysis

- `packages/core/src/analyze.ts`: `FileTouch` (L56-68), `EditRec` (L70-82: `seq, files, gitOp, doc, thread`), `PendingUse` (L143-155, no working directory), `evidenceOf` (L183-190: every non-gitOp file goes to the hints), `judge()` (L225-304: code edits = `!gitOp && !doc`; "no code edits (documentation only)"; checked branch with `docsAfter`, the S-18 scope gaps that skip `isDocPath` files, reason `… passed after last [code ]edit<note><scope><via><docs tail>`), the `tool_use` case stores `pending` at L515, edits are recorded at L575-626 (Edit/Write via `editTouch`; Bash with `bashEditDiff`; shell heuristic with `resolveTarget(e.file, parser.meta().cwd, sm.hasCd)` at L607-610), `finish()` calls `computeHints` at L718.
- `packages/core/src/hints.ts`: `isDocPath` (L208), `HintInput` (L228-236), `computeHints` (documentation files get only `large-change`).
- `packages/core/src/shell-edits.ts`: `resolveTarget(file, cwd, hasCd)`; redirects to `/tmp`, `$TMPDIR`, `.cache` and `scratch*` paths are already ignored for shell edits (`IGNORED_PATH_RES`), but Write/Edit tool edits to such paths count as code edits.
- `packages/core/src/parse.ts`: `ToolUseEvent.cwd` (S-18) carries the record's working directory.
- `packages/core/src/map-extract-py.ts` L61-68: step 1 blanks triple-quoted strings with a regex, step 2 blanks `#…` comments. A `"""` inside a comment opens a fake string that swallows code up to the next `"""`; a `#` inside a string (`s = "#"; import os`) blanks the rest of the line.
- Tests already pinning behaviour: `analyze.test.ts` L478-494 (status-less notifications), the `shell-empty-diff` fixture (`cat > f <<EOF … EOF` then `pnpm test`), `shell-edits` prompts 6-7 (edit after a check in one command). Missing: background notifications across the parent and subagent files.
- No fixture edits a file under `/tmp` or a `scratch*` directory with Write/Edit (`api.play.test.ts` writes `scratch/brief.md`, a documentation file, which stays documentation), so no existing golden changes.

## Desired End State

- `isScratchPath(path, sessionRoot, callCwd)` (hints.ts) decides scratch files (D1). Each recorded file gets a class `code | doc | scratch` (doc first).
- Status rule: code edits are those with at least one `code` file and not git-only. Reasons:
  - only documentation files (unchanged): `no code edits (documentation only)`;
  - only scratch files: `no code edits (scratch files only)`;
  - documentation and scratch, no code: `no code edits (documentation and scratch files only)`;
  - git operations only (unchanged): `no edits (git operations only)`;
  - passing check followed by documentation and/or scratch edits: `… passed after last code edit…`; the documentation tail (`; N documentation edit(s) after it`) is unchanged; scratch edits add no tail.
- Scratch files get no hints and are never `check-scope` gaps; they stay in the file list, steps and diffs.
- Shell-heuristic targets resolve against `ToolUseEvent.cwd ?? sessionRoot`.
- Python extraction: one scanner blanks comments and strings (single, double, triple quoted, with prefixes) while keeping offsets and newlines.
- New tests pin the cross-file background-notification cases; one new fixture `scratch-edits` with goldens.

## What We're NOT Doing

- No cross-session notification matching (a background task started in one session file and reported in another): it affected 1 of 130 prompts in the 2026-10-23 audit.
- No new check-command patterns from real logs in this plan: if phase 0 finds such a category with >= 2 prompts, the orchestrator writes an amendment phase with synthetic shapes.
- No schema change, no web/CLI rendering change, no change to `scripts/audit-status.mjs` (the orchestrator measures with transition counts).
- No configuration of temp roots; POSIX paths only.

## Ownership and guard (S-21 runs in parallel)

S-20 owns, and only S-20 edits in wave 3: `packages/core/src/{analyze,hints,map-extract-py}.ts` and their `*.test.ts`, new `packages/core/fixtures/sessions/scratch-edits.{jsonl,labels.json}`, new `packages/core/fixtures/sessions/__golden__/scratch-edits.{analysis.json,steps.json,diffs.json,summary.md}`.

S-20 must NOT touch: `packages/core/src/schema.ts`, `packages/core/src/index.ts`, anything under `packages/core/src/node/`, `packages/cli/**` (S-21 owns `api.ts`; the README is pasted by the orchestrator), `packages/web/**`, existing fixtures and golden files, `scripts/**`, `package.json`/`pnpm-lock.yaml`, `context/foundation/**`. **S-20 is the only wave-3 slice that writes golden files**, and only the four new `scratch-edits.*` ones.

Check before every phase commit (prints nothing):

```
git diff --name-only "$(git merge-base main HEAD)" HEAD -- . ':!context/changes/status-accuracy-2' \
  | grep -vE '^packages/core/src/(analyze|hints|map-extract-py)(\.test)?\.ts$|^packages/core/fixtures/sessions/(scratch-edits\.(jsonl|labels\.json)|__golden__/scratch-edits\.(analysis\.json|steps\.json|diffs\.json|summary\.md))$'
```

## Design decisions (binding)

D1. **Scratch classifier** in `packages/core/src/hints.ts`, next to `isDocPath`, exported from the module only:

```ts
/** Temporary directories whose files are scratch when they lie outside the session (S-20). */
const TEMP_ROOTS = ["/tmp/", "/var/tmp/", "/private/tmp/", "/private/var/folders/", "/var/folders/", "/dev/shm/"];

/**
 * Scratch file (S-20): an absolute path outside the session root and outside the tool call's working
 * directory, not inside a Claude Code worktree (`/.claude/worktrees/`), and under a temp root or in a
 * directory whose name starts with "scratch". Edits to it need no check.
 */
export function isScratchPath(path: string, sessionRoot: string | null, callCwd: string | null): boolean {
  const p = path.replace(/\\/g, "/");
  if (!p.startsWith("/")) return false;
  const inside = (root: string | null): boolean => {
    if (root === null || root === "") return false;
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    return r !== "" && (p === r || p.startsWith(`${r}/`));
  };
  if (inside(sessionRoot) || inside(callCwd)) return false;
  if (p.includes("/.claude/worktrees/")) return false;
  if (TEMP_ROOTS.some((t) => p.startsWith(t))) return true;
  return p.split("/").slice(0, -1).some((d) => d.toLowerCase().startsWith("scratch"));
}
```

D2. **File classes** (`analyze.ts`):
  - `FileTouch` gains `/** code, documentation (FR-015) or scratch (S-20); decided when the edit is recorded. */ cls: "code" | "doc" | "scratch";`. Rule: `isDocPath(path)` → `"doc"`; else `isScratchPath(path, sessionRoot, callCwd)` → `"scratch"`; else `"code"`, with `sessionRoot = parser.meta().cwd` and `callCwd = use.cwd`.
  - `PendingUse` gains `cwd: string | null`, set in the `tool_use` case (L515) from `ev.cwd ?? null`.
  - `EditRec` keeps `doc` (every file `"doc"`, unchanged meaning) and gains `/** No code file and not all documentation: scratch files, possibly with documentation (S-20). */ scratch: boolean;` = `!doc && files.every((t) => t.cls !== "code")`.
  - Add one helper `classify(path: string, use: PendingUse): FileTouch["cls"]` and set `cls` on every `FileTouch` built in the three edit branches (Edit/Write via `editTouch`, `bashEditDiff`, shell heuristic).

D3. **Status rule** (`judge()`), exact changes:

```ts
// Git operations, documentation and scratch files need no check (FR-015, S-20): none of them moves the status.
const edits = p.edits.filter((e) => !e.gitOp && !e.doc && !e.scratch);
if (edits.length === 0) {
  const nonGit = p.edits.filter((e) => !e.gitOp);
  if (nonGit.length === 0) return { status: "no-changes", reason: "no edits (git operations only)", outOfScope: new Map() };
  const anyDoc = nonGit.some((e) => e.files.some((t) => t.cls === "doc"));
  const anyScratch = nonGit.some((e) => e.files.some((t) => t.cls === "scratch"));
  const what = anyDoc && anyScratch ? "documentation and scratch files only" : anyScratch ? "scratch files only" : "documentation only";
  return { status: "no-changes", reason: `no code edits (${what})`, outOfScope: new Map() };
}
```

  In the passing branch: `const nonCodeAfter = p.edits.filter((e) => !e.gitOp && (e.doc || e.scratch) && e.seq > lastCompleted.coveredSeq).length;` and the reason uses `last ${nonCodeAfter > 0 ? "code " : ""}edit` instead of the `docsAfter` test (the documentation tail still uses `docsAfter`). The scope-gap file loop skips `f.cls !== "code"` instead of `isDocPath(f.path)`. Every other branch is unchanged; with no scratch file every reason is byte-identical to today.

D4. **Hints**: `evidenceOf` skips files with `cls === "scratch"` (documentation files keep flowing to `computeHints`, which already limits them to `large-change`).

D5. **Shell-heuristic targets**: in the heuristic branch, `const cwd = use.cwd ?? parser.meta().cwd;` replaces `parser.meta().cwd` for `resolveTarget` (the `hasCd` rule stays).

D6. **Python scanner** (`map-extract-py.ts`): replace pre-processing steps 1-2 with one function

```ts
/** Blanks comments and string literals (keeping newlines and offsets) so that only code is matched. */
function blankCommentsAndStrings(src: string): string;
```

  A left-to-right scan with states code / comment / string. In code: `#` starts a comment to the end of the line; `'''` or `"""` starts a triple-quoted string ending at the same three characters; `'` or `"` starts a single-line string ending at the same unescaped quote or at an unescaped end of line. A backslash inside a string skips the next character (a backslash-newline keeps the newline). Every character of a comment or string, including its quotes, becomes a space, except `\r` and `\n`. String prefixes (`r`, `b`, `f`, `u` and combinations) are ordinary code characters before the quote. The output has exactly the input's length. Steps 3-4 (backslash continuation, parenthesised imports) run on its output unchanged.

D7. **Pinned cases**, tests only: background notifications across files (D8 tests) and the existing ordering shapes (already covered by fixtures; no new test needed).

## Working rules for implementers

- Branch `change/status-accuracy-2` in `../lgtm-review-status-accuracy-2`, created by the orchestrator from the wave-3 schema pre-commit (section "Schema pre-commit" of `context/changes/git-crosscheck/plan.md`; S-20 itself needs no schema change). One commit per phase, `feat(status-accuracy-2): phase N — <summary>`; tick Progress in the same commit.
- Node 22, pnpm 11; without `pnpm` on the PATH put `$HOME/.local/opt/node22/bin` first and use `corepack pnpm`.
- Synthetic data only; never read `~/.claude`. Core stays free of Node imports outside `src/node/`: `grep -rln 'from "node:' packages/core/src --include=*.ts | grep -v '/node/\|\.test\.ts\|/testing/'` prints nothing.
- Before every commit: the guard check prints nothing, and `pnpm check` is green. If any existing golden changes, stop and report.
- Do exactly what a phase lists; if something in the code differs from this plan's line numbers or names, follow the names and report the difference in the commit message.

## Phase 0: Baseline on real logs (orchestrator only)

On main before the branch is created; local Claude subagents only; nothing from the logs leaves the machine or enters the repository except counts.

1. `pnpm build`; for each local project: `node scripts/audit-status.mjs --json --dir <repo>`; keep the aggregates.
2. A local subagent rebuilds the 2026-10-23 ground truth (independent extractor from the raw JSONL; status per the PRD rule with the S-11 git-operation, S-16 documentation and S-12 subagent rules) and compares it with `node packages/cli/dist/cli.js --list --json --dir <repo>`.
3. Record in `context/changes/status-accuracy-2/reviews/baseline-<date>.md` only: prompts compared (non-inherited); status match overall, without subagents, with subagents; mismatches per category: C1 edit/check order in one command, C2 shell edit not detected, C3 background check unresolved, C4 Write/Edit to a scratch path counted as code, C5 check command not recognised, C6 other (a generic shape in at most ten words, no names, paths or text).
4. If C5 or C6 has >= 2 prompts, write an amendment phase with synthetic shapes before phase 1 starts; otherwise phases 1-4 run as planned.

## Phase 1: Python comments and strings (core, pure)

Suggested worker: OpenCode. **Files**: `packages/core/src/map-extract-py.ts`, `packages/core/src/map-extract-py.test.ts`.

1. Add `blankCommentsAndStrings` (D6) above `extractPythonImports`.
2. In `extractPythonImports`, replace the two `replace` calls of steps 1-2 with `const withoutComments = blankCommentsAndStrings(source);` and keep steps 3-4 reading `withoutComments`.
3. Tests (new cases in `describe("extractPythonImports")`, each asserting the full `toEqual` result with line numbers):
   - `# use """ for docstrings` on line 1, `import os` on line 2 → `[{ module: "os", names: [], line: 2 }]`;
   - `s = "#"; import json` on line 1 → `json` on line 1;
   - `x = '"""'` on line 1, `import sys` on line 2 → `sys` on line 2;
   - `r"""raw\nimport fake\n"""` (three lines) then `import real` → only `real`, with its line number;
   - `f"{a!r}#not a comment"` then `; import re` on the same line → `re`;
   - an unterminated single-line string `s = "abc` then `import os` on the next line → `os` (the string ends at the end of its line);
   - the existing docstring/comment test (L102-118) still passes unchanged.
4. Every existing test in the file passes unchanged.

### Success Criteria

- `pnpm --filter @lgtm/core exec vitest run src/map-extract-py.test.ts` passes; `pnpm --filter @lgtm/core test` passes with no golden change; guard prints nothing; `pnpm check` green.

## Phase 2: Scratch classifier (core, pure)

Suggested worker: OpenCode. **Files**: `packages/core/src/hints.ts`, `packages/core/src/hints.test.ts`.

1. Add D1 exactly, right after `isDocPath`.
2. Tests: `describe("isScratchPath")` with `test.each` rows `[path, sessionRoot, callCwd, expected]`:

| path | sessionRoot | callCwd | expected |
| ---- | ----------- | ------- | -------- |
| `/tmp/claude-1000/x/scratchpad/a.py` | `/home/u/repo` | `/home/u/repo` | true |
| `/tmp/notes.ts` | `/home/u/repo` | null | true |
| `/var/tmp/a.js` | `/home/u/repo` | null | true |
| `/private/var/folders/ab/T/x.ts` | `/Users/u/repo` | null | true |
| `/home/u/scratch/a.py` | `/home/u/repo` | null | true |
| `/home/u/work/scratchpad/b.go` | `/home/u/repo` | null | true |
| `/home/u/repo/src/a.ts` | `/home/u/repo` | null | false |
| `/home/u/repo/scratch/a.ts` | `/home/u/repo` | null | false (inside the session) |
| `/tmp/repo/src/a.ts` | `/tmp/repo` | null | false (session under /tmp) |
| `/tmp/wt/src/a.ts` | `/home/u/repo` | `/tmp/wt` | false (the call's own directory) |
| `/tmp/x/.claude/worktrees/w/a.ts` | `/home/u/repo` | null | false |
| `/home/u/other-repo/src/a.ts` | `/home/u/repo` | null | false |
| `src/a.ts` | `/home/u/repo` | null | false (relative) |
| `(shell edit)` | `/home/u/repo` | null | false |
| `/tmp/a.ts` | null | null | true |
| `C:\\tmp\\a.ts` | null | null | false |

### Success Criteria

- `pnpm --filter @lgtm/core exec vitest run src/hints.test.ts` passes; `pnpm --filter @lgtm/core test` passes with no golden change; guard prints nothing; `pnpm check` green.

## Phase 3: Analyzer wiring and pinned notification cases (core)

Suggested worker: OpenCode (Sonnet if available). Depends on phase 2. **Files**: `packages/core/src/analyze.ts`, `packages/core/src/analyze.test.ts`.

1. D2: `PendingUse.cwd`, `FileTouch.cls`, `EditRec.scratch`, the `classify` helper, `cls` on all three edit branches, `scratch` at the `edits.push` call (next to `doc`).
2. D3: replace the code-edit filter and the no-code branch with the D3 code; switch the "code " wording to `nonCodeAfter`; the scope-gap loop skips `f.cls !== "code"`.
3. D4: `evidenceOf` skips `t.cls === "scratch"`.
4. D5: heuristic targets use `use.cwd ?? parser.meta().cwd`.
5. Tests, new `describe("scratch files (S-20)")` (builders from `testing/records.ts`; `S = "/tmp/claude-1000/p/s/scratchpad"`; reuse a `withCwd` helper like the one in `describe("scoped checks (FR-017)")`):
   - SX-1: only `edit("e1", `${S}/probe.py`)` → `no-changes`, reason `no code edits (scratch files only)`, `files` has the scratch file, `hints` `[]`.
   - SX-2: a scratch edit and a `README.md` edit → reason `no code edits (documentation and scratch files only)`.
   - SX-3: code edit, `bash("b1", "pnpm test")`, scratch edit → `checked`, reason exactly `pnpm test passed after last code edit`.
   - SX-4: code edit, `pnpm test`, scratch edit, `README.md` edit → reason exactly `pnpm test passed after last code edit; 1 documentation edit after it`.
   - SX-5: code edit and scratch edit, no check → `unchecked`, reason `no checks ran`, hints only `unchecked-edit` on the code file.
   - SX-6: an Edit to `/home/user/other/src/a.ts` (outside the session, not temp or scratch) → still a code edit: `unchecked`, reason `no checks ran`.
   - SX-7: an Edit to `/tmp/wt/src/a.ts` whose tool_use record has `cwd` `/tmp/wt` → code edit (`unchecked`).
   - SX-8: `bash("b1", "sed -i 's/a/b/' src/x.js")` (no diff) from a record with `cwd` `/home/user/project/packages/web` → the file is `/home/user/project/packages/web/src/x.js`.
   - SX-9: regression: only `README.md` → reason `no code edits (documentation only)`; only `diffBash … git merge main` → `no edits (git operations only)`.
   - Pinned notifications, new `describe("background notifications across files (pinned)")`, following the existing test "a background check in a subagent transcript is resolved by a notification in it" (`createAnalyzer()`, push the parent lines, `a.addSubagent("ag", subLines, { agentId: "a1", description: "helper" })`, `a.finish()`). The builders number timestamps in creation order, so create the lines in chronological order: parent head, then the subagent lines, then the parent tail.
     - BN-1: head = `prompt("go")`, `...edit("e1")`, `toolUse("ag", "Agent", { description: "helper" })`; sub = `prompt("task")`, `...bgBash("sb", "bg1", "pnpm test")`; tail = `toolResult("ag", "done")`, `taskNotification({ taskId: "bg1", status: "completed", summary: "Background command \"pnpm test\" completed (exit code 0)" })` → `checked`, reason exactly `pnpm test passed after last edit (by subagent helper)`.
     - BN-2: head = `prompt("go")`, `...edit("e1")`, `...bgBash("b1", "bg1", "pnpm test")`, `toolUse("ag", "Agent", { description: "helper" })`; sub = `prompt("wait")`, `taskNotification({ taskId: "bg1", status: "completed", summary: "Background command \"pnpm test\" completed (exit code 0)" })`; tail = `toolResult("ag", "done")` → `checked`, reason exactly `pnpm test passed after last edit`.
     - If either test fails, the expected behaviour above is the specification: fix the analyzer (not the test) and report it in the commit message.
6. Every existing test passes unchanged.

### Success Criteria

- `pnpm --filter @lgtm/core test` passes **without** `-u`; `git status --porcelain packages/core/fixtures` prints nothing; node-free grep and guard print nothing; `pnpm check` green.

## Phase 4: Fixture and goldens (core + CLI goldens)

Suggested worker: OpenCode. The only wave-3 phase that writes golden files.

**Files**: new `packages/core/fixtures/sessions/scratch-edits.jsonl`, `scratch-edits.labels.json`, and the four new goldens `__golden__/scratch-edits.{analysis.json,steps.json,diffs.json,summary.md}`.

Write the fixture in the exact record shape of `doc-edits.jsonl` (same keys and order, uuid and timestamp sequence, `cwd` `/home/user/project`, `gitBranch` `main`); scratch dir `S = /tmp/claude-1000/project/session/scratchpad`:

| # | Prompt text | Actions | Expected status, reason | Hints | Recommendation |
| - | ----------- | ------- | ----------------------- | ----- | -------------- |
| 0 | `Probe the parser in a scratch file.` | Write `S/probe.py` (create) | `no-changes`, `no code edits (scratch files only)` | `[]` | `skim` |
| 1 | `Fix add, test, then note results in scratch.` | Edit `src/add.js`; Bash `pnpm test` → `Tests: 3 passed`; Write `S/results.txt` (create) | `checked`, `pnpm test passed after last code edit` | `[]` | `skim` |
| 2 | `Draft in scratch and update the README.` | Write `S/draft.ts` (create); Edit `README.md` | `no-changes`, `no code edits (documentation and scratch files only)` | `[]` | `skim` |
| 3 | `Change sub without testing; keep a scratch copy.` | Edit `src/sub.js`; Write `S/sub.backup.js` (create) | `unchecked`, `no checks ran` | `["unchecked-edit:src/sub.js"]` | `read-flagged` |

Labels: `expectedStatus`, `expectedRecommendation`, `expectedHints` (paths relative to `/home/user/project/`), one-line `note`. Goldens: `pnpm build`, then `pnpm --filter @lgtm/core test -- -u` and `pnpm --filter lgtm-review test -- -u` (fallback `pnpm --filter <pkg> exec vitest run --exclude '**/*.perf.test.ts' -u`). `git status --porcelain packages/core/fixtures` must list exactly the two fixture files and the four `scratch-edits.*` goldens.

### Success Criteria

- Golden and label tests pass (status match reports no misses); exactly the six new files under `packages/core/fixtures/`; `pnpm check` green; guard prints nothing.

## Phase 5: After-audit, README, docs (orchestrator only)

1. Real-log audit after the merge, as in phase 0 (counts only): status match overall / without subagents / with subagents, mismatch categories, and the PRE→POST status transition counts (only `unchecked → no-changes` and `unchecked → checked` are expected from the scratch rule; anything else is investigated before archiving). Record in `reviews/audit-<date>.md`; state plainly whether >= 97% overall was reached.
2. Paste into `packages/cli/README.md`, "Status accuracy and limits", after "Documentation edits": `- **Scratch files.** Files written outside the session's directory in a temporary or scratch location (\`/tmp\`, \`/var/tmp\`, macOS \`/var/folders\`, or a folder whose name starts with \`scratch\`, such as Claude Code's own scratchpad) are listed but need no check, like documentation: a prompt that only wrote such files is "no changes" ("no code edits (scratch files only)"), and they get no review hints. Files in the tool call's own working directory or in a \`.claude/worktrees/\` folder are never scratch.`; in "Import map", append to the bullet that starts "Extraction is a regular-expression scan": "In Python files, comments and string literals are blanked before matching."
3. PRD: a decision bullet "Decision (S-20): scratch files (as above) are treated like documentation edits" with the measured numbers; roadmap S-20 → done; archive.

## Progress

### Phase 0: Baseline (orchestrator)

- [ ] 0.1 baseline counts recorded; amendment decided

### Phase 1: Python scanner

- [x] 1.1 `blankCommentsAndStrings` + tests; `pnpm check` green

### Phase 2: Scratch classifier

- [x] 2.1 `isScratchPath` + table; `pnpm check` green

### Phase 3: Wiring and pinned cases

- [ ] 3.1 classes, status rule, hints, call cwd; SX-1..SX-9, BN-1..BN-2; no golden change; `pnpm check` green

### Phase 4: Fixture and goldens

- [ ] 4.1 `scratch-edits` fixture + labels + four new goldens only; `pnpm check` green

### Phase 5: Orchestrator

- [ ] 5.1 after-audit recorded
- [ ] 5.2 README, PRD, roadmap, archive
