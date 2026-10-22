# Research: konkurencja, formaty sesji, biblioteki (Grok 4.6, effort high, 2026-10-22)

Surowy wynik researchu użyty w PROPOSAL.md (sekcja 14). Niezweryfikowany ręcznie.

Research as of 2026-10-22. Every claim has a URL. Gaps are marked **not found**.

## 1. Existing tools

**Session viewers / analytics**

- **claude-code-log** — https://github.com/daaain/claude-code-log — MIT, ~1.2k★, release 1.7.0 on 2026-10-05. JSONL → HTML/Markdown + TUI + live watch. Lacks prompt checklist, Read/Write/Check/Fix time split, import map, captioned play-through.
- **ccusage** — https://github.com/ccusage/ccusage · https://ccusage.com/guide/ — MIT, ~19.1k★, docs dated 2026-10-22. Token/cost reports across Claude, Codex, OpenCode, Gemini, Grok, and more. Cost analytics only.
- **sniffly** — https://github.com/chiphuyen/sniffly — MIT, ~1.3k★. Local usage/error dashboard plus shareable command walkthrough. Last commit ~1.2 years as of 2026-10-08: https://osrepos.com/repo/chiphuyen-sniffly. No replay or map.
- **claude-trace** — original interceptor: https://github.com/badlogic/lemmy/blob/main/apps/claude-trace/README.md. 2026 fork with Claude V2+/OpenCode/Codex: https://github.com/hanqunfeng/claude-trace (MIT). Captures hidden API traffic. Not a reviewer story.
- **opcode** (ex-Claudia) — https://github.com/winfunc/opcode — AGPL-3.0, ~22.4k★, last commit 2026-09-18, last release v0.2.0 2025-08-31. Tauri GUI for sessions, agents, usage, checkpoints. Operator GUI, not a reviewer walkthrough.
- **vibe-log-cli** — https://github.com/vibe-log/vibe-log-cli — MIT, ~339★, updated 2026-04-19. Local standups/productivity reports from Claude + Codex. https://vibe-log.dev/
- **Sessions Viewer** — https://sessions-viewer.js-bridge.com/ — MIT (https://github.com/jerrywu001/cc-sessions-viewer). Desktop reader for Claude, Codex, Grok, Kimi, Pi, Antigravity, OpenCode. Search + resume. No isometric map or captioned play.
- **hindcast** — https://github.com/karanb192/hindcast — MIT, ~6–10★, v0.1.3 2026-08-20. Mac timeline scrubber + resume + cost. Claude-only.
- **vibe-replay** — https://github.com/tuo-lei/vibe-replay · https://vibe-replay.com/ — ~38★. Multi-agent interactive replay and shareable HTML. Closest 2026 replay product. No layered isometric import graph or prompt pass/fail checklist.
- **agent-dump** — https://agent-dump.xingkaixin.me/ — v1.2.6 2026-10-21. Export/search 16+ agent stores. CLI dump, not a story UI.
- **simonw/claude-code-transcripts** — https://github.com/simonw/claude-code-transcripts — Apache-2.0, ~1.7k★. Publish HTML transcripts.

**PR / repo visualization**

- **CodeSee Review Maps** — https://docs.codesee.io/docs/user-guide. PR file + import maps and author Tours. Commercial ops closed 2024-02-22 (https://www.linkedin.com/posts/shaneak_update-codesee-has-been-acquired-by-gitkraken-activity-7163970333912289281-p4YG); GitKraken acquired it 2024-05-14 (https://gitkraken.com/blog/gitkraken-launches-devex-platform-acquires-codesee). GitKraken Codemaps still “coming soon” as of 2025-10-07: https://gitkraken.com/features/code-dependency-mapping.
- **CodeRabbit walkthroughs** — https://docs.coderabbit.ai/pr-reviews/walkthroughs · layer-based walkthroughs 2026-05-14: https://coderabbit.ai/blog/explainable-prs-and-smarter-reviewer-routing. Commercial; git PR, not a session log.
- **Graphite** — https://graphite.com/docs/review-pull-requests. Stacked-PR review + AI comments. File tree/timeline.
- **Sourcegraph** — https://sourcegraph.com/docs/batch-changes. Search/nav + Batch Changes (agentic 2026-09). Not a per-PR dependency walkthrough.
- **git-truck** — https://github.com/git-truck/git-truck — MIT, ~777★, updated 2026-09-08. Git treemap of authorship/activity.
- **Gource** — https://gource.io · https://github.com/acaudwell/Gource — GPL-3, v0.56 2026-03-06. Animated VCS tree of commits.

**Gap vs your idea:** transcript viewers and cost dashboards are common. CodeRabbit/CodeSee are closest for reviewer maps. vibe-replay/hindcast are closest for replay. **Not found:** prompt checklist (checked / unchecked / failing) + per-prompt Read/Write/Check/Fix time split + isometric import-layered file map + plain-language play-the-change, all from an agent log.

## 2. Where transcripts live

**Claude Code** (official)

