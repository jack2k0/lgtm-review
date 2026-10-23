# Review summary: Add a login rate limit.

Branch: `main` · Date: 2026-01-01 · Session: `hints-se`

4 prompts: 1 checked, 1 unchecked, 1 failing, 1 no-changes.

| # | Status | Review | Prompt | Files | +/- |
| ---: | --- | --- | --- | ---: | --- |
| 1 | checked | Read flagged | Add a login rate limit. | 3 | +4 -3 |
| 2 | unchecked | Read flagged | Add a CI step and a Dockerfile. | 2 | +14 -0 |
| 3 | no-changes | Skim | Explain how the repo is laid out. | 0 | +0 -0 |
| 4 | failing | Read flagged | Expose the users endpoint in the public API. | 3 | +5 -3 |

## Needs attention

### Prompt 1: Add a login rate limit.

- Status: checked (pnpm test passed after last edit)
- Review: Read flagged
- **high** `sensitive-path`: `src/auth/session.js`
- **warn** `dependency-change`: `package.json`
- **info** `config-change`: `tsconfig.json`

### Prompt 2: Add a CI step and a Dockerfile.

- Status: unchecked (no checks ran)
- Review: Read flagged
- **high** `sensitive-path`: `.github/workflows/ci.yml`
- **high** `sensitive-path`: `Dockerfile`
- **warn** `unchecked-edit`: `.github/workflows/ci.yml`
- **warn** `unchecked-edit`: `Dockerfile`
- **info** `config-change`: `.github/workflows/ci.yml`

### Prompt 4: Expose the users endpoint in the public API.

- Status: failing (pnpm test failed)
- Review: Read flagged
- **warn** `public-surface`: `openapi.yaml`
- **warn** `public-surface`: `src/index.ts`
- **warn** `public-surface`: `src/routes/users.ts`

---

_Statuses and hints are heuristic and come from the agent's session log (edits and shell commands it ran), not from git or from rerunning anything. Check the diff before trusting them._
