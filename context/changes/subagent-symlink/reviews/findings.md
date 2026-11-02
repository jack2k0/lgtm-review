# Review findings: subagent-symlink

reviewers: haiku, opus

Implemented by Agy (Gemini 3.8 Flash), 2026-11-02. Opus read the diff and ran the tests; Haiku ran six synthetic symlink cases and scratch copies of main and HEAD. New tests on the old `subagents.ts`: 6 fail. On the new code: 22 of 22 pass. Real logs hold no symlinks.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Minor | packages/core/src/node/subagents.ts:127 | Check and read are separate steps: a link swapped in between `lstat` and the read is followed | haiku | opus: read | deferred | needs write access to the session tree, where the attacker can already change the transcript |