- Path: `~/.claude/projects/<encoded-cwd>/<session>.jsonl`; also `…/<session>/subagents/`, `…/tool-results/`, `file-history/<session>/`. Retention `cleanupPeriodDays`, default 30. Docs: https://code.claude.com/docs/en/claude-directory
- Shape: JSONL, one object per line. Official page says “every message, tool call, and tool result.” **No official JSON schema.** Community types: `user` / `assistant` / `system` / `file-history-snapshot` / … with `timestamp`, `sessionId`, `uuid`, `parentUuid`, `cwd`; assistant `message.content` holds `text` / `thinking` / `tool_use`. https://promptconduit.dev/blog/claude-code-transcripts-location
- Stability: unofficial; record types change across versions.
- Hooks: `transcript_path` plus `PreToolUse` / `PostToolUse` (`tool_name`, `tool_input`, `duration_ms`, `tool_response`). https://docs.anthropic.com/en/docs/claude-code/hooks.md
- OpenTelemetry: `CLAUDE_CODE_ENABLE_TELEMETRY=1`; metrics and log events stable; traces **beta** (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`) wrap prompt → API → tools. Not a substitute for full JSONL diffs. https://code.claude.com/docs/en/monitoring-usage

**Codex CLI**

- `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`; archives; `history.jsonl`; `state_N.sqlite`. Official resume mentions `~/.codex/sessions/`: https://developers.openai.com/codex/cli/features/
- Shape: JSONL event stream (`session_meta`, `event_msg`, `response_item`, `turn_context`, …). **Schema not officially documented.** Community: https://www.prismmd.app/blog/codex-cli-chat-history-where-files-live

**Gemini CLI** (official)

- `~/.gemini/tmp/<project_hash>/chats/` JSON/JSONL; default retain 30 days. https://geminicli.com/docs/cli/session-management/
- Community: `session-*.jsonl`, first line SessionMetadata, then MessageRecords. https://agentgrep.org/backends/gemini/

**Grok Build CLI** (official)

- `~/.grok/sessions/` (override `GROK_HOME`). Per-session dir: `summary.json`, `updates.jsonl` (ACP events), `chat_history.jsonl`, `plan.json`, `rewind_points.jsonl`, `subagents/`. https://x.ai/docs/build/features/sessions · layout: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md

**OpenCode**

- Data dir (official): `~/.local/share/opencode/` (Windows `%USERPROFILE%\.local\share\opencode`). https://opencode.ai/docs/troubleshooting/
- Current community layout: SQLite `opencode.db` (`session` / `message` / `part` JSON columns). Older JSON-file `storage/` also reported. **No official schema guarantee.** https://sessions-viewer.js-bridge.com/agents/opencode

**Cursor CLI**

- Official docs: `--resume`, `agent ls` — **no local path**. https://cursor.com/docs/cli/using
- Community (undocumented): `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl` and `~/.cursor/chats/<hash>/<id>/store.db`; IDE also `state.vscdb`. https://jazzyalex.github.io/agent-sessions/guides/cursor-agent-local-history.html

## 3. Trailo (Filip Rakowski / Alokai)

**Not found** as an AI-agent review product or repo by Filip Rakowski or Alokai.

- X `from:filrakowski Trailo`: no results. GitHub https://github.com/filrak has no Trailo repo.
- Confusable names: travel app https://techyorker.com/products/trailo/ (trailoapp.com); field-service https://trailo.io/en/; Patronus **TRAIL** benchmark https://arxiv.org/abs/2505.08638; **Trail-code** context map https://github.com/trailhq/Trail-Code (MIT); Alokai CI reviewer `@alokai/cli-plugin-review` https://docs.alokai.com/ai-coding-support/ai-review (PR bot, not a session story).

## 4. Libraries (npm latest seen 2026-10-22 unless noted)

**Render (isometric / 2.5D graphs)**

- **three** 0.186.1, MIT, ~114k★ — WebGL plus CSS3D/SVG addons; isometric via `OrthographicCamera`. https://www.npmjs.com/package/three
- **@react-three/fiber** 9.8.2, MIT. https://www.npmjs.com/package/@react-three/fiber
- **reagraph** Apache-2.0, ~1.1k★ — React WebGL graphs on r3f. https://hysenlabs.com/projects/reaviz-reagraph
- **sigma** 4.0.3, MIT, ~12.2k★ — 2D WebGL large graphs. https://www.npmjs.com/package/sigma
- **cytoscape** 3.34.4 (2026-10-15), MIT, ~11k★ — 2D canvas + analysis. https://www.npmjs.com/package/cytoscape
- **xyflow/react** MIT, ~38.7k★ — 2D node editors. https://awesomedataviz.com/categories/javascript-graph-visualization/
- Dedicated isometric *layered file-map* library: **not found**. CSS 3D or three.js orthographic is the usual DIY path.

**TS/JS import graphs**

- **dependency-cruiser** 18.7.0 (2026-10-19), MIT. https://www.npmjs.com/package/dependency-cruiser
- **madge** 8.0.0, MIT, ~10k★ — last npm 2024-08 (stale). https://bestofjs.org/projects/madge
- **ts-morph** 27.0.2 on npmjs, MIT. https://www.npmjs.com/package/ts-morph
- **oxc-resolver** GitHub v11.24.3 (2026-08-24); npm listed 11.24.2, MIT. https://github.com/oxc-project/oxc_resolver/releases
- **oxc-parser** 0.155.0 (2026-10-19) — ESM info without a full walk. https://www.npmjs.com/package/oxc-parser
- **es-module-lexer** 3.0.4 (2026-10-15), MIT. https://www.npmjs.com/package/es-module-lexer
- **tree-sitter** lib 0.27.1 (2026-10-08, MIT); npm bindings 0.25.1 (2026-07-28). https://en.wikipedia.org/wiki/Tree-sitter_(parser_generator)
