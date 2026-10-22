---
starter_id: turborepo
package_manager: npm
project_name: lgtm-review
hints:
  language_family: js
  team_size: solo
  deployment_target: self-host
  ci_provider: github-actions
  ci_default_flow: manual-promotion
  bootstrapper_confidence: verified
  path_taken: custom
  quality_override: false
  self_check_answers:
    typed: true
    from_official_starter: true
    conventions: true
    docs_current: true
    can_judge_agent: true
  has_auth: false
  has_payments: false
  has_realtime: false
  has_ai: false
  has_background_jobs: false
---

## Why this stack

TypeScript monorepo on Turborepo with three packages: `core` (JSONL parser, zod `Story` schema), `cli` (published as `lgtm-review`, run via `npx`), `web` (Vite + React local UI). The registry has no `(cli, js)` default and no JS card tagged `cli-tool`, so Turborepo was chosen by project shape (CLI + SPA sharing one contract), not by product_type. The package boundary enforces "Story JSON = contract core <-> web" in the repo structure. Dev package manager: pnpm (override of the card's npm; the hand-off field stays `npm` per schema; conversion to pnpm workspaces is the first step of F-01; end users use npx). Only `packages/cli` is published; `core` and `web` are private and bundled into it. Deployment is self-host (local tool); CI is GitHub Actions with manual promotion because npm versions cannot be overwritten. Decided by Opus on owner's delegation, 2026-10-23.
