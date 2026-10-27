# Findings: change/discover-skip

Tier Medium (core node discovery). Source: Agy discovery review finding 6 (deferred earlier, now fixed): dotfiles and 0-byte `*.jsonl` were listed as sessions; `.jsonl` produced an empty id. Implementer: Agy (Gemini 3.8 Flash). Pre-merge review: Opus, diff-only. New tests fail on the old code 2/2; pnpm check exit 0 (Node 22). Real logs: 0 of 41 top-level session files are empty or dotfiles, so nothing real disappears. The existing test "newest first, only top-level jsonl" now writes non-empty content into its two files; its expectation is unchanged (empty files are skipped by design now).

reviewers: opus

findings: none
