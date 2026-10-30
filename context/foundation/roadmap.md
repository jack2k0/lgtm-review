---
project: lgtm-review
version: 1
status: draft
created: 2026-10-23
updated: 2026-10-25
prd_version: 3
main_goal: speed
top_blocker: time
---

# Roadmap: lgtm-review

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Framing assumptions

The owner delegated every roadmap decision (2026-10-23); no interview was run. Each anchor below is the skill's Recommend option, recorded here so the owner can override any line by editing this file.

- **Sequencing goal: `speed`.** Owner priority "browser as soon as possible" (`context/ORCHESTRATION.md`), MVP scoped down to S-01..S-03, and the PRD Success Criterion "a first browser view of a real session is reachable early". Alternative considered: `market-feedback` — reasonable since the primary user is the owner, but the order of slices would be the same.
- **North star: S-02** (sessions and prompts with statuses in the browser). It is the first point where the primary Success Criterion (find all `unchecked` / `failing` prompts in < 2 minutes in the browser) can be measured. Alternative considered: S-01 (statuses in the terminal) — rejected because the owner called the terminal list a by-product, not a goal.
- **Main risk: `time`.** ~5 h/week after-hours, 7-week MVP vs the 3-week default (PRD Open Question 4). Alternative considered: `skills` (undocumented session-log format) — handled as an S-01 Unknown instead.
- **Investment:** deep in the session-log parser and status rule (data layer: ≥ 95% status match, reproducible output, no crash on unknown records) and in the local server's safety properties (local-only access, no markup rendering). Frontend and infra stay simple. Derived from PRD Success Criteria + NFRs.
- **Post-MVP IDs S-04..S-10 are reserved, not planned.** The owner's decisions reference S-08 (LLM layer, where the default-model question gets decided) and S-09 (Python, v0.2). Those features are PRD Non-Goals for the MVP, so per the "every slice traces to a PRD requirement" rule they live in `## Parked` with their reserved IDs (numbering from `docs/PROPOSAL.md` §17) until the PRD is extended.
- **F-01 covers only the foundation work that remains.** The pnpm/Turborepo monorepo with core/cli/web is already scaffolded and green (`context/changes/bootstrap-verification/verification.md`); F-01 does not re-scaffold it.

## Vision recap

An AI agent changes 6–60 files in about 15 minutes, but a reviewer sees only the final diff, file by file — not the order of work, what broke along the way, or whether checks ran after the last edit. That information sits in the session log nobody reads. lgtm-review turns a Claude Code session log into levels (sessions → prompts with a verification status → steps → diff) so the reviewer descends into code only where a prompt is `unchecked` or `failing`.

## North star

**S-02: Developer can open a session in the browser and see every prompt with its status, reason, time split and file counts** — the slice whose delivery lets the owner measure the primary Success Criterion on a real session, and the earliest browser view the owner asked for.

> "North star" here means the smallest end-to-end slice whose successful delivery proves the product works for its user — it is placed as early as its prerequisites allow, because everything after it only matters if it works.

## At a glance

| ID   | Change ID             | Outcome (user can …)                                                                                     | Prerequisites | PRD refs                                    | Status   |
| ---- | --------------------- | -------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------- | -------- |
| F-01 | foundation-scaffold   | (foundation) CI, packaging smoke test, clean dev audit and a fixture corpus are in place                 | —             | NFR reproducible statuses, NFR no failure on unknown records, Guardrail no fixture secrets, Success Criterion ≥ 95% status match on fixture corpus | done     |
| S-01 | parser-statuses       | Developer can run one terminal command and see the repo's sessions and each prompt's status, reason and changed files | F-01          | US-01, FR-001, FR-002, FR-004               | done     |
| S-02 | web-sessions-prompts  | Developer can start one command, open a session in the browser and see prompts with status, reason, time split and file counts | S-01          | US-01, FR-001, FR-003, FR-007               | done     |
| S-03 | steps-and-diff        | Developer can open a prompt's Steps view, expand raw actions and click a changed file to see its diff    | S-02          | US-02, FR-005, FR-006, FR-007               | done     |

## Baseline

What's already in place in the codebase as of `2026-10-23` (auto-researched; owner delegated confirmation).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** partial — `packages/web` (Vite + React) renders a placeholder title from the shared schema (`packages/web/src/main.tsx`); no views.
- **Backend / API:** partial — `packages/cli` bundles core and prints a version (`packages/cli/src/cli.ts`); no session reading, no local server.
- **Data:** partial — `packages/core` exports a stub `Story` schema (`id`, `title`) with one test (`packages/core/src/index.ts`); no log parser, no status rule.
- **Auth:** absent — not needed beyond per-run local access protection (PRD §Access Control), which belongs to S-02.
- **Deploy / infra:** partial — pnpm workspaces + Turborepo, `pnpm check` (typecheck + test + build) green 9/9 per `context/changes/bootstrap-verification/verification.md`; no CI workflow, no packaging smoke test; 6 dev-only audit findings (vitest 3.x, esbuild via tsup).
- **Observability:** absent — by design (PRD: no telemetry); user-facing warnings for skipped log records arrive with S-01.

## Foundations

### F-01: Finish the foundation (CI, packaging smoke, audit, fixtures)

