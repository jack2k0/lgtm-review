---
project: "lgtm-review"
version: 3
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

- Isometric 3D import map (reduced 2D import map in v0.2), review hints, "Play the change": after MVP (v0.2); MVP stays at prompts / steps / diff.
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
- FR-011: Developer can keep the browser view open while a session is still running and see it update (statuses, steps, diffs) without reloading; updates pause when the tab is hidden. Priority: nice-to-have.
  > Socrates: Counter-argument considered: "Polling wastes CPU and a half-written log line breaks parsing." Resolution: kept; conditional requests (ETag/304) make idle polls cheap, parsing already tolerates a truncated last line, interval 5 s, only while visible.
- FR-012: Developer can open a 2D layered import map for a session or individual prompt showing modified TS/JS files and their direct in-repo import neighbours (1 hop in both directions: outgoing imports and incoming importers) against the current working tree snapshot (imports as of now), grouped into horizontal layers by top-level directory or package, capped at 150 nodes, with modified nodes coloured by verification status and linking to diffs. Priority: should-have.
  > Socrates: Counter-argument considered: "An architectural import map without full repository indexing or isometric depth is incomplete and adds overhead." Resolution: kept with reduced scope; a 2D working-tree snapshot of changed files and their direct 1-hop neighbours in both directions (capped at 150 nodes) provides immediate architectural context without full-repo indexing overhead or 3D complexity; isometric 3D remains a non-goal.
- FR-008 (archive half, S-15): `lgtm-review --archive` mirrors the repo's session logs and subagent transcripts into a private local archive (`~/.lgtm-review/archive`, `LGTM_REVIEW_ARCHIVE`, `--archive-dir`), explicit command only, never deletes; every view reads archived sessions whose originals were removed, marked "archived".
- FR-008 (export half) promoted to v0.2: the export is a single script-free HTML file produced only by an explicit command; secrets are redacted by a documented, tested pattern set (best effort, the README says so); `--no-diffs` omits file content entirely.
- Decision (S-11, 2026-10-23): edits that come only from git operations (`merge`, `rebase`, `pull`, `checkout`, `stash`, `cherry-pick`, `mv`, `restore`, `reset`) are listed in the file list but do not invalidate an earlier passing check. Measured on the owner's real logs (audit after S-11): status match 97.1% on prompts without subagent activity, 94.5% overall; the gap is subagent transcripts (S-12) and fork/resume duplicates (S-13).
- FR-013: The import map (FR-012) also includes changed Python files and their 1-hop in-repo neighbours: `import x.y`, `from x import y` and relative imports resolve to `.py` / `__init__.py` files under the repo root, `src/` and Django project roots (directories with `manage.py`); each Django app is its own layer; Python/Django manifests, configs, tests and URL/view modules feed the existing review hints. Priority: should-have (owner decision: Python in v0.2, slice S-09).
- FR-014: For a prompt, the developer can replay its change as beats on the import map: files created/edited/deleted in first-edit order (Fix re-edits marked), imports the prompt added, and check results, each with a template caption and the related nodes highlighted; added imports are distinguished from existing ones on the map; keyboard ←/→/Space/Escape; no autoplay under reduced motion. Priority: nice-to-have (slice S-07).
- Still non-goals: isometric 3D import map (reduced 2D map added in FR-012), LLM layer, other agents, Python presets other than Django (FastAPI).

## v0.3 Extension (orchestrator decision on owner delegation, 2026-10-25)

v0.2 is delivered (FR-008..FR-014; real-log status match 95.3% overall, 97.1% without subagent prompts, audits of 2026-10-23). v0.3 targets the reviewer's time on real sessions: less status noise, faster triage, a more honest `checked`, all worktrees in one place and a git cross-check. Everything stays local and deterministic; the one model-based item (FR-020) is opt-in, loopback-only and waits for the owner (Open Question 6). Slices: roadmap "v0.3 extension" (S-16..S-21, S-08).

