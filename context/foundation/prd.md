---
project: "lgtm-review"
version: 2
status: draft
created: 2026-10-23
context_type: greenfield
product_type: cli
target_scale:
  users: large
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 7
  hard_deadline: null
  after_hours_only: true
---

# lgtm-review

## Vision & Problem Statement

An AI agent changes 6–60 files in about 15 minutes. A developer reviewing that work today reads a diff that shows the final state file by file, alphabetically: it does not say in what order things happened, what the agent tried and broke, or whether tests ran after the last edit. That information exists only in the session log, which nobody reads. Review ends up slower than writing, or happens "sideways" and gets merged without understanding.

The session log contains more than the diff: order, intent, check results, agent text between steps. Processing it into levels of abstraction (sessions → prompts with verification status → steps → diff) lets the reviewer descend into code only where needed. No existing tool combines per-prompt verification status, phase time split and a story view computed from an agent log.

## User & Persona

Primary: solo developer / tech lead who runs several to a dozen Claude Code sessions a day, often in parallel worktrees. Moment of use: end of a session, before commit or PR — "what exactly landed, and can I merge without reading everything?". This is the project owner.

### Secondary persona
PR reviewer in a team who receives a report from a colleague's agent session (not served by the MVP). Tertiary, later: team lead looking at where agents lose time.

## Success Criteria

### Primary
- For a real ~1-hour Claude Code session, the owner identifies all `unchecked` / `failing` prompts in < 2 minutes in the browser, without opening any diff.
- Status matches manual verification in ≥ 95% of turns on a fixture corpus.
- A first browser view of a real session (sessions and prompts with statuses) is reachable early, before the Steps and Diff views are built.

### Secondary
- Steps view and diff reachable from each prompt.
- 3 external contributors (adapter / preset) within 3 months of public release (post-MVP).

### Guardrails
- Unknown or malformed log records never make the product fail; they are skipped and reported.
- A 20 MB session opens in < 3 s.
- Log content is never rendered as markup or script; no session data leaves the machine.
- No secret from test fixtures appears in anything the product outputs.

## User Stories

### US-01: Developer finds unverified work in a session

- **Given** a recorded Claude Code session of one repo with several prompts
- **When** the developer runs `lgtm-review` and opens the session in the browser
- **Then** each prompt shows a status dot (checked / unchecked / failing / no-changes), a title, active time and changed-file counts

#### Acceptance Criteria
- A prompt whose last edit came after its last passing check shows `unchecked` with a reason ("N edits after last check" / "no checks ran")
- A prompt whose last check failed shows `failing` with the failing command and a short excerpt
- A prompt without edits shows `no-changes`
- Unknown or malformed log records are skipped and listed as warnings, not fatal

### US-02: Developer reads what happened inside a prompt

- **Given** an opened prompt in the web UI
- **When** the developer opens its Steps view
- **Then** they see ordered steps with phase, checks (command + exit result) and agent quotes, and can click a changed file to see its diff

#### Acceptance Criteria
- Each step can be expanded to its raw action list
- Diff is unified and labelled "agent edits, not final git state"

## Functional Requirements

### Sessions and prompts
- FR-001: Developer can list Claude Code sessions for the current repo (title, branch, time, prompt count, status counts) in terminal and web. Priority: must-have
  > Socrates: Counter-argument considered: "Claude Code already has a session picker; a list duplicates it." Resolution: kept; list is the entry point, value is the status counts per session. No worktree filter in MVP (all sessions of repo path).
- FR-002: Developer can see, for each prompt, a status (checked / unchecked / failing / no-changes) with a reason. Priority: must-have
  > Socrates: Counter-argument considered: "A green check does not prove the edited files were verified (e.g. a test run scoped to one folder while edits are elsewhere)." Resolution: kept; checked means "last check after last edit passed" and UI states it does not prove coverage; "partially checked" deferred to v2; check patterns configurable and the repo's own test/check scripts auto-detected to reduce false unchecked.
- FR-003: Developer can see, for each prompt, active time split into Read / Write / Check / Fix with a one-sentence headline. Priority: must-have
  > Socrates: Counter-argument considered: "Timestamp-difference times are approximate and mislead." Resolution: kept; UI labels times approximate and emphasizes proportions over seconds.
- FR-004: Developer can see, for each prompt, the changed files with added / changed / deleted markers and line deltas. Priority: must-have
  > Socrates: Counter-argument considered: "Deletes and edits via shell commands are invisible in the log." Resolution: kept; shell-made edits read from the log when recorded, removals and moves detected best-effort, git reconciliation deferred; gaps shown as "may be incomplete".

### Detail
- FR-005: Developer can open a prompt and see ordered steps (Read / Write / Check / Fix) with check commands, exit results and agent quotes. Priority: must-have
  > Socrates: Counter-argument considered: "Grouping actions into steps is arbitrary and can hide an important action." Resolution: kept; each step expands to the raw ungrouped action list; grouping stays mechanical (same phase = one step).