- **Outcome:** (foundation) the dev audit is clean (test runner bumped to ≥ 4.1.12), CI runs the repo check on Node 22 and 24, the repo check also packs the published package and runs it via `npx` as a smoke test, and a small anonymized session-fixture corpus with a golden-test harness exists.
- **Change ID:** foundation-scaffold
- **PRD refs:** NFR reproducible statuses, NFR no failure on unknown records, Guardrail no fixture secrets, Success Criterion ≥ 95% status match on fixture corpus
- **Unlocks:** S-01 (fixture corpus + golden-test harness is the verification path for the ≥ 95% status-match criterion); S-01..S-03 (CI and packaging smoke test prove each slice still ships as one `npx` command).
- **Prerequisites:** — (monorepo scaffold already present per Baseline)
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** sequenced first because every later slice is verified against fixtures and the packaged CLI; risk is over-building the fixture corpus here — keep it to a seed set that S-01 grows after its log-format spike.
- **Status:** done (2026-10-23)

## Slices

### S-01: Session statuses in the terminal (thin parser)

- **Outcome:** Developer can run one terminal command in a repo and see its Claude Code sessions, and for each prompt a status (checked / unchecked / failing / no-changes) with a reason and the changed files with markers and line deltas; unknown records are skipped and listed as warnings.
- **Change ID:** parser-statuses
- **PRD refs:** US-01, FR-001, FR-002, FR-004
- **Prerequisites:** F-01
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Which session-log edge cases (command exit format, compaction, resume, subagents, interrupts, parallel tool calls) must the parser handle? Resolve via a read-only scan of 10–20 real local sessions at plan start. — Owner: team. Block: no.
  - How are the repo's own test/check scripts auto-detected so real checks are not misread as missing? — Owner: team. Block: no.
- **Risk:** this tests the riskiest assumption — the one belief that, if wrong, makes the product useless — (that the status rule can be computed reliably from the log), so it goes first; keep it thin — terminal output is a by-product, the browser is the goal.
- **Status:** done (2026-10-23)

### S-02: Sessions and prompts in the browser (north star)

- **Outcome:** Developer can start the tool with one command, open a session in the browser and see each prompt's status dot, reason, title, approximate active-time split (Read / Write / Check / Fix) with a headline, and changed-file counts.
- **Change ID:** web-sessions-prompts
- **PRD refs:** US-01, FR-001, FR-003, FR-007
- **Prerequisites:** S-01
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - How is the local UI kept reachable only by the person who started it (other pages in the same browser cannot read sessions), while staying a single command? — Owner: team. Block: no.
  - Does a 20 MB session open in < 3 s end to end, or does the parser need work first? — Owner: team. Block: no.
- **Risk:** the first browser view is the owner's top priority, so it follows S-01 immediately; the UI may be built against the S-01 output contract and fixtures, but must land on real sessions to count. Security properties (local-only, no markup rendering of log content) are part of this slice, not deferred.
- **Status:** done (2026-10-23)

### S-03: Steps and diff for a prompt

- **Outcome:** Developer can open a prompt's Steps view with ordered steps (phase, check command + result, agent quotes), expand any step to its raw actions, and click a changed file to see a unified diff labelled "agent edits, not final git state".
- **Change ID:** steps-and-diff
- **PRD refs:** US-02, FR-005, FR-006, FR-007
- **Prerequisites:** S-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Edits made through shell commands, removals and moves may be missing from the log; how is "may be incomplete" shown on a diff? — Owner: team. Block: no.
- **Risk:** depends on the S-02 browser shell; closes the MVP. Keep the diff minimal (unified, no split view, no custom highlighter) so the 7-week budget holds.
- **Status:** done (2026-10-23)

### S-05: Review hints and markdown summary (v0.2)

- **Outcome:** Developer sees per-prompt deterministic review hints with a Skim / Read flagged / Read all recommendation in the prompt table and a "Where to look" block in Steps, and can run `lgtm-review --summary` to get a markdown summary for a PR description.
- **Change ID:** review-hints
- **PRD refs:** FR-009, FR-010 (PRD v2 extension)
- **Prerequisites:** S-03
- **Status:** done

### S-10: Live refresh in the browser (v0.2, reduced scope of the parked S-10)

- **Outcome:** Developer keeps the UI open during a running session and sees sessions, prompts, steps and diffs update within ~5 s, without reload; no updates while the tab is hidden.
- **Change ID:** live-refresh
- **PRD refs:** FR-011 (PRD v2)
- **Prerequisites:** S-03
- **Status:** done

### S-06: Static HTML export with secret redaction (v0.2)

- **Outcome:** Developer runs `lgtm-review --export <session-prefix> [--out file.html] [--no-diffs]` and gets one self-contained, script-free HTML file (prompts with status, hints, time split, steps, optional diffs) with secrets redacted, to attach to a PR or send to a colleague.
- **Change ID:** html-export
- **PRD refs:** FR-008 (nice-to-have, promoted by orchestrator in PRD v2 for the sharing use case), Guardrail "no data leaves the machine" (the file is written only on explicit command)
- **Prerequisites:** S-03, S-05
- **Status:** done

### S-11: Status accuracy on real logs (v0.2)

- **Outcome:** Status match on the owner's real local sessions rises from 90.8% to >= 95% (audit 2026-10-23, `context/changes/status-accuracy/audit-2026-10-23.md`): verify-style scripts and more check commands are recognized, slash-command turns become prompts, masked exits no longer produce false `checked`, shell edits without `bashEditDiff` are no longer invisible, syntax-only and git-operation noise is ignored.
- **Change ID:** status-accuracy
- **PRD refs:** Success Criterion "status matches manual verification in >= 95% of turns"; NFR reproducible statuses
- **Prerequisites:** S-03
- **Status:** done (real-log audit: status 97.1%, reason 97.1% without subagent prompts; 94.5% / 87.4% overall)
- Deferred from the audit to later slices: subagent transcripts merged into prompts (S-12), fork/resume dedupe across files (S-13), background-task completion mapping (S-14).

