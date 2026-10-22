# Session fixtures

Synthetic, hand-written Claude Code session logs (record shape: `docs/PROPOSAL.md` 7.1)
used by the golden tests in `src/golden.test.ts`. No real logs.

## Adding a fixture

1. Add `sessions/<name>.jsonl` (one JSON record per line; malformed lines are allowed on purpose).
2. Add `sessions/<name>.labels.json`:
   `{ "fixture": "<name>", "source": "synthetic", "prompts": [ { "index": 0, "expectedStatus": "checked", "note": "why" } ] }`
   `expectedStatus` is `checked` | `unchecked` | `failing` | `no-changes`.
   PRD rule: `checked` = the last check after the last edit passed.
3. Generate golden files: `pnpm --filter @lgtm/core test -- -u`, then review the diff in `sessions/__golden__/`.

## Anonymization rules

- `cwd` = `/home/user/project`; `gitBranch` = `main`.
- `sessionId` / `uuid` = obviously fake UUIDs (`00000000-0000-4000-8000-...`).
- No real names, emails, tokens, hostnames or home paths.
- `src/fixtures-secrets.test.ts` scans every file here and fails on secret-like strings
  and any macOS or Linux home path other than the fake one above.
