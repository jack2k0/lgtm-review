---
project: "lgtm-review"
context_type: greenfield
created: 2026-10-23
updated: 2026-10-23
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "project name"
      decision: "lgtm-review (npm free 2026-10-23; GitHub/trademark check before publish)"
    - topic: "license"
      decision: "Apache-2.0"
    - topic: "Python in MVP"
      decision: "No. Python + Django preset = later slice (S-09)."
    - topic: "time budget"
      decision: "~5 h/week, after-hours"
    - topic: "primary persona"
      decision: "Solo dev / tech lead working with Claude Code (the owner)"
    - topic: "MVP scope"
      decision: "Scope down to S-01..S-03 (parser+statuses, web L0/L1, Steps+Diff). Map, hints, export, play, LLM = after MVP."
    - topic: "delivery priority"
      decision: "Owner wants to see MVP in the browser ASAP: thin parser (S-01) then web (S-02) immediately; terminal list is a by-product, not a goal."
    - topic: "remaining framing/non-goals"
      decision: "Delegated by owner to orchestrator (Opus-level judgement requested; made by Sonnet 5.5 session). Assumptions below; owner may correct."
  frs_drafted: 8
  quality_check_status: accepted
---

# Shape notes — lgtm-review

Seed: `docs/PROPOSAL.md` (working name "Strata"). Research: `docs/research-2026-10-22-grok.md`.
Hook line: "Earn your LGTM." / "Review the story, not the diff."

## Vision & Problem Statement

An AI agent changes 6–60 files in ~15 minutes. A developer reviewing that work today reads a diff that shows the final state file by file, alphabetically: it does not say in what order things happened, what the agent tried and broke, or whether tests ran after the last edit. That information exists only in the session log, which nobody reads. Review ends up slower than writing, or happens "sideways" and gets merged without understanding.

Insight: the session log contains more than the diff (order, intent, check results, agent text between steps). Processing it into levels of abstraction (sessions → prompts with verification status → steps → diff) lets the reviewer descend into code only where needed. Nobody combines per-prompt verification status, phase time split and a story view computed from an agent log (see research, section 1 gap).

## User & Persona

Primary: solo developer / tech lead who runs several to a dozen Claude Code sessions a day, often in parallel worktrees. Moment of use: end of a session / before commit or PR — "what exactly landed, and can I merge without reading everything?". This is the project owner.

Secondary (short, not served by MVP): PR reviewer in a team who gets a link/report from a colleague's agent session. Tertiary (later): team lead looking at where agents lose time.

## Access Control

Single user; no auth; data lives on-device only. Local web UI is reachable only from the same machine (localhost) and protected by a per-run secret token so other web pages in the browser cannot read sessions.

## Success Criteria

### Primary
- For a real ~1-hour Claude Code session, the owner identifies all `unchecked` / `failing` prompts in < 2 minutes in the browser, without opening any diff.
- Status matches manual verification in ≥ 95% of turns on a fixture corpus.
- **First browser view (L0/L1) of a real session is reachable early** (target: end of S-02), before Steps/Diff are built.

### Secondary
- Steps view and diff reachable from each prompt (S-03).
- 3 external contributors (adapter/preset) within 3 months of public release (post-MVP).

### Guardrails
- Parser never crashes on unknown records (skips + warns).
- 20 MB JSONL session opens in < 3 s.
- No log content ever rendered as HTML; no session data leaves the machine; server bound to 127.0.0.1 with token.
- No secret from test fixtures appears in anything the tool outputs.

## MVP flow (timeline discipline)

1. Owner runs `npx lgtm-review` in a repo (or `lgtm-review list` in terminal).
2. Browser opens: list of sessions for that repo.
3. Owner opens a session: list of prompts, each with status dot (checked / unchecked / failing / no-changes), one-line title, phase time bar, file counts.
4. Owner opens a prompt: ordered steps with check commands/results and agent quotes.
5. Owner clicks a changed file: unified diff.

Timeline: > 3 weeks of after-hours work (5 h/week). Estimated 25–35 h, `mvp_weeks: 7`.

Acknowledged on 2026-10-23: 7-week MVP requires sustained dedication; user accepted. Milestone ordering to hit browser early: S-01 (thin parser, ~week 2–3) → S-02 (web L0/L1, ~week 3–4) → S-03 (Steps+Diff, ~week 7).

## Functional Requirements

### Sessions and prompts
- FR-001: Developer can list Claude Code sessions for the current repo (title, branch, time, prompt count, status counts) in terminal and web. Priority: must-have
  > Socrates: Counter-argument considered: "Claude Code already has a session picker; a list duplicates it." Resolution: kept; list is the entry point, value is the status counts per session. No worktree filter in MVP (all sessions of repo path).
- FR-002: Developer can see, for each prompt, a status (checked / unchecked / failing / no-changes) with a reason. Priority: must-have
  > Socrates: Counter-argument considered: "A green check does not prove the edited files were verified (e.g. vitest tests/api while edits are in components/)." Resolution: kept; checked means "last check after last edit passed" and UI states it does not prove coverage; "partially checked" deferred to v2; check patterns configurable and `package.json` test/check scripts auto-detected to reduce false unchecked.
- FR-003: Developer can see, for each prompt, active time split into Read / Write / Check / Fix with a one-sentence headline. Priority: must-have
  > Socrates: Counter-argument considered: "Timestamp-difference times are approximate and mislead." Resolution: kept; UI labels times approximate and emphasizes proportions over seconds.