### S-12: Subagent activity inside prompts (v0.2)

- **Outcome:** Edits and checks performed by subagents (`Agent` tool) count toward the parent prompt's status, files, time split, steps and hints; the "subagent activity not analysed" hedge disappears when the subagent transcript is found. Target: overall status match >= 97% on the owner's real logs (audit after S-11: 94.5% overall vs 97.1% without subagent prompts).
- **Change ID:** subagent-prompts
- **PRD refs:** FR-002, FR-004, FR-005; Success Criterion status match >= 95%
- **Prerequisites:** S-11
- **Status:** done (real-log audit: overall 95.3%, subagent prompts 19/22)

### S-13: Fork/resume duplicates marked and excluded from counts (v0.2)

- **Outcome:** Prompts a session inherited from an earlier session (resume/fork copies history with the same prompt `uuid`) are marked "inherited from <session>", shown collapsed in the UI, and excluded from the session's status counts and from `--summary`/export totals, so the same unchecked prompt is not counted twice.
- **Change ID:** fork-dedupe
- **PRD refs:** FR-001, FR-002 (accuracy of status counts); audit 2026-10-23: 15 of 109 rows (13.8%) were fork duplicates
- **Prerequisites:** S-03
- **Status:** done (2026-10-23; 2A Sonnet subagent, 2B OpenCode+Haiku)

### S-14: Background checks resolved from task notifications (v0.2)

- **Outcome:** A check started with `run_in_background` is no longer stuck as "check did not complete": its later `<task-notification>` (matched by tool-use id or background task id) supplies completion and exit code, so the prompt that issued it gets checked/failing like a foreground check. Audit 2026-10-23: 57 background checks by ground truth, 26 seen; `gh run watch`/`verify` stayed "incomplete".
- **Change ID:** bg-checks
- **PRD refs:** FR-002 (status accuracy); Success Criterion status match >= 95%
- **Prerequisites:** S-11
- **Status:** done (2026-10-23; core Sonnet, consumers Haiku, plan-review OpenCode Big Pickle). Real-log audit done (`context/archive/bg-checks/audit-2026-10-23.md`: 3/130 prompts unchecked -> checked, "check did not complete" 4 -> 1)

### S-04: Import map (2D, reduced) (v0.2)

- **Outcome:** Developer can open a 2D layered architectural map for a session or individual prompt showing modified TS/JS files and their direct in-repo import neighbours (1 hop both directions, max 150 nodes) from the current working tree snapshot, grouped into horizontal layers by top-level directory or package, with status-coloured nodes linking directly to file diffs.
- **Change ID:** import-map
- **PRD refs:** FR-012
- **Prerequisites:** S-03
- **Status:** done (2026-10-23; draft plan Agy/Gemini, core+web OpenCode Big Pickle, API Sonnet, merge fix Agy)

## v0.3 extension (proposed 2026-10-25)

> Orchestrator proposal on the owner's delegation (2026-10-25). Derived from PRD v3 (`context/foundation/prd.md`, section "v0.3 Extension": FR-015..FR-020, v3 NFRs, v3 success criterion). Every MVP and v0.2 slice is done and `pnpm check` is green on main (cfc57ff). Owner-only actions are not slices: git push, npm publish, GitHub Pages hosting of the demo, the name/trademark check and credit for the idea author.

### Framing (v0.3)

- **Sequencing goal: reviewer value on real sessions per hour of work.** Deterministic and local-only first; the only model call in the batch (S-08) is opt-in, loopback-only and gated on owner decisions.
- **Evidence used.** Real-log audits of 2026-10-23 (130 own prompts after fork dedupe: 50 unchecked, 17 checked, 3 failing, 60 no-changes; status match 95.3% overall, 97.1% without subagents, 19/22 subagent prompts; the empty-`bashEditDiff` fix 66a00af was not in the audited build and was never re-measured); the owner's own agent workflow, where implementation phases end by ticking `plan.md` after the check (phase commits 2e8588a, 655e616, 576ca8b, 4555a16 all carry a `plan.md` change), which the current rule reports as `unchecked`; the PRD primary success criterion (find all unchecked/failing prompts in < 2 minutes); the persona (parallel worktrees).
- **Order.** Cut status noise at the source (S-16), then speed up triage in the browser (S-17), then make `checked` more honest (S-18), then breadth (S-19 worktrees), accuracy follow-ups (S-20) and the git cross-check (S-21). S-08 waits for the owner.
- **Sizes** assume agent implementation with orchestrator review: S ≈ one sitting (1–2 phases), M ≈ 3–4 phases, L ≈ 5+ phases or an open design question.

### At a glance (v0.3)

