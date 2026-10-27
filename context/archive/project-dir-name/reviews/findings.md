# Findings: change/project-dir-name

Tier Medium (core node discovery). Source: Agy read-only discovery review, findings 1, 3, 4 accepted; rule verified by Opus in the Claude Code 2.1.311 binary (`cwd.replace(/[^a-zA-Z0-9]/g, "-")`, names over 200 chars become `slice(0,200)-<hash>`). Implementer: Agy (Gemini 3.8 Flash). Pre-merge review: Opus, diff-only. New tests fail on the old code 9/9; pnpm check exit 0 (Node 22); this repo lists 11 sessions before and after. Deferred from the source review: 2 (symlinked .jsonl), 5 (EACCES on the live dir), 6-8 (Nits). Side effect: archive dirs of repos whose path has non-alphanumerics other than `/` and `.` get the new name; older copies stay under the old one.

reviewers: opus

findings: none
