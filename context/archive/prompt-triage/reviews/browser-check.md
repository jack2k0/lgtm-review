# Browser check, S-17 prompt-triage (2026-10-25)

**Visual check: not viewed.** The orchestrator session had no browser tool. Owner to-do (checklist from plan Phase 6): list counts and filter, reload keeps the filter; prompt counts and filter, Back restores the unfiltered view; ↑/↓, Enter, `s`, `m`, Escape; visible focus ring; dark mode; the S-07 Play view (keys, captions).

What was verified without a browser (synthetic fixtures staged as in `packages/cli/src/e2e.test.ts`, built CLI from this branch, `--no-open`, loopback only):

- `GET /api/sessions` without the token → 403; with the token → 36 sessions, every one carries `attentionCount` (sum 46; 24 sessions need attention).
- For a session with `attentionCount` 2, `GET /api/sessions/<id>` has 6 own prompts of which exactly 2 are unchecked/failing/hinted (same rule as `needsAttention`).
- The served bundle contains the filter links (`show=attention`, "Needs attention") and the keyboard help line.
- Behaviour of the controls is covered by the jsdom tests C1–C5 (existing controls) and P1–P8 (prompt table filter and keys), and SSR tests for the session list.