| ID   | Change ID         | Outcome (user can …)                                                                                                          | Size | Prerequisites              | Parallel with                | PRD refs                       | Status                  |
| ---- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------- | ---------------------------- | ------------------------------ | ----------------------- |
| S-16 | doc-edits         | see prompts that only edited documentation as needing no check, and keep `checked` when only docs changed after the check   | S    | —                          | S-17                         | FR-015                         | done |
| S-17 | prompt-triage     | narrow sessions and prompts to "needs attention" and move through prompts with the keyboard                                   | M    | —                          | S-16                         | FR-016, NFR keyboard           | done |
| S-18 | scoped-checks     | see a `check-scope` hint when the check behind `checked` ran only on part of the repository                                   | M    | S-16                       | S-19 (schema-first rule)     | FR-017                         | done |
| S-19 | worktree-sessions | see the sessions of every git worktree of the repository in one list                                                          | M    | S-17                       | S-18 (schema-first rule), S-20 | FR-018, NFR read-only git    | done |
| S-20 | status-accuracy-2 | rely on >= 97% status match on real logs (in-command order, background notifications, scratch files, Python comments)         | M    | S-18                       | S-19, S-21                   | FR-002, FR-004, FR-013, SC v3  | done |
| S-21 | git-crosscheck    | compare what a session's prompts edited with what git shows for that directory                                                | M    | S-19                       | S-20                         | FR-019, NFR read-only git      | done |
| S-08 | llm-titles        | opt in to one-sentence prompt titles from a local model server (loopback only)                                                | L    | S-17 + owner decisions     | —                            | FR-020, NFR loopback LLM       | done (2026-10-28, 6e9118e) |

Waves: **1** S-16 ‖ S-17 → **2** S-18 ‖ S-19 → **3** S-20 ‖ S-21 → **gated** S-08.

### Parallel work rules (v0.3)

1. At most two slices in flight (one person reviews). Each runs in its own worktree `../lgtm-review-<change-id>` on branch `change/<change-id>`.
2. **Schema-first rule.** `packages/core/src/schema.ts` is edited by at most one in-flight branch. When two in-flight slices both need schema members (wave 2: S-18 adds the `HintRule` value `check-scope`, S-19 adds optional `worktree` fields to `SessionSummary` and `SessionAnalysis`; likewise S-17 `SessionSummary.attentionCount` with S-18 if S-18 starts before S-17 merges), the orchestrator lands both additions on main in one small commit before either branch starts, and implementers do not touch `schema.ts` in their branches. Within one slice, schema changes land in its first phase and later phases or helper branches rebase on it and never re-add them (the S-04 merge produced duplicate keys because two branches added the same members).
3. **Goldens.** `packages/core/fixtures/sessions/__golden__/` is regenerated by S-16, S-18 and S-20 (and `*.summary.md` by the CLI tests for every fixture); these three never run in parallel. A slice that is not supposed to change goldens fails its phase if any golden changes.
4. **Dependencies.** Only S-17 adds a package (a dev-only DOM library for web tests); no other branch may change `package.json` or `pnpm-lock.yaml` while S-17 is in flight.
5. **Shared docs.** `packages/cli/README.md` gets each slice's text in that slice's last phase, in its own section; `context/foundation/prd.md` and `roadmap.md` are edited only by the orchestrator on main after a merge.

Files each slice is expected to touch (for the parallel check):

| Slice | Core analysis (`analyze`, `hints`, `check-patterns`, `shell-edits`, `parse`) | `schema.ts` | Goldens | Core node IO | CLI (`packages/cli/src`) | Web (`packages/web/src`) | Deps |
| ----- | ---------------------------------------------------------------------------- | ----------- | ------- | ------------ | ------------------------ | ------------------------ | ---- |
| S-16 | `analyze.ts`, `hints.ts` | — | yes | — | `audit-status.test.ts` (+ `scripts/audit-status.mjs`) | — | — |
| S-17 | new `attention.ts` (+ one appended export in `index.ts`) | `SessionSummary.attentionCount` (optional) | — (summary output byte-identical) | — | `api.ts` (`summarize`), `api.test.ts`, `summary.ts` (shared rule) | `PromptTable`, `SessionList`, `App`, `viewmodel`, new `triage.ts`, `styles.css`, `testing/`, new DOM tests | dev: `jsdom@30.1.2` (exact) |
| S-18 | `check-patterns.ts`, `parse.ts`, `analyze.ts`, `hints.ts`, new `scope.ts` | `HintRule` `check-scope` (orchestrator pre-commit) | yes, only new `scoped-checks.*` | — | `audit-status.test.ts` (+ script) | — | — |
| S-19 | — | `worktree` (optional; orchestrator pre-commit) | — | new `worktrees.ts`, `discover.ts`, `node/index.ts` | `cli.ts`, `api.ts`, `export.ts`, `format.ts`, `server.ts` (+ new tests) | `SessionList`, `viewmodel`, `PromptTable`, `App`, new `worktree.ts` | — |
| S-20 | `analyze.ts`, `hints.ts`, `map-extract-py.ts` | — | yes, only new `scratch-edits.*` | — | — | — | — |
| S-21 | — | `GitFileEntry`, `GitCrosscheckResponse` (orchestrator pre-commit) | — | new `git.ts`, `node/index.ts` | `api.ts` (new route) + new test | new `GitView`, `App`, `viewmodel`, `api.ts` | — |
| S-08 | — | new response type | — | new cache | flags, `api.ts` route | `PromptTable` | — |

### S-16: Documentation-only edits need no check

