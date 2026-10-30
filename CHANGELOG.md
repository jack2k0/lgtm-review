# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

Initial release. Review what a coding agent did in a Claude Code session without reading every line: which prompts were checked, where the time went, what the agent did step by step, and what it changed.

### Added
- Local web UI on loopback (127.0.0.1) with a per-run authentication token in the URL fragment.
- Timeline of prompts with status heuristics (`checked`, `unchecked`, `failing`, `no-changes`) and phase breakdown (`read`, `write`, `check`, `fix`).
- Step view showing actions, check results, and agent quotes per prompt.
- Per-file diffs showing agent edits taken from session logs.
- Review hints per prompt and heuristic recommendations (`skim`, `read-flagged`, `read-all`).
- Git cross-check comparing session log edits with local git status and commit history.
- Local private session archive (`--archive`) preserving copies of older Claude Code session logs.
- Standalone HTML export (`--export <id-prefix>`) with embedded styling and best-effort secret redaction.
- Markdown summary export (`--summary`) for pull request descriptions.
- Terminal list output (`--list`) and JSON analysis output (`--json`).
- Optional local prompt titles generated with an Ollama, llama.cpp, or LM Studio endpoint (`--llm-url`, `--llm-model`).
- Discovery of sessions across linked git worktrees.
- Flag `--raw` to output unredacted log text in `--list` and `--json`.

### Changed
- `--list` and `--json` redact secrets, usernames, and repository paths by default (best-effort); pass `--raw` to print log text unredacted.