- FR-015: Developer sees prompts whose only edits are to documentation files (Markdown `.md`/`.markdown`/`.mdown`/`.mkd`/`.mkdn`, reStructuredText `.rst`, AsciiDoc `.adoc`/`.asciidoc`, and files named README, LICENSE/LICENCE, COPYING, NOTICE, AUTHORS, CONTRIBUTORS, CHANGELOG, CHANGES or HISTORY, optionally with `.txt`) as not needing a check: such edits stay in the file list, steps and diffs but neither make a prompt `unchecked` nor invalidate an earlier passing check; a prompt with only documentation edits is `no-changes` with the reason "no code edits (documentation only)", and a passing check followed only by documentation edits keeps the prompt `checked` with the count in the reason. Documentation files get only the `large-change` hint. Priority: should-have (slice S-16).
  > Socrates: Counter-argument considered: "Docs can be wrong too, and some Markdown is executed (doctests, prompt templates); exempting it lets bad changes through unflagged." Resolution: kept; the status answers "was the changed code verified by a check after its last edit", which no check answers for prose; the files stay listed with diffs, the reason names the ignored documentation edits, `.mdx` and other `.txt` files count as code, and the README lists the exact patterns so a team that executes its Markdown knows to read those files.
- FR-016: Developer can narrow the prompt table to prompts that need attention (unchecked, failing, or with review hints: the rule of the summary's "Needs attention" section) and the session list to sessions with at least one such prompt, sees how many need attention on both levels, and moves through the prompt rows with the keyboard (↑/↓ between rows, Enter to expand, `s` Steps, `m` Map, Escape back to the session list); the filter is part of the page address. Priority: should-have (slice S-17).
  > Socrates: Counter-argument considered: "A filter hides the context the reviewer needs; a checked prompt between two failing ones may explain them." Resolution: kept; the default shows everything, the active filter and the number of hidden prompts are always visible and one click or key away, and the filter survives reload and back navigation.
- FR-017: Developer sees when the check that made a prompt `checked` ran only on part of the repository (path arguments of test, lint and type-check runners; `cd <dir> && …`; a directory or path-style package filter such as `pnpm -C <dir>`, `--filter ./<dir>`, `npm --prefix <dir>`; Go package patterns) while edited code files lie outside that part: each such file gets a `check-scope` hint (severity warn) and the reason ends with "(scoped to <scope>)". The status stays `checked`; named package filters and test-name filters are not resolved. Priority: should-have (slice S-18). Measured on real logs (2026-10-25): no status changed; 2 of 162 prompts flagged.
  > Socrates: Counter-argument considered: "A path scope says nothing about coverage: tests in `tests/api` exercise `src/api`." Resolution: kept as a hint, never a status or a high severity; a scope also covers files whose path contains the scope's last non-test directory name (`tests/api` covers `src/api/...`) and the source file of a scoped test file (`cart.test.ts` covers `cart.ts`); the README says the hint means "confirm the scoped check covers this file", not "untested".
- FR-018: Developer sees the sessions of every git worktree of the repository (the main checkout and the linked worktrees that `git worktree list` reports) in one session list, each marked with its worktree, with a worktree filter; steps, diffs, map and play of a worktree session use that worktree's directory; the terminal list, JSON, summary, export and archive commands cover the same sessions; a flag keeps the single-directory behaviour. Sessions of worktrees git no longer lists are not discovered. Priority: should-have (slice S-19).
  > Socrates: Counter-argument considered: "Running the tool inside each worktree is enough, and worktree sessions belong to other branches." Resolution: kept; the persona runs agents in parallel worktrees and reviews them together before merging; each row shows its worktree and branch, and the filter narrows to one worktree.
- FR-019: Developer can open a git cross-check for a session: files git reports for the session's directory (uncommitted changes, and files changed by commits on the session's branch between the session's first and last record) that no prompt of the session edited ("not in the log"), and files the session edited that git shows neither as uncommitted nor in those commits ("not in git"). Statuses and hints never change because of it. Priority: nice-to-have (slice S-21).
  > Socrates: Counter-argument considered: "Git reconciliation was deferred because the working tree mixes the agent's work with the user's and with other sessions'." Resolution: kept as an explicitly labelled cross-check, read-only and never feeding statuses; the view says that "not in the log" can be the user's own change and that rebased or amended commits can fall outside the time window.
- FR-020: Developer who runs a model server on the local machine can opt in (flag with a loopback URL and a model name) to a one-sentence, past-tense title per prompt, generated from a condensed and redacted view of the prompt's actions; titles are cached locally by input hash, shown in the web UI next to the template title and marked as generated, and never change statuses, reasons or hints. Priority: nice-to-have (slice S-08); unblocked by the owner's answer to Open Question 6 (2026-10-27).
  > Socrates: Counter-argument considered: "An LLM adds non-reproducible text and a new data path to a local, deterministic review tool." Resolution: opt-in only, loopback endpoint enforced, never in summary or export, cached so the same session shows the same titles; the backend and default model are the owner's decision.
- Decision (S-16, 2026-10-25): an edit counts for the status rule only when it changes code. Edits made only by git operations (S-11) and edits of documentation files only (FR-015) are listed but never move the status; a prompt with only such edits is `no-changes`. In the Business Logic above, "edit" means a code edit in this sense. Measured on the owner's real logs (2026-10-25): 18 of 159 prompts moved out of `unchecked` (12 to `checked`, 6 to `no-changes`), 1 doc-only prompt `checked` -> `no-changes`; no other transition.
- Decision (S-20, 2026-10-25): scratch files (written outside the session's directory under a temp root or a `scratch*` folder, not in the tool call's working directory or a `.claude/worktrees/` folder) are treated like documentation edits: listed, never move the status. Measured on the owner's real logs: no status changed (163 prompts); the >= 97% target was not re-measured.
- Success criterion (v0.3): status matches manual verification in >= 97% of the owner's real prompts (aggregate audit, slice S-20), without regressing prompts that have no subagent activity (>= 97.1%).
- Non-functional (v0.3):
  - Git is only read: the product runs read-only git subcommands (`worktree list`, `status`, `diff`, `log`, `ls-files`) with fixed argument lists and without a shell, only for the repository under `--dir` and its worktrees, and never writes to a repository (FR-018, FR-019; already true for the import map).
  - The session list and the prompt table can be operated with the keyboard alone, with a visible focus and filter state (FR-016).
  - With the LLM layer enabled (FR-020), session content is sent only to a server on the loopback interface; without the flag the product opens no network connection other than its own local UI server.
- Still non-goals (v0.3): isometric 3D import map; agents other than Claude Code; remote or hosted LLM backends; a fifth `partially-checked` status (partial coverage is a hint, FR-017); writing to git (commits, stashes, checkouts); Python presets other than Django; hosting, accounts, sync and telemetry.

## Open Questions

1. **Public repository name and trademark check for `lgtm-review`** — Owner: user. Before first public release.
2. **Credit / permission for the original idea author (prototype shown at the course live)** — Owner: user. Before the README is published.
3. **Default LLM model for the summarizer** — Owner: user. Now part of question 6 (FR-020, slice S-08). Not blocking MVP.
4. **Timeline acknowledgment** — MVP is 7 weeks at ~5 h/week after-hours (> 3-week default); owner accepted on 2026-10-23. Target: first browser view by about week 4.
5. **Decisions delegated by owner to the orchestrator** (non-goals, product framing: cli / large / no deadline) — assumptions, owner may correct at any time. The v0.3 extension (FR-015..FR-020, the S-16 status-rule decision) was added on that delegation on 2026-10-25.
6. **LLM layer (FR-020, slice S-08)** — ANSWERED by the owner on 2026-10-27: (a) yes, opt-in only; (b) only a model server on the loopback interface (Ollama, llama.cpp, LM Studio), no `claude -p`; (c) no default model (the user names one), and generated titles never appear in `--summary` or `--export`. S-08 is unblocked.