- **Outcome:** Developer sees a prompt that only edited documentation (Markdown, reStructuredText, AsciiDoc, and README/LICENSE/CHANGELOG-style files) as `no-changes` with the reason "no code edits (documentation only)" instead of `unchecked`, and a prompt whose passing check was followed only by documentation edits stays `checked` ("pnpm test passed after last code edit; 1 documentation edit after it"); the files stay in the file list, steps and diffs; documentation files get no verification hints (`unchecked-edit`, `sensitive-path`, `public-surface`, test rules), only `large-change`.
- **Change ID:** doc-edits
- **Size:** S
- **PRD refs:** FR-015 (PRD v3), FR-002; Business Logic decision (S-16)
- **Prerequisites:** — (all v0.2 slices done)
- **Parallel with:** S-17 (disjoint files: core analysis + goldens vs web)
- **Blockers:** —
- **Unknowns:**
  - How many of the owner's real `unchecked` prompts are documentation-only or end with documentation edits after a passing check? Measured by the PRE/POST aggregate audit in the slice's last phase (local Claude only, counts only). — Owner: orchestrator. Block: no.
- **Risk:** low; core-only, no schema or UI change. It changes the status rule, so the decision is recorded in the PRD next to the S-11 git-operation decision; `.mdx`, `.txt` (except the named files) and unknown shell-edit targets stay code. Plan: `context/changes/doc-edits/plan.md`.
- **Status:** done (2026-10-25; phases Haiku/Sonnet/Haiku, 0 fixes; real-log audit: 19 of 159 prompts changed status, 18 of them out of `unchecked`, `context/archive/doc-edits/reviews/audit-2026-10-25.md`)

### S-17: Triage in the browser ("needs attention" and keyboard)

