# Status accuracy, round 4 Implementation Plan

## Overview

Owner decisions of 2026-10-27 (ORCHESTRATION "Decyzje właściciela (2026-10-27)"): Q1 a prompt that only merges/rebases is `no-changes`; Q2 a failing subagent check after a green main-thread check gives `failing` (time order); Q3 an unresolvable shell write target counts as code (fail closed, unchanged); Q4 a later background check without a completion notification does not invalidate an earlier covering pass; Q5 a command killed by a signal (exit 130/137/143/144) is not a failing check, it "did not complete".

Adjudication of 2026-10-28 (Sonnet, real logs, aggregates only; `reviews/adjudication.md`): 24 status mismatches (21 unique prompts, 158 rows after Claude Code's log cleanup removed old sessions). A private experiment with the rules below fixed 18 of 24 with 0 regressions. Remaining: 4 are truth-script errors (phase 4), 2 have no safe rule (opaque writers in the same command), 1 is a by-design red probe.

## Current State

- `packages/core/src/shell-edits.ts`: segment parser, `classifyShellMutation` (`gitOnly`, `opaque`, `hasHistoryGitOp`, `hasCd`, `edits`), `pythonWrites` (heredocs only), `resolveTarget`; relative targets after any `cd` stay unresolved; variables resolve only from literal assignments (`R=docs/x.md`).
- `packages/core/src/check-patterns.ts`: `PREFIXES` stripped before check matching (no `corepack`); script check patterns.
- `packages/core/src/analyze.ts` ~L640-705: with `bashEditDiff` and a history git op, per-file split via `plainDiffPaths` unless `sm.opaque`; without a diff (`unavailable` / empty) the split happens only when `!sm.opaque`. `judge()` ~L265: `incompleteAfter` turns any incomplete later check into `unchecked "check did not complete"`; `onNotification` ~L430 maps `STOP_STATUSES` to `stopped`.

## Desired End State (rules; names match the adjudication)

1. **CD + VARCHAIN.** Track the working directory through one Bash command: `cd <concrete>` where concrete = absolute literal path, or `$VAR`/`${VAR}`/`"$VAR"`(+ `/literal` suffix) whose value is known; relative `cd x` from a known dir also resolves. `cd` inside `( … )` applies only inside the subshell. `cd -`, `cd ~…`, `cd` with an unknown variable, `cd $(…)` -> directory unknown from there on (today's behaviour). A `cd X || …` / `cd X; …` still counts as having changed to X (accepted risk, same as truth). Relative write targets after a known `cd` resolve against it; class (code/doc/scratch) is then decided on the resolved absolute path as today. Assignments may reference already-known variables: `S=/tmp/x; R=$S/y` -> R known (VARCHAIN). Unknown stays `(shell edit)` = code (Q3).
2. **ENVVAR.** `env $E git …` / `env "$E" …` where `E` was assigned a literal consisting only of `NAME=value` words: expand and strip like `env NAME=value`.
3. **NPMCI.** `npm ci` (and `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`/`--immutable` if not already) is a known non-writing segment for tracked files (does not make the command opaque, no edit).
4. **COREPACK.** `corepack` is a prefix stripped before check and package-manager matching (`corepack pnpm check`, `corepack pnpm exec vitest run`, `corepack yarn test`).
5. **GATEREAD.** `node|python|python3 <path>` where `<path>` is repo-relative under `scripts/` (or `./scripts/`) and the basename matches `^(gate|check|verify|validate)[\w.-]*\.(mjs|cjs|js|py|ts)$` is a known NON-writing segment: it does not make the command opaque and is NOT a check (it does not change any check list). Output redirects of that segment still count as writes as usual.
6. **PYC.** `python|python3 -c "<src>"` / `-c '<src>'`: analyse `<src>` with the same writer analysis used for heredocs (after substituting known shell variables in a double-quoted source and dedenting). A resolvable write is that edit; an unresolvable write is `(shell edit)` (code); a source with no write API (`open(..., "w"/"a"/"x")`, `write_text`, `write_bytes`, `shutil.*`, `os.rename|replace|remove|unlink`, `Path.unlink/rename/replace/touch/mkdir` …: reuse the heredoc list) is non-writing and no longer opaque.
7. **SPLIT-OPAQUE.** In the no-diff path (`bashEditDiff` absent, `unavailable`, or empty files) of a command with a history git op or `git mv`/`git rm`: edits are split by their own origin even when the command is opaque — explicitly parsed `git mv`/`git rm` targets are git-made (`gitOp`), and an extensionless `git mv` target that is a directory (another target or diff path starts with `<target>/`, or the source was a directory per A5 of round 3) never counts as a code file. Opaque segments still produce what they produce today (nothing new is trusted). With a diff present nothing changes (round-3 rules).
8. **Q4.** In `judge()`: an incomplete later check that is a BACKGROUND check without any terminal notification does not trigger `incompleteAfter` when a completed passing check already covers the last edit (`lastCompleted.coveredSeq > lastEdit` and it passed): the status is `checked` with reason suffix `; a later background check did not report`. Without such a pass, or for a foreground check without result, today's `unchecked "check did not complete"` stays.
9. **Q5.** A check whose exit code is 130, 137, 143 or 144 is treated as stopped (neither passed nor failed): foreground and background (notification exit code). Reason when it is the decisive check: `check did not complete`. A check with these codes never yields `failing`.
10. **Q2.** Confirm by test only: subagent pass at t1 on the main thread's last edit, main pass at t2, subagent fail at t3 (all after the last edit, t1<t2<t3 by timestamp) -> `failing`; if the code already does this, the test documents it. If not, fix ordering to use the merged timestamp order.

## What We're NOT Doing

- No rule for a red check followed by `git checkout HEAD -- …` (mutation probe): it could hide a real red.
- No trust in unknown repo-local scripts other than GATEREAD names; `agy`/`opencode`/other launches stay opaque.
- No change to existing `*.labels.json`, goldens or test expectations. New fixtures only.
- No schema, web or CLI change.

## Gate

```gate
allow: ^packages/core/src/(check-patterns|shell-edits|analyze|subagents)(\.test)?\.ts$
allow: ^packages/core/src/[a-z-]+\.test\.ts$
allow: ^packages/core/fixtures/sessions/sa4-[a-z0-9-]+\.(jsonl|labels\.json)$
allow: ^packages/core/fixtures/sessions/sa4-[a-z0-9-]+/subagents/agent-[a-z0-9-]+\.(jsonl|meta\.json)$
allow: ^packages/core/fixtures/sessions/__golden__/sa4-[a-z0-9-]+\.
allow: ^scripts/audit/
allow: ^context/(changes|archive)/status-accuracy-4/
goldens: sa4-[a-z0-9-]+\.
labels: new-only
deps: no
schema: no
```

## Phase 1: shell parsing (rules 1-6)

Files: `shell-edits.ts`, `check-patterns.ts`, their tests, new fixtures `sa4-cd-scratch`, `sa4-gate-merge`.
- Unit tests per rule, each failing on the old code, including negatives: `cd "$UNKNOWN"; sed -i x a.ts` -> `(shell edit)`; `(cd /tmp/s && sed -i x a.ts); sed -i x b.ts` -> `/tmp/s/a.ts` scratch and `b.ts` relative to the outer cwd; `cd -` -> unknown; `node scripts/build.mjs` stays opaque; `node scripts/gate.mjs > out.md` writes `out.md`; `python3 -c "open('src/a.ts','w').write('x')"` -> `src/a.ts`; `python3 -c "open(p,'w')"` with unknown p -> `(shell edit)`; `python3 -c "print(1)"` non-writing; `corepack pnpm check` is a check, `corepack enable` is not; `env $E git merge b` with `E="GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=y"` is a git op.
- Fixtures (synthetic; labels written from the rules above, not from the tool's output): `sa4-cd-scratch`: `S=/tmp/claude-1000/x/scratchpad; cd $S/wt && sed -i … src/a.ts`, then a check in scratch -> `no-changes` (scratch only); a second prompt `cd /repo && sed -i … src/a.ts` with no check -> `unchecked`. `sa4-gate-merge`: heredoc doc write, `node scripts/gate.mjs --base main > $S/g.txt`, `git merge --no-ff b && git mv context/changes/x context/archive/x && git commit` with a diff of `.ts` files -> `no-changes`.
- Done: tests + fixtures pass; `pnpm check` green; gate exit 0/2.
- [x] Phase 1 done

## Phase 2: judging (rules 7-10)

Files: `analyze.ts` (and `subagents.ts` only if Q2 needs it), tests, new fixtures `sa4-split-opaque`, `sa4-bg-no-notify`, `sa4-signal-kill`, `sa4-subagent-late-fail`.
- Unit tests per rule failing on the old code, plus: Q4 negative (no earlier pass -> unchecked "check did not complete"; a foreground check with no result -> unchanged); Q5: exit 137 after a passing check -> checked; exit 144 alone -> unchecked "check did not complete"; exit 1 -> failing (unchanged); SPLIT-OPAQUE negative: an opaque segment plus `git mv` and a parsed `sed -i src/a.ts` -> `src/a.ts` still a code edit.
- Done: tests + fixtures pass; `pnpm check` green; gate exit 0/2.
- [x] Phase 2 done

## Phase 3: real-log audit (orchestrator only, no external model)

PRE = main, POST = branch, `node scripts/audit/compare.mjs` aggregates + PRE->POST transitions (counts); a Sonnet adjudicates any new disagreement. Record in `reviews/audit.md`.
- [x] Phase 3 done

## Phase 4: truth-script fixes (a different agent than phases 1-2; Claude subagent, real logs allowed only as aggregates)

`scripts/audit/truth.py`: (a) `bashEditDiff` with empty `files` is not an edit; (b) subagent events after the next prompt's first timestamp belong to that next prompt's window (match the tool's split); (c) the python write scan ignores quoted strings that are not file paths (URLs, strings with `://`, spaces); (d) Q4 and Q5 as in rules 8-9; (e) the new tool rules 1-7 where truth lacks them (truth stays independent code). One synthetic case each in `scripts/audit/fixtures`, `node --test scripts/audit/audit.test.mjs` green.
- [x] Phase 4 done

## Review

Tier High (status rule). Two reviewers other than the implementer, cross-verification of Important findings, ledger `reviews/findings.md`, merge gate with `--merge`.

## Plan-review amendments (OpenCode GLM-5.3-Flash, 2026-10-28; binding, override the sections above)

- C1 (PYC escape surface): a `python -c` source is non-writing and non-opaque only when it has no write API AND no escape surface: `exec`, `eval`, `compile`, `__import__`, `os.system`, `os.popen`, `os.exec*`, `os.spawn*`, `subprocess`, `pty`, `import os`/`from os` together with any call on `os` other than `os.path.*`/`os.getcwd`/`os.environ` reads, `import shutil`. Otherwise the segment stays opaque exactly as today. Negative test: `python3 -c "import os; os.system('sed -i s/x/y/ src/a.ts')"` stays opaque.
- C2 (allowed expectation change, like round-3 A6): only `shell-edits.test.ts` ~L258 (the H1 `git merge b && sed -i … && python3 -c "open('src/a.ts','w')"` row: `opaque` may become false, `src/a.ts` resolved) may change; the matching `analyze.test.ts` ~L1100 row must keep status `unchecked` (its comment text may stay). Name the old and new values in the commit message.
- C3 (Q5 reason): signal exits get their own flag (e.g. `signalStop`) with reason `check did not complete`; notification stops keep `check stopped` (existing tests unchanged). Foreground errored result: a signal exit must not `setFailing` the thread. Background notification exit code 130/137/143/144 -> same flag. Tests for both paths.
- C4 (phase 4 b): the tool is not changed for late subagent events. truth.py adopts the tool's attribution (as implemented in `subagents.ts` merge); the phase-4 agent verifies on the 6 affected prompts (counts only) which way the tool assigns them and makes truth match the PRD reading recorded in `reviews/adjudication.md`; if the tool turns out to be wrong per the PRD, stop and report instead of changing the tool.
- C5 (SPLIT-OPAQUE directory): in the no-diff path an extensionless `git mv` destination is a directory only when another parsed edit target starts with `<target>/`; `sm.opaque` is unchanged; only the split condition in analyze.ts (~L691) drops the `!sm.opaque` requirement for parsed `git mv`/`git rm` targets.
- C6 (plumbing): phase 1 may touch `analyze.ts` for cwd plumbing: `ShellMutation` gains per-edit resolved base dir (or `cwdAfter` per target) and `resolveTarget` uses it; design it in `shell-edits.ts`, consume in `analyze.ts`.
- C7 (CD forms): `pushd` = `cd`; `..` resolves via normalizePath; cds chain left to right; an unknown form poisons only later relative targets; absolute targets resolve as today; `cd $(pwd)/x` = unknown.
- C8 (ENVVAR order): build the vars map, substitute `$E` in the segment, then strip env/assignment prefixes; `E="x y"` (not only NAME=value words) stays unexpanded and the command opaque (test).
- C9 (GATEREAD/NPMCI forms): the script operand is resolved against the tracked cwd (rule 1) and must be repo-relative under `scripts/` after stripping `./`; the first non-flag operand must be the script (`node -r x/register scripts/gate.mjs` -> skip `-r <val>` style options of node: `-r`, `--require`, `--import`, `--loader`; python: `-u`, `-B`, `-I`); NPMCI accepts `install|i` with `--frozen-lockfile`/`--immutable` in any order and `-C <dir>`/`--dir`; bare `npm install`/`pnpm install` stay as today (test).
- C10 (extra negatives): `git rm old/a.ts && sed -i … src/a.ts` (rm git-made, sed code); background notification exit 143 -> stopped; `S=$OTHER/f; cd $S` unknown.
- C11 (phase 3 pass criteria): at least 17 of the 24 adjudicated rows fixed by the tool phases, 0 previously matching prompts changed status (by PRE/POST transitions; any change goes to a Sonnet adjudication), status match A >= 95% and B >= 95% on the current log set; after phase 4 truth fixes, target >= 97% (PRD) — if missed, record why.
- C12 (orchestrator, after phase 1; fail-closed hole reported by the implementer): PYC "non-writing" becomes an allow-list. A `python -c` source with no resolved write is non-writing and non-opaque ONLY when (a) every import is from `{json, sys, re, math, datetime, time, collections, itertools, functools, textwrap, pprint, statistics, random, string, decimal, fractions, operator, typing, enum, dataclasses, uuid, hashlib, base64, platform}` (any form: `import x`, `import x as y`, `from x import …`; an import of anything else, including `os`, `shutil`, `subprocess`, `pathlib`, `io`, `tempfile`, `importlib`, `pty`, aliases, is opaque), and (b) the source contains none of the identifiers `open`, `Path`, `exec`, `eval`, `compile`, `__import__`, `__builtins__`, `getattr`, `globals`, `system`, `popen`, `spawn`, `write`, `replace`, `rename`, `unlink`, `remove`, `rmdir`, `touch`, `mkdir`, `makedirs`, `symlink`, `chmod`, `copy`, `move`, `truncate`, `dump` (word match, also as attribute). A source with a resolved write keeps that edit and is non-opaque only if (a) holds and every occurrence of those identifiers belongs to a resolved write; otherwise opaque. Same allow-list for the heredoc path is NOT in scope (heredocs unchanged). Tests: `import os as o; o.system(...)` opaque; `from pathlib import Path as P; (P("a")/"b").write_text("x")` opaque; `import json; print(json.dumps({}))` non-writing; `print(1)` non-writing; `json.dump(d, open("x.json","w"))` -> `x.json` resolved, non-opaque.
- C13 (orchestrator, from POST audit adjudication 2): GATEREAD also applies after an absolute `cd` when the absolute directory is the session repo root (cwd of the call or its git toplevel as known to analyze), a directory under it, or a sibling worktree `<parent of repo>/<repo basename>-<anything>`; the operand must still resolve to `<that dir>/scripts/<gate|check|verify|validate name>`. Any other absolute dir stays opaque. Tests: `cd /abs/repo-x && node scripts/gate.mjs --merge > $S/g.txt` with repo `/abs/repo` -> non-opaque; `cd /tmp/other && node scripts/gate.mjs` -> opaque; `cd /abs/repo && node scripts/build.mjs` -> opaque.
- C14 (C12 relaxation, narrow): in a `python -c` source with no import outside the allow-list, `open(<x>)` / `open(<x>, "r"|"rb")` (read mode literal or absent) and `.read()`, and `.replace(` are allowed when the source has no `Path`/`pathlib` and no `os` import; a write `open(<lit or resolvable name>, "w"|"a"|"x")` still resolves as an edit; `open(p, mode)` with a non-literal mode is opaque. Tests: `p='docs/a.md';s=open(p).read();s=s.replace('a','b');open(p,'w').write(s)` -> edit `docs/a.md`, non-opaque; `open(p, m)` -> opaque; `from pathlib import Path; Path(p).replace(q)` -> opaque.
- C15 (review round 1; supersedes the C9 node skip list, and the npm half of C9's NPMCI rule): a node option before the script that takes or loads code is not GATEREAD. `-e`/`--eval`, `-p`/`--print`, `-r`/`--require`, `--import`, and `--loader`/`--experimental-loader` (spaced, `=`, or attached `-e`/`-p`/`-r`) make the segment opaque. Python `-c` or `-m` before a script is not GATEREAD. Python `-u`/`-B`/`-I` stay ignorable, and `node scripts/gate.mjs` with no such option stays GATEREAD. `npm install` / `npm i` is never a frozen install, whatever flags it carries (npm ignores `--frozen-lockfile`); only `npm ci` is. `pnpm`/`yarn` `install`|`i` with `--frozen-lockfile`/`--immutable` are unchanged. `eval`, `source`, `.`, `builtin`, `command` and `exec` make the tracked directory unknown from that segment on, so a later relative target is `(shell edit)` (code). `pnpm exec` / `npm exec` are not the shell builtin. A `python -c` source is opaque when it contains a dunder, any of `gi_frame` `gi_code` `gi_yieldfrom` `f_globals` `f_builtins` `f_code` `f_back` `f_locals` `cr_frame` `cr_code` `ag_frame` `ag_code` `tb_frame` `co_consts`, or a subscript or attribute on an imported allow-listed module other than a plain call of a documented safe function (`json.dumps(`, `hashlib.sha256(`, `platform.machine(`). The C12/C14 allowed cases stay non-opaque, including an unresolved `open(p,'w')` with no disallowed import. A dash-less python heredoc (`python3 <<EOF`, `python <<EOF`, `python3.11 <<EOF`, `python3 -B <<EOF`) is scanned with the heredoc writer, as on main; C12 still does not apply there. `.` and `..` in an absolute path are normalised before the scratch / temp-root test, so `/tmp/../home/user/project/src/a.ts` is code.
