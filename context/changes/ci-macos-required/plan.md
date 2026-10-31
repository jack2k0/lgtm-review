# The macOS job blocks

The owner asked for this on 2026-10-31 after CI run 41207393610 on `6795dbd` passed in full, macOS included.

## Phase 1

In `.github/workflows/ci.yml`, job `other-os`: remove `continue-on-error: true` and the comment above it.

One green run is the evidence so far. If the job turns flaky, the owner can bring the line back.

## Gate
```gate
allow: ^\.github/workflows/ci\.yml$
allow: ^context/(changes|archive)/ci-macos-required/
deps: no
schema: no
```