- FR-006: Developer can open the diff of a changed file from a step. Priority: must-have
  > Socrates: Counter-argument considered: "IDE / hosting-site diff is better; own viewer is costly." Resolution: kept but minimal: unified diff of the agent's recorded edits only (no split view, no custom highlighter in MVP); labelled as "agent edits, not final git state".

### Delivery
- FR-007: Developer can browse sessions, prompts, steps and diffs in a local web UI started by a single command. Priority: must-have
  > Socrates: Counter-argument considered: "Terminal UI would be enough; a local server adds attack surface." Resolution: stands. Owner explicitly wants the browser view as soon as possible; security properties are NFRs.
- FR-008: Developer can keep a local archive of analyzed sessions that survives Claude Code's 30-day log cleanup. Priority: nice-to-have
  > Socrates: Stands as written, but out of MVP scope: no consumer until export exists.

## Non-Functional Requirements

- A session of up to 20 MB opens in < 3 s on a typical developer laptop.
- No data from the analyzed sessions leaves the user's machine; the product runs without accounts, cloud or telemetry.
- Session content is reachable only from the local machine and only by the person who started the tool; a different web page open in the same browser cannot read it.
- Content from session logs (prompts, command output, file text) is never interpreted as markup or script by the product's UI.
- Unrecognized log records never make the product fail; they are skipped and reported as warnings.
- Statuses and time splits are reproducible: the same input always yields the same result.
- The product remains usable on the latest two major versions of mainstream desktop browsers.

## Business Logic

For each prompt in an agent session, the product classifies every agent action as Read, Write, Check or Fix and computes a verification status: `checked` only when, after the last edit, a check ran and succeeded.

Inputs the reviewer sees: the prompts of a session and what the agent did in response to each (reads, edits, command runs and their results, timing). Output: a status with a reason, a split of active time across the four phases, and the list of changed files. The reviewer meets the rule in the prompt list (status dots, time bars) and in the Steps view. A failed check followed by edits counts as Fix, not Write; time waiting for the user is excluded from active time.

Statuses: `checked` (last check after last edit succeeded), `unchecked` (edits after last check, or no check ran), `failing` (last check in the prompt failed), `no-changes` (no edits).

## Access Control

Single user; no auth; data lives on-device only. The web UI is reachable only from the same machine and only by the person who started it.

## Non-Goals

- Isometric import map, review hints, "Play the change": after MVP (v0.2); MVP stays at prompts / steps / diff.
- HTML export with secret redaction and the local archive (FR-008): after MVP; no sharing story in MVP.
- LLM-generated titles and captions: MVP titles come from templates and the prompt text; LLM layer is later.
- Agents other than Claude Code, and Python projects: later.
- Not a bot that judges code correctness; does not replace tests or PR review.
- Does not edit code and does not control the agent.
- No hosting, accounts, sync or telemetry; local-first only.
- No partial-coverage detection ("partially checked") in MVP.

## v0.2 Extension (orchestrator decision on owner delegation, 2026-10-23)

MVP (US-01, US-02, FR-001..FR-007) is delivered. v0.2 adds review guidance, still local-only and deterministic (no LLM):

- FR-009: Developer can see, per prompt, deterministic review hints (rules from `docs/PROPOSAL.md` §9.7: `test-modified-during-fix`, `assertions-removed`, `test-skipped`, `sensitive-path`, `unchecked-edit`, `dependency-change`, `public-surface`, `config-change`, `large-change`) with severity, the file and a reason, and a recommendation Skim / Read flagged / Read all. Priority: should-have.
  > Socrates: Counter-argument considered: "Heuristics will cry wolf and be ignored." Resolution: kept; rules are explicit, each hint states its rule and evidence, severity high only for rules that indicate weakened verification; the recommendation is advice, never a verdict.
- FR-010: Developer can print a markdown summary of a session (prompts, statuses, hints, files) for a PR description with one command. Priority: should-have.
  > Socrates: Counter-argument considered: "Summary could leak prompt text into PRs." Resolution: kept; summary contains status, reason, hints and file paths and the 80-char prompt title only; no command output, no file content; documented in README.
- Still non-goals: isometric import map, "Play the change", HTML export with redaction, LLM layer, Python, other agents.

## Open Questions

1. **Public repository name and trademark check for `lgtm-review`** — Owner: user. Before first public release.
2. **Credit / permission for the original idea author (prototype shown at the course live)** — Owner: user. Before the README is published.
3. **Default LLM model for the summarizer** — Owner: decided in the plan of slice S-08. Not blocking MVP.
4. **Timeline acknowledgment** — MVP is 7 weeks at ~5 h/week after-hours (> 3-week default); owner accepted on 2026-10-23. Target: first browser view by about week 4.
5. **Decisions delegated by owner to the orchestrator** (non-goals, product framing: cli / large / no deadline) — assumptions, owner may correct at any time.
