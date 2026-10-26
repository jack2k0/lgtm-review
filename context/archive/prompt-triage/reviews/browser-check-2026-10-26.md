# Browser check, S-17 / S-19 / S-21 (2026-10-26)

Headless Chromium (Playwright 1.56, run from the orchestrator's scratchpad, nothing added to the repo) against the built CLI on main 25d599e, loopback only. Data: the synthetic fixtures staged as in `packages/cli/src/e2e.test.ts` (40 sessions), plus this repo's own sessions for the Git and Map views only. Viewports 1280×900 light and dark, 390×900 light. Screenshots stay in the scratchpad (not committed).

## Works as specified
- No page errors or console errors in any view.
- S-17: the list counts ("40 sessions … 28 sessions need attention"), All / Needs attention links, per-session badges ("2 prompts need attention"); the filter is in the address (`#/?show=attention`); opening a session from the filtered list and pressing Escape returns to `#/?show=attention` (filter kept). Tab reaches the first prompt row button, ↑/↓ move, Enter expands, `s` opens Steps. Key legend under the table.
- Dark mode: status colours, badges, time bars and hint chips stay readable.
- S-21: the Git cross-check view lists "Changed in git but not in the log" with Where and Status (A/M/R) and the commit window ("38 commits, merges excluded"); without a repository it says "Not a git repository, or git is not available."
- Map: wide maps scroll inside their own container (`.map-scroll`), the page does not.

## Observations for the owner (no change made)
1. **Narrow screens (390 px):** the session page is 903 px wide (the page scrolls sideways) and the prompt table squeezes Prompt/Reason to a few characters; the session list squeezes titles. The tool is desktop-first, so this is a product call: wrap tables in a horizontal scroller, or accept.
2. **Escape on Steps / Map / Git does nothing** (Diff → Steps and Play → Done have it). This was an explicit S-17 non-goal; consider making Escape go back one level everywhere.
3. **Git cross-check in a multi-agent workflow:** on this repo 87 files are "changed in git but not in the log" for an orchestrator session, because other agents (Agy, OpenCode) and merges of their branches commit inside the session's time window. Correct by the rule, but noisy for this workflow; a filter by author or by files the session touched could be a later idea.
4. **S-19 worktree labels not seen:** neither the fixtures nor this repo's projects dir have sessions recorded inside a second worktree. Covered by `api.worktrees.test.ts` and `worktree.test.tsx`; a real look needs a session started in a worktree.

Still for a human: taste (density, wording, colours) and the feel of the S-07 Play view.
