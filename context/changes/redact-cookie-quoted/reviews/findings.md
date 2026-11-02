# Review findings: redact-cookie-quoted

reviewers: haiku, opus

First commit by OpenCode (GLM-5.3-Flash). OpenCode then ran out of free messages and Agy was out, so opus wrote the second commit, as the shepherd allowed on 2026-11-02. Haiku reviewed both commits; opus read the diff and ran its own probes.

New tests on the old `redact.ts`: 9 fail on the first commit's suite. Real logs, 44610 texts: 17 changed, 0 non-idempotent, 0 fewer redactions, 13 more; masked shapes of the first commit's differences are mostly this project's own test inputs quoted in sessions. Haiku round 2: 56 inputs, 20000 fuzz, 10 adversarial at 1 and 2 MB, no secret shown that main hides, no superlinear time.

| # | Tag | file:line | Finding | Reviewer | Cross-check | Verdict | Evidence |
|---|-----|-----------|---------|----------|-------------|---------|----------|
| 1 | Major | packages/core/src/redact.ts | First commit: `lineEndAt` scans to the end of the text per header; 1 MB of `cookie:"` took 1772 ms, main 80 ms | haiku | opus: ran | fixed | `2bbdf43`, 84 ms, perf test |
| 2 | Major | packages/core/src/redact.ts | First commit: `"Cookie: session=" + value` lost the rest of the line | haiku | opus: ran | fixed | `2bbdf43`, tests |
| 3 | Major | packages/core/src/redact.ts | `Cookie: a=1"; session=x` left the secret visible, same on main | haiku | opus: ran | fixed | `2bbdf43`, test |
| 4 | Major | packages/core/src/redact.ts | `Cookie: session=abc\"def` left the tail visible, same on main | haiku | opus: ran | fixed | `2bbdf43`, tests |
| 5 | Minor | packages/core/src/redact.ts | `Cookie: session=",abc123secret"` stays visible: a value that opens with `,` reads as code. Same on main | haiku | opus: read | deferred | no regression; the cost of keeping code byte for byte |
| 6 | Minor | packages/core/src/redact.ts | `curl -H "Cookie: session=abc"x` loses `"x` | haiku | opus: read | deferred | fails closed |
| 7 | Minor | packages/core/src/redact.ts | A cookie name outside `COOKIE_SECRET_NAME` stays visible: `cookie: x"; y=zzzsecret9` | haiku | opus: read | deferred | by design, same on main |
