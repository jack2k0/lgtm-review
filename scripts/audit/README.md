# Status audit (independent ground truth)

Measures how often the status lgtm-review gives a prompt (`checked` / `unchecked` / `failing` / `no-changes`) matches a verification derived
independently from the raw Claude Code logs and the PRD rules. PRD target: >= 97% of the owner's real prompts, >= 97.1% on prompts without
subagent activity.

## Run

```
pnpm build                                   # the CLI must exist: packages/cli/dist/cli.js
node scripts/audit/compare.mjs               # all projects under ~/.claude/projects, prints aggregates only
node scripts/audit/compare.mjs --json        # the same as JSON (still aggregates only)
python3 -I scripts/audit/truth.py --out /tmp/truth.json   # truth only; the file holds ids and flags per prompt: keep it OUT of the repo
node --test scripts/audit/audit.test.mjs     # self-test on the synthetic fixture
```

`compare.mjs` runs `truth.py` into a private temp dir (removed afterwards), then `node packages/cli/dist/cli.js --dir <project cwd> --list --json
--no-worktrees --archive-dir <empty temp dir>` once per project directory (the repo dir is the session `cwd` whose encoding equals the project
directory name), and joins tool and truth per prompt on `sessionId` + prompt `uuid`. Options: `--projects-dir`, `--cli`, `--truth <file>` (reuse a
truth file), `--min-age-minutes` (default 30).

## What is measured

- Truth (`truth.py`, python3 stdlib only, shares no code with `packages/core`): prompt boundaries = real user messages (slash-command turns count,
  `/clear` `/exit` `/compact`, tool results, task notifications and local-command output do not); edits = Edit/Write/MultiEdit/NotebookEdit that did
  not fail, plus Bash commands that write files (redirects, `tee`, `sed -i`, `perl -i`, `cp`/`mv`/`rm`, in-place formatters, `git apply`,
  interpreter one-liners and heredocs that write, git operations); file class documentation (FR-015) > scratch (S-20) > code; only code edits
  move the status; checks = test / typecheck / lint / build / verify commands, package-manager scripts, check scripts, `gh run watch`, with the
  exit from the tool result (`is_error`, `Exit code N`), masked exits (pipe, `;`, `||` after the check) judged by failure text only, background
  checks resolved by their task notification (none = did not complete); order = tool-result position, and the segment index inside one Bash
  command; subagent transcripts (`<session>/subagents/agent-*.jsonl`, `meta.toolUseId`, recursive) are merged into the spawning prompt by timestamp.
- Variants: `main` (PRD v0.3: git operations never count), `cmd` (a git operation counts as a code edit when its command also writes files),
  `strict` (merge/rebase/pull/cherry-pick/stash/reset/restore/... count as edits).
- Populations: A = prompts without Agent/Task calls, B = all joined tool rows, C = prompts with Agent/Task calls. "rows" counts every tool row;
  "unique uuid" counts a prompt once, in the session that first contains its uuid (earliest first timestamp); the other copies are fork/resume
  duplicates (this equals the tool's `inheritedFrom` rows, the script prints whether it does).
- Excluded: sessions whose file changed in the last 30 minutes (the session being written; truth and tool rows of it are dropped).
- Status match = same status. Reason class match = same status and same class (`nc-none`, `nc-git`, `nc-doc`, `nc-scratch`, `nc-docscratch`,
  `u-nocheck`, `u-after`, `u-incomplete`, `c-passed`, `f-failed`) after mapping the tool's reason text.
- Mismatch categories name the smallest set of deviations from the truth rules (the "toggles" in `truth.py`, e.g. "git operation in a mixed
  command counts") under which the truth would equal the tool's answer; `unexplained` = no set of at most two reproduces it. This says what the
  tool behaves like, not which side is right; the audit report gives that judgement.

## Privacy

Real logs contain secrets. The scripts print counts and category names only, never prompt text, commands, paths or reasons. `truth.py --out`
and any intermediate file hold session ids, prompt uuids and flags derived from private logs: write them outside the repository (a scratch
directory) and never commit them or paste their content. Only aggregates go into `context/archive/*/reviews/`.

## Fixtures

`fixtures/make_fixture.py` regenerates `fixtures/projects` (synthetic logs: one session of 27 prompts, one subagent transcript, one fork copy)
and `fixtures/expected.json` (the truth status and reason class per prompt, from the PRD rules). Nothing comes from real logs.
