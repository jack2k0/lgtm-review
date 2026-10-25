# Triage in the browser (S-17, FR-016) Implementation Plan

## Overview

On a real session with dozens of prompts the reviewer has to scan every row to find the ones that are unchecked, failing or flagged by a hint. This slice adds a **Needs attention** filter and counts on both levels (session list, prompt table), keyboard navigation in the prompt table (↑/↓, Enter, `s` Steps, `m` Map, Escape back to the list), and the first DOM test environment of `packages/web`, whose first tests also cover existing controls that were never exercised (row expand, inherited group, step actions, the S-07 Play keys, Live pause).

"Needs attention" is one rule everywhere: a prompt is unchecked or failing or has at least one review hint. That is the rule of the "Needs attention" section of `--summary`; it moves to core so the summary, the API and the web share it.

## Current State Analysis

- `packages/web` tests run in Node only and render markup with `renderToStaticMarkup` (e.g. `SessionList.test.tsx`, `inherited.test.tsx`, `steps.test.tsx`, `play.test.tsx`); nothing clicks or presses keys. `vite.config.ts`: `test.include = ["src/**/*.test.{ts,tsx}"]`; no DOM library is installed (`happy-dom`/`jsdom` appear in the lockfile only as vitest's optional peers).
- `packages/web/src/PromptTable.tsx`: `Row` (L28-69, toggle `button.rowbtn` with `aria-expanded`, detail row `tr.detail`), `InheritedGroup` (L86-105, `button.inherited-toggle`), `PromptTable` (L107-166: `splitInherited` → own/inherited, paging with `visiblePrompts`/`nextLimit` and `PROMPT_PAGE = 500`, header `N prompts + K inherited`).
- `packages/web/src/SessionList.tsx` (L5-56): one table of `SessionSummary` rows, status dots from `statusCounts` (own prompts only), "archived" badge.
- `packages/web/src/App.tsx`: `ListView` (L22), `SessionView` (L27, renders `PromptTable` with `key={d.sessionId}`), `Routed` (L88); live polling via `useLive(fetcher, key)` with keys `"list"` and `` `s:${id}` ``. `DiffRoute` and `PlayView` already register window `keydown` listeners for Escape/arrows.
- `packages/web/src/viewmodel.ts`: `Route` (L124-130), `parseRoute` (L143-176: anything unknown → list), `routeHref` (L179-198), `plural`, `routeHref({ kind: "list" })` = `#/`.
- `packages/web/src/styles.css`: colour tokens are contrast-tested by `styles.test.ts` (light and dark); `.marker`, `.more`, `.rowbtn:focus-visible` exist.
- `packages/cli/src/summary.ts` L133-135: local `needsAttention(p) = p.hints.length > 0 || unchecked || failing`.
- `packages/cli/src/api.ts` `summarize()` (L21-58) builds `SessionSummary` (own-prompt `statusCounts`, `inheritedCount`, `forkOf`, `archived`); `api.test.ts` L64 asserts the exact key list.
- `packages/core/src/schema.ts` `SessionSummary` (L104-124); `packages/core/src/index.ts` (85 lines, re-exports).

## Desired End State

- Prompt table header: `5 prompts + 2 inherited · 3 prompts need attention`; a filter bar **All (5)** / **Needs attention (3)** (links, the active one `aria-current="page"`); `#/session/<id>?show=attention` shows only own prompts that need attention, with `Showing 3 of 5 prompts.` or `No prompts need attention.`; the inherited group is unchanged.
- Keys in the prompt table: with focus on a prompt row button, ↓/↑ move focus to the next/previous row button, `s` opens its Steps, `m` its Map, Enter/Space toggle the row (native button); Escape anywhere on the session page (not while typing in a field) goes to `#/`. A one-line key legend under the table.
- Session list: `9 sessions for <dir> · 3 sessions need attention`, filter bar **All (9)** / **Needs attention (3)** (`#/?show=attention`), and per row a marker `4 prompts need attention`.
- `GET /api/sessions` carries `attentionCount` per session. `--summary` output is byte-identical (same rule, now imported from core).
- `packages/web` has DOM tests (`*.dom.test.tsx`, jsdom) that click and press keys, run by `pnpm check`.

## What We're NOT Doing

- No change to `--list` text, `--json`, `--summary` or `--export` output; no new status value; no change to the status rule or hints (S-16 and S-18 territory).
- No roving tabindex (every row button stays in the Tab order), no Home/End, no type-ahead, no search box, no row virtualisation.
- No Escape handling on the Steps or Map views (they keep their back links); no keyboard navigation in the session list beyond Tab (its rows are links).
- No worktree column (S-19), no persistence of the filter beyond the URL, no change to live polling (the filter is client-side; poll keys stay the same).

## Do-not-touch guard (S-16 merged; S-18 may run next to this)

S-16 (doc-edits) was merged on main at ab9f9c9 while this plan was written; branch `change/prompt-triage` from main at or after ab9f9c9. The guard below keeps S-17 from regressing S-16's merged work and keeps it disjoint from S-18 (scoped-checks), which may start while S-17 is in flight and owns the core analysis files and goldens. This change must NOT touch:

- `packages/core/src/analyze.ts`, `packages/core/src/analyze.test.ts`
- `packages/core/src/hints.ts`, `packages/core/src/hints.test.ts`
- `packages/core/src/check-patterns.ts`, `packages/core/src/check-patterns.test.ts`
- anything under `packages/core/fixtures/` (fixtures, labels and `__golden__/`); no golden may change in this slice
- `scripts/audit-status.mjs`, `packages/cli/src/audit-status.test.ts`
- `packages/cli/README.md` outside the one new section "Triage and keyboard" (S-16 owns "Status accuracy and limits" and "Review hints")
- `context/foundation/**` and `context/archive/**` (orchestrator only)

Files this change owns: `packages/core/src/{schema.ts,index.ts}` (one field, one appended export line), new `packages/core/src/attention{,.test}.ts`, `packages/cli/src/{api.ts,api.test.ts,summary.ts}`, everything under `packages/web/`, `pnpm-lock.yaml`. The export in `index.ts` is appended at the end of the file to stay away from any other edit.

Schema-first rule: if S-18 is in flight at the same time (it adds the `HintRule` value `check-scope`), the orchestrator commits D4 (`SessionSummary.attentionCount`) and S-18's enum value together on main before either branch edits `schema.ts`; phase 2 then skips its schema step and rebases onto that commit.

Check before every phase commit (prints nothing):

```
git diff --name-only "$(git merge-base main HEAD)" HEAD -- . ':!context/changes/prompt-triage' \
  | grep -E '^(packages/core/src/(analyze|hints|check-patterns)(\.test)?\.ts|packages/core/fixtures/|scripts/audit-status\.mjs|packages/cli/src/audit-status\.test\.ts|context/)'
```

and `git diff "$(git merge-base main HEAD)" -- packages/cli/README.md` shows only an added block between `## Steps and diff` and `## Import map`. The orchestrator runs `pnpm check` on main after every merge.

## Design decisions (binding)

D1. **DOM library: `jsdom` 30.1.2, dev dependency of `packages/web` only, pinned exact** (`"jsdom": "30.1.2"`, installed with `pnpm --filter @lgtm/web add -D --save-exact jsdom@30.1.2`). Why:
  - happy-dom (the other vitest option) has six critical/high advisories since 2024; the latest, GHSA-834v-8h66-3h79 (high, CVSS 8.8), covers every version from 17.0.0 to 21.0.3, so with CI's `pnpm audit --audit-level=high` only 21.0.4 (published 2026-10-20, five days ago) would pass today, and the next advisory would break CI again;
  - jsdom has no advisories in the npm database (checked 2026-10-25); 30.1.2 was published 2026-10-04 (three weeks old; 30.1.3 is ten days old) and its whole tree audits clean (`pnpm audit --audit-level=high`: "No known vulnerabilities found");
  - a spike in a scratch project (2026-10-25) with the repo's versions — vitest 4.1.12, react/react-dom 19.3.1, jsdom 30.1.2 — passed: `createRoot` + `act`, `focus()`, a bubbling `KeyboardEvent` reaching a React `onKeyDown`, `click()`, `window.location.hash` assignment (environment start-up about 0.3 s);
  - exact pin: the test environment is part of reproducible checks; upgrades are deliberate commits. It is never shipped: `packages/web` is bundled into the CLI and jsdom is not imported by app code.
  - Requirements and gaps: jsdom 30 needs Node `^22.22.2 || ^24.15.0 || >=26` (local 22.23.3; CI installs the latest 22 and 24). jsdom has no `matchMedia` (PlayView's reduced-motion check returns false, so tests pass `initialPlaying={false}`), no `scrollIntoView` (app code must not call it; `focus()` scrolls in browsers) and no layout (no size assertions).

D2. **DOM test layout.** DOM tests are files named `*.dom.test.tsx` whose first line is `// @vitest-environment jsdom`; every other test keeps running in Node and is not changed. One helper, `packages/web/src/testing/dom.ts`:

```ts
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

// React 19: mark the environment so act() flushes renders and effects.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

/** Renders `node` into a fresh container attached to document.body; unmounted after each test. */
export async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));
  return container;
}

/** A bubbling, cancelable keydown on `target` (default: the focused element); returns it so tests can read `defaultPrevented`. */
export async function press(key: string, init: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body): Promise<KeyboardEvent> {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(ev);
  });
  return ev;
}

export async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.container.remove();
  }
  window.location.hash = "";
});
```

  Test data builders shared by the DOM tests live in `packages/web/src/testing/fixtures.ts` (`makePrompt`, `makeSession`, `makeSummary`, `makeDetail`, `makeMap`, `makePlay`), copied from the builders already in `inherited.test.tsx`, `SessionList.test.tsx`, `steps.test.tsx` and `play.test.tsx` (those files stay as they are).

D3. **Shared rule in core**, new `packages/core/src/attention.ts`, exported by appending `export { needsAttention } from "./attention.js";` at the end of `packages/core/src/index.ts`:

```ts
import type { PromptAnalysis } from "./schema.js";

/**
 * A prompt needs attention (FR-016) when it is unchecked or failing or has at least one review hint:
 * the rule of the "Needs attention" section of `--summary`. Callers leave inherited prompts out.
 */
export function needsAttention(p: Pick<PromptAnalysis, "status" | "hints">): boolean {
  return p.hints.length > 0 || p.status === "unchecked" || p.status === "failing";
}
```

  `packages/cli/src/summary.ts` deletes its local copy and imports this one; its output must stay byte-identical (summary goldens unchanged).

D4. **Schema**: `SessionSummary` gains, after `archived`:

```ts
  /** Own (non-inherited) prompts that need attention (`needsAttention`). Always set by the API. */
  attentionCount: z.number().int().nonnegative().optional(),
```

  Optional so older data and existing web test builders still type-check. `summarize()` in `packages/cli/src/api.ts` always sets it (counted in the existing loop over own prompts) and places it right after `inheritedCount`. The web falls back to `statusCounts.unchecked + statusCounts.failing` when it is absent. This is S-17's only `schema.ts` edit; it lands in phase 2 before any web code uses it (see the schema-first rule in the guard when S-18 runs at the same time).

D5. **Routes** (`packages/web/src/viewmodel.ts`): `{ kind: "list"; show?: "attention" }` and `{ kind: "session"; id: string; show?: "attention" }`. `parseRoute` recognises exactly `#/?show=attention` and `#/session/<id>?show=attention` (checked before the existing regex); any other query on these two routes behaves as today (list). `routeHref` adds `?show=attention` only when `show === "attention"`, so every existing href is byte-identical. A parsed route never carries a `show` key when the query is absent.

D6. **Web triage module**, new `packages/web/src/triage.ts` (pure; the components import it):

```ts
import { needsAttention, type PromptAnalysis, type SessionSummary } from "@lgtm/core";
import { plural } from "./viewmodel";

export type Show = "all" | "attention";

/** Own (non-inherited) prompts that need attention, in table order. */
export function attentionPrompts(prompts: readonly PromptAnalysis[]): PromptAnalysis[] {
  return prompts.filter((p) => p.inheritedFrom === undefined && needsAttention(p));
}

/** Prompts of a session that need attention; without `attentionCount` (older server) unchecked + failing. */
export function sessionAttention(s: Pick<SessionSummary, "attentionCount" | "statusCounts">): number {
  return s.attentionCount ?? s.statusCounts.unchecked + s.statusCounts.failing;
}

/** "1 prompt needs attention", "3 prompts need attention", "0 sessions need attention". */
export function needText(n: number, noun: string): string {
  return `${plural(n, noun)} ${n === 1 ? "needs" : "need"} attention`;
}

export interface KeyLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
}

/** Key pressed on a focused prompt row button; null for anything else or with a modifier. */
export function rowKey(e: KeyLike): "next" | "prev" | "steps" | "map" | null {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === "ArrowDown") return "next";
  if (e.key === "ArrowUp") return "prev";
  if (e.key === "s") return "steps";
  if (e.key === "m") return "map";
  return null;
}

/** Escape on the session page goes back to the list, except while typing in a field. */
export function escapeToList(e: KeyLike & { target?: EventTarget | null }): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = (t?.tagName ?? "").toUpperCase();
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable === true);
}
```

D7. **Prompt table** (`PromptTable.tsx`; `PromptTable({ session, show = "all" }: { session: SessionAnalysis; show?: Show })`):
  - `attention = attentionPrompts(session.prompts)`; `rows = show === "attention" ? attention : own`; paging over `rows` (`visiblePrompts(rows, limit)`, Show more uses `nextLimit(limit, rows.length)`).
  - Header line: today's text, then ` · ${needText(attention.length, "prompt")}` when `own.length > 0` (so `inherited.test.tsx`'s "2 prompts + 3 inherited" still matches).
  - When `own.length > 0`, right after the header: `<nav className="filters" aria-label="Filter prompts">` with `<a href={routeHref({ kind: "session", id })}>All ({own.length})</a>` and `<a href={routeHref({ kind: "session", id, show: "attention" })}>Needs attention ({attention.length})</a>`; the active one has `aria-current="page"`.
  - `show === "attention"`: `<p className="muted">Showing {rows.length} of {own.length} prompts.</p>`; when `rows.length === 0`, `<p className="empty">No prompts need attention.</p>` replaces the legend and the table. The inherited group renders as today in both modes.
  - `Row`'s `button.rowbtn` gets `data-index={p.index}`.
  - The own table, Show more and the inherited group are wrapped in `<div className="prompt-rows" onKeyDown={onRowsKey}>`. `onRowsKey` acts only when `e.target` matches `button.rowbtn` and `rowKey(e)` is not null; it then calls `e.preventDefault()`. `next`/`prev`: focus the next/previous `button.rowbtn` in DOM order inside the wrapper (no wrap-around, nothing at the ends). `steps`/`map`: `window.location.hash = routeHref({ kind: "steps" | "map", id: session.sessionId, index: Number(target.dataset.index) })` (two explicit branches for the types). No `scrollIntoView`.
  - Escape: a `useEffect` window `keydown` listener (as `DiffRoute` does): `if (escapeToList(e)) { e.preventDefault(); window.location.hash = routeHref({ kind: "list" }); }`, removed on unmount.
  - Under the rows, when `rows.length > 0`: `<p className="muted keys">Keys: Tab to a prompt, ↑/↓ move, Enter expands, s Steps, m Map, Esc back to sessions.</p>`.

D8. **Session list** (`SessionList.tsx`; `SessionList({ data, show = "all" }: { data: SessionsResponse; show?: Show })`), unchanged when `data.sessions` is empty:
  - `attention = data.sessions.filter((s) => sessionAttention(s) > 0)`; `rows = show === "attention" ? attention : data.sessions`.
  - Line: `{plural(n, "session")} for {dir} · {needText(attention.length, "session")}`.
  - `<nav className="filters" aria-label="Filter sessions">` with **All (n)** → `routeHref({ kind: "list" })` and **Needs attention (a)** → `routeHref({ kind: "list", show: "attention" })`, `aria-current="page"` on the active one.
  - Filtered: `<p className="muted">Showing {rows.length} of {n} sessions.</p>`; when empty, `<p className="empty">No sessions need attention.</p>` replaces the table.
  - Statuses cell, after the dots: `<span className="marker">{needText(k, "prompt")}</span>` when `k = sessionAttention(s)` is above 0.

D9. **App** (`App.tsx`): `Routed` passes `route.show ?? "all"` to `ListView` and `SessionView`, which pass it to `SessionList` / `PromptTable`. Poll keys stay `"list"` and `` `s:${id}` ``, so switching the filter never refetches.

D10. **Styles** (`styles.css`), no new colour tokens (`styles.test.ts` unchanged):

```css
.filters { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0; font-size: 13px; }
.filters a[aria-current="page"] { color: var(--text); font-weight: 700; text-decoration: none; }
.keys { font-size: 12px; margin-top: 6px; }
```

## Working rules for implementers

- Branch `change/prompt-triage` in the worktree `../lgtm-review-prompt-triage` (the orchestrator creates both). One commit per phase, message `feat(prompt-triage): phase N — <summary>`; tick the phase's Progress boxes in the same commit.
- Node 22 and pnpm 11 (root `packageManager`). If `pnpm` is not on the PATH, put `$HOME/.local/opt/node22/bin` first on the PATH and run `corepack pnpm <args>`.
- Web tests import `@lgtm/core` from its `dist`: after any core change run `pnpm build` (or `pnpm --filter @lgtm/core build`) before `pnpm --filter @lgtm/web test`.
- Run the Conflict guard check before each commit. Fixtures are synthetic; do not read `~/.claude`; do not send repository content to external services.
- Every string from a session log stays a React text node (no `dangerouslySetInnerHTML`); the new UI text is fixed wording plus numbers.

## Phase 1: DOM test environment and tests of existing controls (web)

Suggested worker: Sonnet (or Haiku with the D2 code). No app code changes.

**Files**: `packages/web/package.json`, `pnpm-lock.yaml` (both only through the `pnpm add` command in D1), new `packages/web/src/testing/dom.ts`, new `packages/web/src/testing/fixtures.ts`, new `packages/web/src/controls.dom.test.tsx`.

Tests in `controls.dom.test.tsx` (first line `// @vitest-environment jsdom`):
- C1 prompt row: clicking `button.rowbtn` sets `aria-expanded="true"` and renders `tr.detail` containing "Reason:"; a second click collapses it (no `tr.detail`).
- C2 inherited group: one own and two inherited prompts (`inheritedFrom: "abcdef0123456789"`); clicking `button.inherited-toggle` sets `aria-expanded="true"` and shows the inherited prompt texts.
- C3 steps: a step with two actions and the file `src/a.ts`, `onOpenFile = vi.fn()`; clicking `button.disclosure` shows `ol.actions` with 2 items; clicking `button.chip` calls `onOpenFile` once with `"src/a.ts"`.
- C4 play keys: `<PlayView sessionId="s" map={makeMap()} play={makePlay(3 beats, prompt 0)} initialPlaying={false} />`; `.play-counter` reads `1 / 3`; `press("ArrowRight", {}, document.body)` → `2 / 3`; `ArrowLeft` → `1 / 3`; `press(" ", {}, document.body)` → the play button's `aria-label` is `Pause`; `press("Escape", {}, document.body)` → `window.location.hash === "#/session/s/prompt/0/map"`.
- C5 live: `<LiveIndicator paused={false} status={{ updatedAt: null, lost: null }} onToggle={fn} />`; clicking `button.live-btn` calls `fn` once.

### Success Criteria

- `pnpm --filter @lgtm/web typecheck` and `pnpm --filter @lgtm/web test` pass; the five C tests run in jsdom, all existing web tests still run in Node and pass unchanged.
- `packages/web/package.json` has exactly one new entry, `"jsdom": "30.1.2"` under `devDependencies`; `pnpm audit --audit-level=high` reports no vulnerabilities.
- `pnpm check` green (typecheck, tests, build, pack smoke, perf). Conflict guard prints nothing.

## Phase 2: Shared rule and the session count (core + CLI)

Suggested worker: Haiku, Gemini or OpenCode. Depends on nothing in phase 1.

**Files**: new `packages/core/src/attention.ts`, new `packages/core/src/attention.test.ts`, `packages/core/src/index.ts` (one appended line), `packages/core/src/schema.ts` (D4), `packages/cli/src/api.ts`, `packages/cli/src/api.test.ts`, `packages/cli/src/summary.ts`.

Steps and tests:
1. D3 and D4.
2. `attention.test.ts`: `test.each` over (status, hints) → expected: (checked, none) false; (checked, one `info` hint) true; (unchecked, none) true; (failing, none) true; (no-changes, none) false; (no-changes, one hint) true.
3. `summarize()` sets `attentionCount` (own prompts only). `api.test.ts`: add `"attentionCount"` to the key list at L64; new test: for every session in `GET /api/sessions`, `attentionCount` equals the number of prompts of `GET /api/sessions/<id>` without `inheritedFrom` that have hints or are unchecked/failing.
4. `summary.ts`: remove the local `needsAttention`, `import { needsAttention } from "@lgtm/core"`.

### Success Criteria

- `pnpm build`, then `pnpm --filter @lgtm/core test` and `pnpm --filter lgtm-review test` pass without `-u`; `git status --porcelain packages/core/fixtures` prints nothing (summary output byte-identical).
- `pnpm check` green. Conflict guard prints nothing.

## Phase 3: Web triage logic and routes (pure)

Suggested worker: Haiku, Gemini or OpenCode. Depends on phase 2 (imports `needsAttention`, reads `attentionCount`).

**Files**: new `packages/web/src/triage.ts` (D6), new `packages/web/src/triage.test.ts`, `packages/web/src/viewmodel.ts` (D5), `packages/web/src/viewmodel.test.ts`.

Tests:
- `attentionPrompts`: keeps unchecked, failing and hinted own prompts in order; drops checked/no-changes without hints and every inherited prompt.
- `sessionAttention`: uses `attentionCount` when present (also 0); falls back to unchecked + failing.
- `needText`: `needText(1, "prompt")` = `1 prompt needs attention`; `needText(0, "session")` = `0 sessions need attention`; `needText(3, "prompt")` = `3 prompts need attention`.
- `rowKey`: ArrowDown → next, ArrowUp → prev, `s` → steps, `m` → map, `S`/`x`/Enter/ArrowLeft → null; any of alt/ctrl/meta/shift or `defaultPrevented` → null.
- `escapeToList`: true for targets body, a button, null; false for INPUT, TEXTAREA, SELECT, `isContentEditable: true`, any modifier, `defaultPrevented`, other keys.
- Routes: `parseRoute("#/?show=attention")` toStrictEqual `{ kind: "list", show: "attention" }`; `parseRoute("#/session/a%2Fb?show=attention")` toStrictEqual `{ kind: "session", id: "a/b", show: "attention" }`; round trips through `routeHref`; `routeHref({ kind: "list" })` stays `#/` and `routeHref({ kind: "session", id: "x" })` stays `#/session/x`; `parseRoute("#/session/abc")` toStrictEqual `{ kind: "session", id: "abc" }` (no `show` key); `#/session/x?show=all`, `#/session/x?show=attention&y=1`, `#/?show=bogus`, `#/session/%E0%A4%A?show=attention` → `{ kind: "list" }`. Every existing routing test passes unchanged.

### Success Criteria

- `pnpm build` then `pnpm --filter @lgtm/web test` pass; `pnpm check` green. Conflict guard prints nothing.

## Phase 4: Prompt table — counts, filter, keys (web)

Suggested worker: Sonnet. Depends on phases 1 and 3.

**Files**: `packages/web/src/PromptTable.tsx` (D7), `packages/web/src/App.tsx` (D9, session part), `packages/web/src/styles.css` (D10), new `packages/web/src/prompts.dom.test.tsx`.

DOM tests, on a session with own prompts 0 checked (no hints), 1 unchecked, 2 checked with one `warn` hint, 3 failing, 4 no-changes, plus prompts 5 and 6 inherited (`inheritedFrom: "abcdef0123456789"`, unchecked):
- P1 header contains `5 prompts + 2 inherited · 3 prompts need attention`.
- P2 filter links: hrefs `#/session/<id>` and `#/session/<id>?show=attention`, texts `All (5)` and `Needs attention (3)`, `aria-current="page"` on All.
- P3 `show="attention"`: own row buttons have `data-index` 1, 2, 3 only; `Showing 3 of 5 prompts.`; `aria-current` on Needs attention; the inherited toggle is still there.
- P4 `show="attention"` on a session where nothing needs attention: `No prompts need attention.` and no own row buttons.
- P5 arrows: focus the first row button; ArrowDown focuses the second and the returned event has `defaultPrevented === true`; ArrowUp returns to the first; ArrowUp on the first keeps focus; ArrowDown on the last own row keeps focus while the inherited group is closed; after opening the group, ArrowDown from the last own row focuses the first inherited row.
- P6 with focus on the row with `data-index="2"`: `s` → `window.location.hash === "#/session/<id>/prompt/2"`; `m` → `#/session/<id>/prompt/2/map`; `s` with `shiftKey` or `ctrlKey`, and `x`, leave the hash unchanged.
- P7 Escape on `document.body` → `#/`; Escape while a focused `<input>` (appended to the body) is the target → hash unchanged; Escape with `ctrlKey` → unchanged.
- P8 the key legend is rendered when rows exist and absent in the P4 case.
- Existing `inherited.test.tsx` and `hints.test.tsx` pass unchanged.

### Success Criteria

- `pnpm --filter @lgtm/web typecheck`, `pnpm --filter @lgtm/web test` and `pnpm check` green; `styles.test.ts` unchanged and green. Conflict guard prints nothing.

## Phase 5: Session list and README (web + docs)

Suggested worker: Haiku, Gemini or OpenCode. Depends on phase 3.

**Files**: `packages/web/src/SessionList.tsx` (D8), `packages/web/src/App.tsx` (D9, list part), `packages/web/src/SessionList.test.tsx` (new SSR cases; the list has links only, so no DOM test is needed), `packages/cli/README.md` (one new section).

Tests (added to `SessionList.test.tsx`, existing cases unchanged):
- L1 three sessions with `attentionCount` 0, 1 and 4: the line reads `3 sessions for /repo · 2 sessions need attention`.
- L2 markers `1 prompt needs attention` and `4 prompts need attention`; none on the session with 0.
- L3 filter hrefs `#/` and `#/?show=attention`, `aria-current="page"` on the active link.
- L4 `show="attention"`: only the two sessions are rendered and `Showing 2 of 3 sessions.`.
- L5 all counts 0 and `show="attention"`: `No sessions need attention.`, no table.
- L6 a summary without `attentionCount` but with unchecked 1 and failing 1 shows `2 prompts need attention`.

README: insert this section between `## Steps and diff` and `## Import map`:

```markdown
## Triage and keyboard

A prompt **needs attention** when it is unchecked or failing or has at least one review hint (the rule of the "Needs attention" section of `--summary`); inherited prompts are not counted. The prompt table says how many need attention ("12 prompts · 4 prompts need attention") and **All** / **Needs attention** above it switch between all prompts and only those. The choice is part of the address (`#/session/<id>?show=attention`), so reload and Back keep it. The session list shows the same count per session and has the same filter (`#/?show=attention`). `GET /api/sessions` carries it as `attentionCount`.

Keyboard in the prompt table: Tab to a prompt, then ↑/↓ move between prompts, Enter or Space expands or collapses the row, `s` opens its Steps and `m` its import map. Escape goes back to the session list. The keys act only on a focused prompt row (Escape anywhere on the page) and never while you type in a field.
```

### Success Criteria

- `pnpm check` green. The README diff is only the added section. Conflict guard prints nothing.

## Phase 6: Browser check, docs and archive (orchestrator only)

1. Browser check without real logs: copy `packages/core/fixtures/sessions/*.jsonl` (and the subagent folders) into `<tmp>/projects/-home-user-project/` with the uuid prefixing used in `packages/cli/src/e2e.test.ts`, run `node packages/cli/dist/cli.js --projects-dir <tmp>/projects --dir /home/user/project --no-open` and open the printed URL (owner, or the orchestrator with a browser tool). Checklist: list counts and filter, reload keeps the filter; prompt counts and filter, Back restores the unfiltered view; ↑/↓, Enter, `s`, `m`, Escape; visible focus ring; dark mode; the S-07 Play view (keys, captions), which had never been viewed in a browser. Record the outcome, or "not viewed" if no browser was available, in `context/changes/prompt-triage/reviews/browser-check.md`.
2. Roadmap S-17 → done; PRD FR-016 unchanged unless the check found a gap; archive to `context/archive/prompt-triage/`.

## Progress

### Phase 1: DOM test environment

- [x] 1.1 jsdom 30.1.2 (exact, dev) + `testing/dom.ts` + `testing/fixtures.ts`; C1-C5 green; audit clean; `pnpm check` green

### Phase 2: Shared rule and session count

- [ ] 2.1 `needsAttention` in core, `SessionSummary.attentionCount`, `summarize()`, `summary.ts` reuse; no golden change; `pnpm check` green

### Phase 3: Triage logic and routes

- [ ] 3.1 `triage.ts` + `?show=attention` routes with tests; `pnpm check` green

### Phase 4: Prompt table

- [ ] 4.1 counts, filter, keys, styles; P1-P8 green; `pnpm check` green

### Phase 5: Session list and README

- [ ] 5.1 counts, filter, markers; L1-L6 green; README section; `pnpm check` green

### Phase 6: Orchestrator

- [ ] 6.1 browser check recorded
- [ ] 6.2 roadmap, PRD, archive
