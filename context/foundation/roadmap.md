---
project: lgtm-review
version: 1
status: draft
created: 2026-10-23
updated: 2026-10-23
prd_version: 1
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
- **Status:** ready

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
- **Status:** proposed

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
- **Status:** proposed

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
- **Status:** proposed

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

## Backlog Handoff

| Roadmap ID | Change ID            | Suggested issue title                                         | Ready for `/10x-plan` | Notes                                  |
| ---------- | -------------------- | ------------------------------------------------------------- | --------------------- | -------------------------------------- |
| F-01       | foundation-scaffold  | Finish foundation: audit bump, CI Node 22+24, pack smoke, fixtures | yes                   | Run `/10x-plan foundation-scaffold`    |
| S-01       | parser-statuses      | Parse sessions and show prompt statuses in the terminal       | no                    | After F-01                             |
| S-02       | web-sessions-prompts | Browser view of sessions and prompts with statuses            | no                    | After S-01; north star                 |
| S-03       | steps-and-diff       | Steps view and diff for a prompt                              | no                    | After S-02; closes MVP                 |

## Open Roadmap Questions

1. **Public repository name and trademark check for `lgtm-review`** — Owner: user. Block: first public release (post-MVP).
2. **Credit / permission for the original idea author (prototype shown at the course live)** — Owner: user. Block: publishing the README.
3. **Default LLM model for the summarizer** — Owner: decided in the plan of slice S-08 (parked). Block: S-08 only; not MVP.
4. **Timeline acknowledgment** — MVP is 7 weeks at ~5 h/week after-hours (> 3-week default); owner accepted on 2026-10-23. Target: first browser view (S-02) by about week 4. Block: none.
5. **Decisions delegated by owner to the orchestrator** (non-goals, product framing: cli / large / no deadline; this roadmap's framing) — assumptions, owner may correct at any time. Block: roadmap-wide (soft).
6. **Should the PRD be extended with requirements for the parked post-MVP slices (S-04..S-10) before they are planned?** — Owner: user. Block: any parked slice.

## Parked

Reserved IDs follow `docs/PROPOSAL.md` §17 so existing references (S-08, S-09) stay valid. None of these are planned until the PRD declares them.

- **S-04: Isometric import map** — Why parked: PRD §Non-Goals (after MVP, v0.2).
- **Local archive (FR-008, second half)** — Why parked: only the export half shipped in S-06.
- **S-07: "Play the change"** — Why parked: PRD §Non-Goals (after MVP, v0.2).
- **S-08: LLM layer (titles and captions; default model decided in its plan)** — Why parked: PRD §Non-Goals; MVP titles come from templates and prompt text.
- **S-09: Python projects (+ Django preset)** — Why parked: PRD §Non-Goals; owner decision: v0.2.
- **S-10 (rest): demo page** — Why parked: not in PRD; live refresh was split off as its own slice, markdown summary shipped in S-05.
- **Agents other than Claude Code** — Why parked: PRD §Non-Goals.
- **"Partially checked" coverage detection** — Why parked: PRD §Non-Goals (v2).
- **Worktree filter in the session list** — Why parked: FR-001 note (all sessions of the repo path in MVP).
- **Parallel worktrees** — Why parked: the MVP chain F-01 → S-01 → S-02 → S-03 is strictly sequential; the first parallel pairs appear post-MVP (S-03 ‖ S-04, S-07 ‖ S-08 per the proposal), capped at 2 by review capacity.

## Done

