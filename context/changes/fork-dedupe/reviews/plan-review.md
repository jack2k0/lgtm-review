# Plan review (Agy, Claude Sonnet 4.6, 2026-10-23)

# Plan Review: fork-dedupe (S-13)

Reviewed: `context/changes/fork-dedupe/plan.md`, `packages/cli/src/api.ts`, `packages/core/src/schema.ts`, `packages/web/src/PromptTable.tsx`

---

## F1 — BLOCKING: Ownership tie-break rule leaks into `forkOf` but isn't applied there

**Location:** `plan.md §Desired End State` — `forkOf` definition vs. ownership ordering rule.

**Detail:** The ownership rule says: equal `startedAt` → lexicographically smaller `sessionId` wins. The `forkOf` field is defined as "the most frequent `inheritedFrom` session id, ties by earliest" — "earliest" is ambiguous (earliest `startedAt`? smallest `sessionId`? position in the sorted order?). If a fork chain A→B→C produces a three-way tie in `inheritedFrom` frequency, the tie-break for `forkOf` must be the same comparator as the ownership sort, otherwise the two values can point to different sessions for the same inheritance relationship.

**Fix:** Define `forkOf` tie as "the session id that would win the ownership sort among the tied candidates" (i.e. earliest `startedAt`, then lexicographically smallest `sessionId`), matching the ownership rule exactly.

---

## F2 — BLOCKING: Single-session ETag includes only own file; post-`markInherited` result depends on sibling files

**Location:** `packages/cli/src/api.ts:243` — `etagFor(\`session\0${version}\`)`.

