# Review findings: shallow-clone-check

reviewers: opencode, opus

findings: none

Verified locally only: the workflow change has not run on GitHub. Depth-1 clone: `pnpm check` exits 0 with Case 8 skipped (18 pass, 1 skipped); the same clone with `CI=1` fails Case 8 (12 pass, 1 fail in `gate.test.mjs`). Full clone: 19 pass, 0 skipped.