- **Outcome:** Developer narrows the prompt table to prompts that need attention (unchecked, failing or with review hints, the same rule as the summary's "Needs attention" section) with one click, sees "N need attention" in the session header and per session in the list (with the same filter there), moves between prompt rows with ↑/↓, expands a row with Enter, opens Steps/Map with `s`/`m` and goes back to the list with Escape; the filter lives in the hash (`#/session/<id>?show=attention`) so reload and back keep it. The web package gets a DOM test environment and its first interaction tests, which also cover existing controls (inherited toggle, Live pause, the S-07 play keys).
- **Change ID:** prompt-triage
- **Size:** M
- **PRD refs:** FR-016, NFR keyboard operability (PRD v3); primary Success Criterion (< 2 minutes to find unchecked/failing prompts)
- **Prerequisites:** —
- **Parallel with:** S-16
- **Blockers:** —
- **Unknowns:**
  - happy-dom or jsdom: resolved 2026-10-25 in the plan: jsdom 30.1.2, exact (every happy-dom from 17.0.0 to 21.0.3 is under a high advisory that would fail CI's `pnpm audit --audit-level=high`; jsdom 30.1.2 audits clean and passed a spike with vitest 4.1.12 and React 19.3.1). — Owner: team. Block: no.
  - Keys must not hijack page scrolling or screen readers: arrows act only while focus is on a row button (roving focus), single-letter keys only outside inputs. — Owner: team. Block: no.
- **Risk:** low; mostly web. The session-level count needs one optional field, `SessionSummary.attentionCount`, computed by the API with a shared core rule `needsAttention` that `--summary` also uses (output unchanged); schema-first rule with S-18 if both are in flight. The one dependency of the batch (jsdom, dev-only, exact) is not shipped (web is bundled into the CLI). Plan: `context/changes/prompt-triage/plan.md`.
- **Status:** done (2026-10-25; phases Sonnet/OpenCode/OpenCode/Sonnet/OpenCode, 0 fixes; visual browser check pending for the owner, `context/archive/prompt-triage/reviews/browser-check.md`)

### S-18: Scoped checks flagged ("partially checked" as a hint)

- **Outcome:** Developer sees, on a `checked` prompt whose deciding check ran only on part of the repository (test-runner path arguments, `cd <dir> && …`, `pnpm -C/--dir <dir>`, path-style `--filter ./pkg`, `npm --prefix <dir>`, `go test ./pkg/...`), a `check-scope` hint (warn) on each edited code file outside that scope and the reason suffix "(scoped to <scope>)"; the status stays `checked`.
- **Change ID:** scoped-checks
- **Size:** M
- **PRD refs:** FR-017 (PRD v3); FR-002 Socrates note (partial coverage deferred to v2)
- **Prerequisites:** S-16 (same files: `analyze.ts`, `hints.ts`, goldens; reason suffixes compose with S-16's)
- **Parallel with:** S-19 under the schema-first rule (both add schema members)
- **Blockers:** —
- **Unknowns:**
  - Which runner arguments are path scopes: vitest positional arguments are file-name substring filters, jest arguments are regexes, pytest takes paths or node ids, `go test` package patterns; `cargo test` name filters and named `--filter @scope/pkg` are not resolved (no hint, no node IO). Fixed as a table with tests in the plan. — Owner: team. Block: no.
  - How often the deciding check is scoped on real logs (new aggregate counter in `scripts/audit-status.mjs`), to confirm `warn` severity. — Owner: orchestrator. Block: no.
- **Risk:** medium: false positives when scoped tests import the edited code; mitigated by covering rules (a scope `tests/api` also covers paths with an `api` segment; `x.test.ts` covers `x.ts`), hint only, never a status, never a `high` severity.
- **Status:** done (2026-10-25; phases Sonnet/Haiku/OpenCode/OpenCode/OpenCode, 0 fixes; real-log audit: no status change, 2 of 162 prompts flagged `check-scope`, `context/archive/scoped-checks/reviews/audit-2026-10-25.md`)

### S-19: Sessions of all worktrees in one list

- **Outcome:** Developer runs `lgtm-review` in the main checkout or any linked worktree and sees the sessions of every worktree of the repository (from `git worktree list`) in one list, with a Worktree column (path relative to the main checkout) and a worktree filter; steps, diffs, map and play of a worktree session use that worktree's directory; `--list`, `--json`, `--summary`, `--export` and `--archive` cover the same set; `--no-worktrees` keeps today's single-directory behaviour.
- **Change ID:** worktree-sessions
- **Size:** M
- **PRD refs:** FR-018, NFR read-only git (PRD v3); FR-001 Socrates note ("no worktree filter in MVP")
- **Prerequisites:** S-17 (same web files `SessionList.tsx`, `viewmodel.ts`; reuses the DOM test harness)
- **Parallel with:** S-18 (schema-first rule), S-20
- **Blockers:** —
- **Unknowns:**
  - Does Claude Code record sessions started in a worktree (including `claude --worktree` and `isolation: "worktree"` agents) under the project dir named after the worktree path? Checked 2026-10-25 by directory names only: the owner's `~/.claude/projects` has no worktree project dirs yet, so the slice is verified on synthetic layouts and its value depends on starting sessions inside worktrees. — Owner: orchestrator. Block: no.
  - Sessions of worktrees git no longer lists (removed, pruned) are not discovered, and neither are their archive copies; documented, not solved. — Owner: team. Block: no.
- **Risk:** medium: the "one `--dir` per server" assumption in `api.ts`, map, play and export becomes per-session; worktree paths come only from `git worktree list` run in `--dir` (fixed arguments, no shell), never from log content or a request.
- **Status:** done (2026-10-25; phases Sonnet/Sonnet/Sonnet/Haiku, 0 fixes; browser view pending for the owner, `context/archive/worktree-sessions/reviews/check.md`)

### S-20: Status accuracy, round 2 (real-log follow-ups)

- **Outcome:** Overall status match on the owner's real logs reaches >= 97% (95.3% on 2026-10-23) with prompts without subagents not regressing (>= 97.1%): an edit written by a redirect before the check in the same command (`cat > f <<EOF … EOF && pnpm test`) counts as before the check; a `sed -i` inside a `( … )` group after a check counts as after it; status-less task notifications (monitor events) are pinned by fixtures to never stop a background check; notifications are matched across the parent and subagent files; Write/Edit to temporary scratch paths outside the work tree need no check; Python import extraction no longer loses imports after a `#` comment that contains `"""`.
- **Change ID:** status-accuracy-2
- **Size:** M
- **PRD refs:** FR-002, FR-004, FR-013; Success Criterion v3 (>= 97% on real logs)
- **Prerequisites:** S-18 (same core analysis files and goldens)
- **Parallel with:** S-19, S-21
- **Blockers:** —
- **Unknowns:**
  - Baseline first: re-run the audit on main, because the empty-`bashEditDiff` fix (66a00af) was not in the last audited build (493a029); drop items it already fixed. — Owner: orchestrator. Block: no.
  - Where Claude Code puts isolated agent worktrees: if under a temp root, the scratch rule must not treat their edits as scratch (subagent edits can simply be exempted). — Owner: team. Block: no.
  - Why 121 of 606 task notifications match no launch in the same file (other session, subagent file, or noise). — Owner: orchestrator. Block: no.
- **Risk:** low–medium; every case gets a synthetic fixture; the real-log audit stays orchestrator-only (no external models, aggregate counts only).
- **Status:** done (2026-10-25; phases OpenCode x4, 0 fixes; real logs: no status change, >= 97% not re-measured — `context/archive/status-accuracy-2/reviews/audit-2026-10-25.md`)

### Status accuracy rounds (v0.3+)

Follow-up rule rounds on real logs after S-20 (round 2), merged into main; tracked in `context/ORCHESTRATION.md` ("Aktywne slice'y"). None of them is a separate roadmap slice; one line each, what changed:

- **status-accuracy-3 (2026-10-26):** checks wrapped in `flock`/`ionice`/`setsid`/`stdbuf` count; files attributed to git in mixed command lists (with a cautious fallback to the old rule when a segment may write); heredoc/`$VAR` write targets recognized — audit A 74.0% → 90.8%, B 68.9% → 90.2%.
- **status-accuracy-4 (2026-10-28):** approach changed twice (C16 allow-lists, then narrowing C17–C19b) — audit B 86.1% → 97.5%, A 85.3% → 96.6%, 0 regressions.
- **status-accuracy-5 (2026-10-28, evening):** review gaps R1–R3 closed and R4 became owner decision Q3 — full caution: a `cd X && a; b` command no longer assumes the `cd` succeeded outside the `&&` chain — audit B 97.5% → 84.8% (20 changes toward caution, 0 hidden edits).
- **status-accuracy-6 (2026-10-28, evening):** heredoc, `case` and Python allow-list handling; 0 status changes on real logs.
- **status-accuracy-7 (2026-10-28, night):** a CRLF regression found in review was fixed.
- **status-accuracy-8 (2026-10-28, night):** the heredoc delimiter is now a whole shell word, plus arithmetic `<<` and comments; a `$((1<<2))` regression found in review was fixed.
- **status-accuracy-9 (2026-10-29):** several heredocs in one line — bodies form a queue, stdin is the last heredoc of the segment.
- **status-accuracy-10 (2026-10-29):** `<<` inside quotes/`$'…'` is not a heredoc; arithmetic `$((`/`((`/`$[` counts only when closed by `))`/`]` — otherwise the bash fallback to substitution/subshell; unquoted `let x=1<<2` is a heredoc as in bash; `#` after an escaped space and `\<<` fixed.
- **status-accuracy-11 (2026-10-29):** carried over from round 10 — `( ((`/`{ ((`/`! ((` arithmetic, `$'…'` in the delimiter with `\x`/octal/`\u`, `(( x > 1 ))` without target `1`, arithmetic across a newline, `"$((cmd) ; …)"`.
- **status-accuracy-12 (2026-10-29):** option B approved by the owner — redirects with a file descriptor (`2>`, `&>`, `>|`) and unspecified targets count as edits; 3 expectations changed with the owner's consent.
- **status-accuracy-13 (2026-10-29):** the check log is freed only for log targets, also inside `( )`/`{ }`; code written "as a log" counts as an edit; `: ${X:=src}` poisons a name; `local`/`declare`/`readonly T=$(mktemp)` and `${TMPDIR:=/tmp}` count as scratch.
- **gate-each (2026-10-29):** not a status rule — gate tooling: the removed-expectations check now sees removed rows of `test.each`/`it.each`/`describe.each` tables and tables by name (`const cases = [...]`), moves within the same table/test allowed, fails closed.

### S-21: Git cross-check ("what landed vs what the log shows")

- **Outcome:** Developer opens a session's **Git cross-check** (web view and API) and sees which files git reports for the session's directory (uncommitted changes, and files changed by commits on the session's branch between its first and last record) that no prompt edited ("not in the log": formatter, generator, a shell edit the log missed, or a person), and which edited files git shows neither as uncommitted nor in those commits ("not in git": reverted, deleted again, outside the repository). Read-only git; statuses and hints never change.
- **Change ID:** git-crosscheck
- **Size:** M
- **PRD refs:** FR-019, NFR read-only git (PRD v3); FR-004 Socrates note (git reconciliation deferred)
- **Prerequisites:** S-19 (per-session directory and the read-only git runner)
- **Parallel with:** S-20
- **Blockers:** —
- **Unknowns:**
  - Commit window: committer dates vs session timestamps (rebase and amend move dates); `--since/--until` with a margin, stated in the view. — Owner: team. Block: no.
  - Sessions started outside a repository (cwd is a parent directory): the cross-check is unavailable and says so. — Owner: team. Block: no.
- **Risk:** medium; kept last among the deterministic slices because git state mixes the agent's work with the user's and other sessions'; it is labelled a cross-check and never feeds statuses or hints.
- **Status:** done (2026-10-25; phases Agy (Gemini 3.8 Flash) x3, 0 fixes; browser view pending for the owner, `context/archive/git-crosscheck/reviews/check.md`)

### S-08: Local LLM titles (opt-in, loopback only)

- **Outcome:** Developer who runs a local model server opts in with `--llm-url http://127.0.0.1:<port> --llm-model <name>` and sees in the web UI a one-sentence, past-tense title per prompt, generated from a condensed and redacted view of the prompt's actions, marked "generated" and shown next to the template title; titles are cached on disk by input hash; summary and export keep template titles; without the flags nothing changes and no connection is made.
- **Change ID:** llm-titles
- **Size:** L
- **PRD refs:** FR-020, NFR loopback-only LLM (PRD v3); `docs/PROPOSAL.md` §10
- **Prerequisites:** S-17; owner decisions O-1..O-3
- **Parallel with:** — (touches CLI flags, API, the prompt table and the schema)
- **Blockers:** owner decisions (Open Roadmap Question 7): O-1 allow an LLM layer at all; O-2 backend: loopback OpenAI-compatible server only (Ollama, llama.cpp, LM Studio) or also `claude -p` (sends session content to Anthropic, so the "no data leaves the machine" guardrail would have to change); O-3 default model, and whether generated titles may appear in `--summary`/`--export`.
- **Unknowns:**
  - Title quality and latency of small local models on condensed turns; the cache (`~/.lgtm-review/cache`) is a new write path. — Owner: team. Block: no.
- **Risk:** highest of the batch relative to its value: non-reproducible text in a deterministic tool and a new data path; kept last and gated. Reuses the reserved ID S-08 because the PRD, the proposal and the owner's decisions point to it.
- **Status:** done (2026-10-28; merge 6e9118e, impl Grok, reviews Sonnet + OpenCode)

### Backlog handoff (v0.3)

| Roadmap ID | Change ID         | Suggested issue title                                          | Ready for plan                           | Notes                                   |
| ---------- | ----------------- | -------------------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| S-16       | doc-edits         | Documentation-only edits need no check                         | done                                     | wave 1                                  |
| S-17       | prompt-triage     | "Needs attention" filters and keyboard navigation in the UI    | done                                     | wave 1 (S-16 already merged)            |
| S-18       | scoped-checks     | Flag checks that ran on only part of the repository            | done                                     | wave 2; the only wave-2 golden writer   |
| S-19       | worktree-sessions | One session list for all git worktrees                         | done                                     | wave 2, schema-first with S-18          |
| S-20       | status-accuracy-2 | Status accuracy round 2 (real-log follow-ups)                  | done                                     | wave 3; the only wave-3 golden writer   |
| S-21       | git-crosscheck    | Git cross-check of a session's edits                           | done                                     | wave 3                                  |
| S-08       | llm-titles        | Opt-in local LLM titles                                        | done (2026-10-28)                        | gated                                   |

## Backlog Handoff

| Roadmap ID | Change ID            | Suggested issue title                                         | Ready for `/10x-plan` | Notes                                  |
| ---------- | -------------------- | ------------------------------------------------------------- | --------------------- | -------------------------------------- |
| F-01       | foundation-scaffold  | Finish foundation: audit bump, CI Node 22+24, pack smoke, fixtures | done                  | Run `/10x-plan foundation-scaffold`    |
| S-01       | parser-statuses      | Parse sessions and show prompt statuses in the terminal       | done                  | After F-01                             |
| S-02       | web-sessions-prompts | Browser view of sessions and prompts with statuses            | done                  | After S-01; north star                 |
| S-03       | steps-and-diff       | Steps view and diff for a prompt                              | done                  | After S-02; closes MVP                 |

## Open Roadmap Questions

1. **Public repository name and trademark check for `lgtm-review`** — Owner: user. Block: first public release (post-MVP).
2. **Credit / permission for the original idea author (prototype shown at the course live)** — Owner: user. Block: publishing the README.
3. **Default LLM model for the summarizer** — Owner: user. Now part of question 7 (S-08 moved into the v0.3 extension as a gated slice). Block: S-08 only. Answered 2026-10-27 with question 7 (owner decisions): no default model — the user names the model per invocation; generated titles stay out of `--summary`/`--export`.
4. **Timeline acknowledgment** — MVP is 7 weeks at ~5 h/week after-hours (> 3-week default); owner accepted on 2026-10-23. Target: first browser view (S-02) by about week 4. Block: none.
5. **Decisions delegated by owner to the orchestrator** (non-goals, product framing: cli / large / no deadline; this roadmap's framing) — assumptions, owner may correct at any time. Block: roadmap-wide (soft).
6. **Should the PRD be extended with requirements for the parked post-MVP slices (S-04..S-10) before they are planned?** — Owner: user. Block: any parked slice. Answered for v0.3 by the orchestrator on delegation (2026-10-25): PRD v3 declares FR-015..FR-020 for the v0.3 slices; the isometric map and other agents stay parked.
7. **LLM layer decisions for S-08 (owner only)** — O-1: allow an opt-in LLM layer at all (non-reproducible text in a deterministic tool)? O-2: backend: only a model server on the loopback interface (Ollama, llama.cpp, LM Studio; keeps "no data leaves the machine"), or also `claude -p` (sends condensed session content to Anthropic; needs a guardrail change)? O-3: default model (proposal: none, the user names it), and may generated titles appear in `--summary`/`--export` (proposal: no)? — Owner: user. Block: S-08 only. Answered 2026-10-27 (owner decisions): O-1 yes, an opt-in LLM layer is allowed; O-2 a loopback model server only (no `claude -p`, the "no data leaves the machine" guardrail stays); O-3 no default model, and generated titles do not appear in `--summary`/`--export`. Block cleared: S-08 done 2026-10-28.

## Parked

Reserved IDs follow `docs/PROPOSAL.md` §17 so existing references (S-08, S-09) stay valid. None of these are planned until the PRD declares them.

- **S-04: Isometric import map** — Why parked: PRD §Non-Goals; reduced 2D version moved to active section (S-04), isometric stays parked.
- **S-10 (rest): hosted demo page** — Why parked: `docs/demo/index.html` (static export of a synthetic session) shipped 2026-10-23; hosting it (GitHub Pages) needs the owner.
- **Agents other than Claude Code** — Why parked: PRD §Non-Goals. A first step would be a read-only format spike (Codex CLI JSONL) feeding a PRD decision, not an adapter.
- **A `partially-checked` status value** — Why parked: a fifth status touches every surface (terminal, summary, export, web, audit); v0.3 reports partial coverage as a hint instead (S-18).

Moved out of Parked on 2026-10-25 (v0.3 extension):

- **S-08: LLM layer** → v0.3 S-08 (opt-in, loopback only), blocked on question 7.
- **"Partially checked" coverage detection** → v0.3 S-18 as the `check-scope` hint (FR-017).
- **Worktree filter in the session list** → v0.3 S-19 (FR-018).
- **Parallel worktrees** (was: the MVP chain is strictly sequential; parallel pairs post-MVP, capped at 2 by review capacity) → superseded by "Parallel work rules (v0.3)": at most two slices in flight, schema-first rule.

## Done
- **Review round S-12/S-13/S-14 and import map (2026-10-26)** — fixes incl. fork ownership on real logs and workspace-package imports in the map. Continued agents (SendMessage) now count in the continuing prompt (verified on real logs, 2026-10-26).
- **v0.2 review round (2026-10-26)** — reviews of S-06 (redaction/export), S-15 (archive), S-16 (doc names) and fixes; no new FR. See `context/ORCHESTRATION.md`.
- **v0.3 review round (2026-10-26)** — read-only reviews of S-17..S-21 and fixes (no new FR); `turbo`/`nx` task runners recognized as checks (FR-002). See `context/ORCHESTRATION.md`.

- **S-15: Local session archive (`--archive`, archived sessions in every view)** — FR-008 second half; done 2026-10-23 (`context/archive/session-archive/`).
- **S-07: Play the change (template captions, new-import edges)** — FR-014; done 2026-10-23 (`context/archive/play-the-change/`).
- **S-09: Python imports in the import map (+ Django layers and hints)** — FR-013; done 2026-10-23 (`context/archive/python-map/`).