- FR-004: Developer can see, for each prompt, the changed files with added / changed / deleted markers and line deltas. Priority: must-have
  > Socrates: Counter-argument considered: "Deletes and edits via Bash are invisible in the log." Resolution: kept; Bash edits read from `bashEditDiff` when present, `rm`/`git mv` detected best-effort, git reconciliation deferred; gaps shown as "may be incomplete".

### Detail
- FR-005: Developer can open a prompt and see ordered steps (Read/Write/Check/Fix) with check commands, exit results and agent quotes. Priority: must-have
  > Socrates: Counter-argument considered: "Grouping actions into steps is arbitrary and can hide an important action." Resolution: kept; each step expands to the raw ungrouped action list; grouping stays mechanical (same phase = one step).
- FR-006: Developer can open the diff of a changed file from a step. Priority: must-have
  > Socrates: Counter-argument considered: "IDE/GitHub diff is better; own viewer is costly." Resolution: kept but minimal: unified diff of the agent's recorded edits only (no split view, no custom highlighter in MVP); labelled as "agent edits, not final git state".

### Delivery
- FR-007: Developer can browse sessions, prompts, steps and diffs in a local web UI started by a single command. Priority: must-have
  > Socrates: Counter-argument considered: "Terminal TUI would be enough; a local server adds attack surface." Resolution: stands. Owner explicitly wants the browser view as soon as possible; security mitigations are NFRs (localhost, token, no HTML rendering of log content).
- FR-008: Developer can keep a local archive of analyzed sessions that survives Claude Code's 30-day log cleanup. Priority: nice-to-have
  > Socrates: Stands as written, but out of MVP scope: no consumer until export exists.

## User Stories

### US-01: Developer finds unverified work in a session
- **Given** a recorded Claude Code session of one repo with several prompts
- **When** the developer runs `npx lgtm-review` and opens the session in the browser
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

## Business Logic

For each prompt in an agent session, the product classifies every agent action as Read, Write, Check or Fix and computes a verification status: `checked` only when, after the last edit, a check ran and succeeded.

Inputs the reviewer sees: the prompts of a session and what the agent did in response to each (reads, edits, command runs and their results, timing). Output: a status with a reason, a split of active time across the four phases, and the list of changed files. The reviewer meets the rule in the prompt list (status dots, time bars) and in the Steps view. Failed check followed by edits counts as Fix, not Write; time waiting for the user is excluded from active time.

Statuses: `checked` (last check after last edit succeeded), `unchecked` (edits after last check, or no check ran), `failing` (last check in the prompt failed), `no-changes` (no edits).

## Non-Functional Requirements

- A session of up to 20 MB opens in < 3 s on a typical developer laptop.
- No data from the analyzed sessions leaves the user's machine; the product runs without accounts, cloud or telemetry.
- Session content is reachable only from the local machine and only by the person who started the tool; a different web page open in the same browser cannot read it.
- Content from session logs (prompts, command output, file text) is never interpreted as markup or script by the product's UI.
- Unrecognized log records never make the product fail; they are skipped and reported as warnings.
- Statuses and time splits are reproducible: the same input always yields the same result.
- Works on current and previous Node LTS (≥ 22) and latest two versions of mainstream desktop browsers.

## Non-Goals

- Isometric import map, review hints, "Play the change": after MVP (v0.2); MVP stays at prompts/steps/diff.
- HTML export with secret redaction and the local archive (FR-008): after MVP; no sharing story in MVP.
- LLM-generated titles/captions: MVP titles come from templates and the prompt text; LLM layer is later (decision in plan S-08).
- Agents other than Claude Code, and Python projects: later.
- Not a bot that judges code correctness and does not replace tests or PR review.
- Does not edit code, does not control the agent.
- No hosting, accounts, sync or telemetry; local-first only.
- No partial-coverage detection ("partially checked") in MVP.

## Open Questions

1. **GitHub org/repo name and trademark check for `lgtm-review`** — Owner: user. Before first public release.
2. **Credit/permission for the original idea author (prototype shown at the course live)** — Owner: user. Before README is published.
3. **Default LLM model for the summarizer** — Owner: decided in plan of slice S-08.

## Quality cross-check

All six elements present (Access Control, Business Logic one-sentence rule, project artifacts, timeline-cost acknowledged, Non-Goals). No gaps.

## Forward: tech-stack

Informational only (from PROPOSAL section 18.3), to be confirmed by `/10x-tech-stack-selector`: TypeScript everywhere (shared zod schema), Node ≥ 22, npm distribution; web = Vite + React; diff view = lightweight unified viewer; pnpm workspaces; golden tests on JSONL→Story fixtures. Story JSON is the contract between core and web (UI can be built against fixtures).

## Forward: technical-roadmap

- Spike at S-01 start: agy reads 10–20 real sessions in `~/.claude/projects/*/*.jsonl` (read-only) and lists edge cases (exit code format, compaction, resume, subagents, interrupts, parallel tool calls).
- Fixtures: anonymized slices of own sessions; build web against fixtures early so browser view can land before the parser is complete.
- Re-ordering for "browser ASAP": S-01 minimal Story (prompts, statuses, files) → S-02 web on real Story. Terminal `list` is thin, secondary.