**Detail:** The plan (§ETag/cache) correctly identifies that `/api/sessions/:id` must include the stamps of sibling sessions because `markInherited` is cross-session. The current code computes the ETag from only `versionOf(file)` (one stat + subagent stamp). After Phase 2, a sibling session file changing (adding a new prompt that predates this session's prompts) would change which prompts are marked `inheritedFrom`, but the ETag would stay the same → stale 304 served with wrong inheritance data. The plan says "use the project-level stamp" but doesn't specify a concrete implementation path, leaving this unresolved.

**Fix:** In Phase 2, replace `etagFor(\`session\0${version}\`)` with `etagFor(\`session\0${listStamp}\0${id}\`)` where `listStamp` is computed the same way as the list ETag (all file versions concatenated). The same applies to the prompt route ETag at line 192.

---

## F3 — BLOCKING: `summarize()` in `api.ts` doesn't filter inherited prompts; plan assumes it receives pre-processed sessions

**Location:** `packages/cli/src/api.ts:9-21` — `summarize()`, and `plan.md §Desired End State` (`summarize() receives the processed sessions`).

**Detail:** The plan states `summarize()` will receive sessions already processed by `markInherited`, and that `statusCounts`/`promptCount` are computed over non-inherited prompts. However, `summarize()` currently iterates `s.prompts` without any filter (`for (const p of s.prompts) statusCounts[p.status]++`). Once `PromptAnalysis.inheritedFrom` is added to the schema, the filter must be explicitly applied inside `summarize()` — it cannot rely solely on the caller passing pre-filtered arrays, because `SessionAnalysis.prompts` is the full array (inherited prompts are retained for the detail view). If the caller forgets to pre-process, counts silently inflate.

**Fix:** Apply the filter inside `summarize()` itself: `for (const p of s.prompts) { if (!p.inheritedFrom) statusCounts[p.status]++; }`. Add `inheritedCount` as `s.prompts.filter(p => p.inheritedFrom).length`. This makes correctness independent of call-site discipline.

---

## F4 — WARNING: `schema.ts` missing `inheritedFrom` on `PromptAnalysis` and `inheritedCount`/`forkOf` on `SessionSummary`

**Location:** `packages/core/src/schema.ts:60-78` (`PromptAnalysis`), `100-113` (`SessionSummary`).

**Detail:** The plan specifies adding `PromptAnalysis.inheritedFrom?: string`, `SessionSummary.inheritedCount: number`, and `SessionSummary.forkOf?: string`, but none are present in the current schema. Phase 1 is supposed to deliver these. Since the schema drives Zod validation at runtime and TypeScript types across all packages, shipping Phase 2 consumers before the schema is updated will cause type errors and silent runtime coercions (Zod strips unknown fields by default).

**Fix:** Add to schema in Phase 1 before any consumer code: `inheritedFrom: z.string().optional()` on `PromptAnalysis`; `inheritedCount: z.number().int().nonnegative()` (default 0 via `.default(0)` or explicit) and `forkOf: z.string().optional()` on `SessionSummary`. Update `Analysis` goldens note accordingly.

---

## F5 — WARNING: `PromptTable.tsx` prompt count header uses raw `session.prompts.length` — will show inflated count after fork

**Location:** `packages/web/src/PromptTable.tsx:83` — `{plural(session.prompts.length, "prompt")}`.

**Detail:** The session header displays `plural(session.prompts.length, "prompt")`. After `markInherited`, `session.prompts` still contains inherited prompts (they are shown collapsed). The displayed count will include inherited prompts, contradicting the plan's intent that counts reflect non-inherited prompts. A user seeing "12 prompts" when 8 are inherited is misleading, especially if `SessionSummary.promptCount` (served by the list API) shows 4.

**Fix:** In Phase 2, change to `plural(session.prompts.filter(p => !p.inheritedFrom).length, "prompt")` and add a secondary annotation, e.g. `+ N inherited`, or use the `inheritedCount` field if it is added to `SessionAnalysis` as well.

---

## F6 — WARNING: Fork chains (A→B→C) — `markInherited` ownership map marks B's own prompts as inherited from A when processed at C

**Location:** `plan.md §Desired End State` — "keeps a map `promptUuid -> firstSessionId`".

**Detail:** In a chain A→B→C where B adds 2 new prompts, C copies A+B history: C's copies of B's new prompts should be marked `inheritedFrom: B`. The plan's algorithm (map from first encounter) handles this correctly only if sessions are processed in ascending `startedAt` order. However, the "never marks a prompt inherited from the session itself" guard requires checking `inheritedFrom !== s.sessionId` for each prompt, not just checking against the map's stored session. If B and C share a `startedAt` and B sorts after C due to `sessionId` lexicography, B's new prompts get attributed to C and then C's copies are "from itself" — guard fires but now A's prompts in B are also mis-owned. The fixture requirement ("chain fixtures") must include this exact case.

**Fix:** Specify explicitly in the plan that chain fixture coverage must include `startedAt(B) == startedAt(C)` and verify the determinism test covers it. The algorithm must ensure the "session itself" guard uses the already-sorted session order, not post-hoc comparison.

---

## F7 — WARNING: Phase sizes are asymmetric — Phase 2 is substantially larger with no internal checkpoints

**Location:** `plan.md §Phase 2: Consumers` — success criteria is a single `2.1` checkbox.

**Detail:** Phase 2 touches 11 source files, 5 test surfaces (api, e2e, summary goldens, web viewmodel + render), the smoke script, and the README. Phase 1 has one checkbox (`1.1`) covering 3 files + fixtures. Phase 2 has one checkbox (`2.1`) for all consumers. If Phase 2 partially fails (e.g. web render correct but ETag test broken), there is no intermediate rollback point and no way to tell which consumer is blocking CI without reading the full test log.

**Fix:** Split Phase 2 into at least two sub-phases: `2.1` API/CLI consumers (`api.ts`, `format.ts`, `summary.ts`, `export.ts`, `export-html.ts`, `cli.ts`, ETag tests, smoke); `2.2` Web consumers (`SessionList.tsx`, `PromptTable.tsx`, `viewmodel.ts`, styles, render tests).

---

## F8 — OBSERVATION: `--export`/`--summary` of a session with only inherited prompts — "still works" is under-specified

**Location:** `plan.md §Desired End State` — last sentence of the consumers paragraph.

**Detail:** The plan states this case "shows note" but does not define what the note contains, where it appears in the output format, or whether the exit code changes. For `--export` (HTML), a file with only a note and no table rows is valid. For `--summary` (markdown), the heading structure may be empty. For `--json`, the session appears with all prompts carrying `inheritedFrom`. None of these surface contracts are measurable as written, so the success criterion `2.1` cannot be verified against them.

**Fix:** Add a concrete acceptance criterion: e.g. "When all prompts are inherited, `--summary` emits the session heading plus exactly one line `All N prompts inherited from <id8>. No prompts to review.`; exit code 0; `--export` HTML includes the note in the session card; `--json` output unchanged (all prompts present with `inheritedFrom`)."
