# Findings: change/map-play-nits

Tier Medium (core play, map-extract; cli map). Source: deferred Nits from agy-play-review (5, 6), opencode-map-review (4), map-fingerprint ledger row 1, play-fixes ledger row 2; brief nits-brief.md items A-E. Implementer: Agy (Gemini 3.8 Flash). Pre-merge review: Opus, diff-only (E keeps behaviour; the comment-tolerant regex has non-overlapping alternatives, no catastrophic backtracking; D follows TypeScript's effective baseUrl, child aliases still override the base). New tests fail on the old code 4/4 (A-D); E covered by existing tests. pnpm check exit 0 (Node 22).

reviewers: opus

findings: none
