# Review hints and markdown summary (S-05) Implementation Plan

## Overview

Per prompt, compute deterministic hints ("look here") and a recommendation (Skim / Read flagged / Read all); show them in the web prompt table and Steps view; add `lgtm-review --summary` printing markdown for a PR description. FR-009, FR-010.

## Current State Analysis

- Core analysis (`packages/core/src`): `analyze.ts` (status, files with kind and line deltas, timing), `steps.ts`/`diff.ts` in detail mode (steps with phases incl. Fix, per-file diffs from log patches, caps), `check-patterns.ts`, schemas in `schema.ts`. `PromptAnalysis` has no hints. List endpoint returns `SessionAnalysis` (small); detail endpoint returns `PromptDetail`.
- Web: `PromptTable.tsx` (status, reason, time bar, files), `StepsView.tsx`/`StepCard.tsx`, text-only rendering rule with a scanning test, contrast tests on `styles.css`.
- CLI: `--list`, `--json`, server mode; README sections exist.
- Rules: `docs/PROPOSAL.md` §9.7 (table of 9 rules + recommendation) and decisions below.

## Desired End State

- `PromptAnalysis` gains `hints: Hint[]` and `recommendation: "skim"|"read-flagged"|"read-all"`; `Hint {rule, severity: "high"|"warn"|"info", path|null, reason}`. Computed in the default analysis (no detail mode needed): the parser records, per successful edit, only small counters (path, phase at time of edit incl. whether it was a Fix, added/removed assertion-like lines, added skip markers, lines changed) so memory stays bounded and existing goldens change only by the two new fields.
- Rules (deterministic, evidence in reason text):
  - `test-modified-during-fix` (high): a test file edited while in the Fix phase (after a failed check, before the next passing one).
  - `assertions-removed` (high): in test files, removed assertion lines (`expect(`, `assert`, `assertEquals`, `self.assert`, `should`) exceed added ones in the prompt.
  - `test-skipped` (high): added lines matching `.skip(`, `xit(`, `xdescribe(`, `it.todo`, `test.todo`, `@pytest.mark.skip`, `@pytest.mark.xfail`, `t.Skip(`, `@Disabled`.
  - `sensitive-path` (high): path matches `sensitive` globs: `auth`, `login`, `password`, `secret`, `token`, `credential`, `.env`, `migrations/`, `migrate`, `.github/workflows/`, `Dockerfile`, `permissions`, `security`; (case-insensitive path segments/substrings listed in a constant).
  - `unchecked-edit` (warn): a file whose last edit came after the last completed check (status-consistent with the prompt's `unchecked`).
  - `dependency-change` (warn): edits to `package.json` dependencies sections can't be parsed cheaply, so any edit to a manifest/lockfile (`package.json`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`).
  - `public-surface` (warn): edit to `index.ts|js` at package root level or paths containing `routes/`, `api/`, `openapi`, `schema`.
  - `config-change` (info): `tsconfig*.json`, eslint/biome/prettier configs, vite/webpack/rollup/tsup configs, CI files.
  - `large-change` (info): > 300 changed lines (added + removed) in one file within the prompt.
  - Test file = path segment `test`/`tests`/`__tests__`/`spec` or name matching `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`.
- Recommendation: any `high` hint -> `read-all` if >= 3 distinct high hints else `read-flagged`; only warn/info -> `skim`; no hints -> `skim`; `no-changes` prompts -> `skim`.
- Web: prompt table gets a "Review" column: recommendation label (text) and, per flagged file, an orange marker with rule name; expanded row lists hints (severity, rule, path, reason). Steps view gets a "Where to look" block (top 5 hints by severity then path) above the steps. All as text nodes.
- CLI: `lgtm-review --summary [--session <id-prefix>]` prints markdown: title, branch, date; table of prompts (index, status, recommendation, 80-char title, files count, +/-); under each non-checked or flagged prompt a bullet list of reason and hints (rule, path); a footer line stating statuses are heuristic. No command output, no file contents, no full prompt text. Exit 0. `--summary` conflicts with `--list`/`--json` (exit 1 with message).

## What We're NOT Doing

- No import map, no "Play the change", no HTML export, no LLM, no per-line parsing of manifests (dependency rule is path-based), no configuration of sensitive globs (constant list, documented), no summary in the web UI (CLI only), no changes to status rule or time model.

## Implementation Approach

Three phases: (1) core hints + recommendation with goldens, (2) web display, (3) CLI summary + docs + smoke.

## Critical Implementation Details

- Evidence collection happens in the parser/analyzer while streaming; per edit only counters, never lines. Assertion/skip counting uses the lines of `structuredPatch`/Write create content that the parser already sees (apply cap: first 2000 lines per edit).
- Phase of an edit reuses the S-02/S-03 shared classifier (Fix = work started while last completed check failed).
- Hints are deduplicated per (rule, path), sorted by severity (high, warn, info), then rule, then path; deterministic.
- `PromptAnalysis` zod schema gains the two fields (required); web and CLI parse with updated schemas; goldens regenerated; status-match test unchanged.
- Markdown output escapes `|` and backticks/newlines in titles and paths; length caps (title 80 chars, paths as is); summary never includes `reason` text containing command output beyond what `reason` already holds (200 chars of failing excerpt is allowed? NO: use only the first word set `"<command> failed"`; do not include the excerpt).

## Phase 1: Core hints

**Files**: `packages/core/src/hints.ts` (rules, classifiers), `analyze.ts`/`parse.ts` (counters), `schema.ts` (`Hint`, `Recommendation`, fields on `PromptAnalysis`), `index.ts` exports, tests (table-driven >= 30 cases for classifiers and each rule positive/negative), new synthetic fixtures (test edited during fix, assertions removed, skip added, sensitive path, manifest edit, large change) + labels + goldens; existing goldens regenerated (only new fields change).

### Success Criteria

- `pnpm check` green; node-free grep rule empty; determinism test; existing status-match 100%

## Phase 2: Web display

**Files**: `packages/web/src/{PromptTable,StepsView,viewmodel,styles.css}` (+ new component for hints) and tests.

**Contract**: as Desired End State; recommendation label has text + icon-free styling distinguishable without color; contrast tests extended; innerHTML scan covers new files; malicious-string render test for hint reasons and paths.

### Success Criteria

- `pnpm check` green; reviewer sees screenshots (light/dark) of table and Where-to-look

## Phase 3: CLI summary, docs, smoke

**Files**: `packages/cli/src/{cli,summary}.ts` + tests, `packages/cli/README.md`, `scripts/smoke-pack.mjs` (run `--summary` on a fixture, assert key lines and absence of command output), root README.

### Success Criteria

- `pnpm check` green incl. smoke; markdown escaping tests; tarball < 2 MB

## Progress

### Phase 1: Core hints

- [x] 1.1 `pnpm check` green, node-free grep empty, determinism
- [x] 1.2 Goldens reviewed (new fields only; verified by script: 11 existing analysis goldens differ only by `hints`/`recommendation`, steps and diffs goldens unchanged; orchestrator may re-check)

### Phase 2: Web display

- [x] 2.1 `pnpm check` green incl. scans and contrast (PromptDetail also carries hints and recommendation, so a Steps deep link needs no session data)
- [ ] 2.2 Screenshots reviewed

### Phase 3: CLI summary

- [x] 3.1 `pnpm check` green incl. smoke (--summary on packed CLI)
- [ ] 3.2 Summary reviewed on a real local session (not committed)

## Plan-review amendments (accepted by orchestrator, 2026-10-23)

- D1 (blocking): recommendation also considers prompt status: `failing` or `unchecked` => at least `read-flagged`; `read-all` when >= 3 distinct high RULES (not instances), or status `failing` with any high hint.
- D2: `assertions-removed` counts only `\b(expect|assert[A-Za-z0-9_]*)\s*\(`, `self\.assert[A-Za-z0-9_]*\s*\(`, `\.\s*should\b`, `\brequire\.(equal|ok)`; plain `should` in test titles is NOT counted.
- D3: `sensitive-path` matches whole path segments or file names (not substrings): segments `auth`, `authentication`, `authorization`, `login`, `secrets`, `secret`, `credentials`, `tokens`, `token`, `migrations`, `migrate`, `permissions`, `security`, files `.env*`, `Dockerfile*`, path prefix `.github/workflows/`; explicit exclusions: `design-tokens`, `tokenizer`, `author*`, `*.css`; test files get `sensitive-path` only for the non-test part rules (a test named `auth.test.ts` still counts because it touches auth: keep it, severity high only when the path is NOT a test file, otherwise warn).
- D4: evidence collection streams lines and keeps only counters; add a perf regression check: the existing 20 MB perf tests (list + detail) must stay under their limits and the S-01 20 MB analyze test must not exceed 1.5x its current logged time (record the before/after times in the report).
- D5: `--summary` redacts title text: tokens/keys patterns (`sk-ant-`, `sk-...`, `ghp_`, `github_pat_`, `AKIA...`, `Bearer <x>`, long hex/base64-like strings >= 32 chars, `password=...`) replaced by `[redacted]`; flag `--no-titles` omits titles entirely (prompts shown as "Prompt N"). Test both.
- D6: threshold wording: see D1.
- D7 (rejected): no backward compatibility needed, analysis JSON is not persisted; fields stay required.
- D8: Phase 2 adds RTL-free render tests asserting the recommendation label text and `aria` attributes; Phase 3 adds a golden markdown test (`fixtures/.../*.summary.md`) for the synthetic scenarios, byte-exact. Manual items 2.2 and 3.2 are performed by the orchestrator in addition.
