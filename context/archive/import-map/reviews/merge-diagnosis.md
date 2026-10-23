# S-04 Diagnosis & Fix Report

## Summary
- **Worktree**: `/home/jack/git/lgtm-review-import-map`
- **Branch**: `change/import-map` (HEAD `26b1f4a`)
- **Status**: Root cause confirmed, minimal uncommitted fix applied, `pnpm check` green (10/10 tasks successful).

---

## 1. Error Output

Running `pnpm check` on HEAD `26b1f4a` failed at `@lgtm/core#typecheck` with exit code 2:

```
@lgtm/core:typecheck: src/schema.ts:237:3 - error TS1117: An object literal cannot have multiple properties with the same name.
@lgtm/core:typecheck: 
@lgtm/core:typecheck: 237   promptIndex: z.number().int().nonnegative().nullable().optional(),
@lgtm/core:typecheck:       ~~~~~~~~~~~
@lgtm/core:typecheck: 
@lgtm/core:typecheck: src/schema.ts:289:3 - error TS1117: An object literal cannot have multiple properties with the same name.
@lgtm/core:typecheck: 
@lgtm/core:typecheck: 289   notes: z.array(z.string()).optional(),
@lgtm/core:typecheck:       ~~~~~
@lgtm/core:typecheck: 
@lgtm/core:typecheck: Found 2 errors in the same file, starting at: src/schema.ts:237
```

`tsup` build also warned of duplicate keys:
```
[WARNING] Duplicate key "promptIndex" in object literal [duplicate-object-key]
    src/schema.ts:237:2
The original key "promptIndex" is here:
    src/schema.ts:233:2

[WARNING] Duplicate key "notes" in object literal [duplicate-object-key]
    src/schema.ts:289:2
The original key "notes" is here:
    src/schema.ts:282:2
```

---

## 2. Root Cause Analysis

Commit `26b1f4a` merged `change/import-map-web` (`1cc9ed8`, Phase 3 Web) into `change/import-map` (`cf7c032`, Phase 2 CLI).

Both branches independently added `promptIndex` to `MapNode` and `notes` to `ImportMapResponse`, but in slightly different line positions:
- **`MapNode`**:
  - In `1cc9ed8`: `promptIndex` was added right before `deleted: z.boolean()` (line 233).
  - In `cf7c032`: `promptIndex` was added after `deleted: z.boolean()` (line 237).
- **`ImportMapResponse`**:
  - In `1cc9ed8`: `notes` was added right before `layers: z.array(MapLayer)` (line 282).
  - In `cf7c032`: `notes` was added at the end of the schema object after `height` (line 289).

Because the surrounding contexts differed, git's three-way merge cleanly integrated both lines without raising merge conflict markers. However, TypeScript enforces `TS1117` ("An object literal cannot have multiple properties with the same name"), causing `tsc --noEmit` to fail.

Both definitions had identical Zod schemas:
- `promptIndex: z.number().int().nonnegative().nullable().optional()`
- `notes: z.array(z.string()).optional()`

---

## 3. Minimal Fix (Uncommitted Changes)

In `packages/core/src/schema.ts`:
- Deduplicated `promptIndex` in `MapNode`, retaining the more comprehensive JSDoc comment from `cf7c032` (referencing non-inherited prompts per M5).
- Deduplicated `notes` in `ImportMapResponse`, retaining the more comprehensive JSDoc comment from `cf7c032`.

### Git Diff
```diff
diff --git a/packages/core/src/schema.ts b/packages/core/src/schema.ts
index ff8ae3d..f63bb1d 100644
--- a/packages/core/src/schema.ts
+++ b/packages/core/src/schema.ts
@@ -229,8 +229,6 @@ export const MapNode = z.object({
   kind: z.enum(["changed", "neighbour"]),
   /** Verification status of the last prompt that changed the file; null for neighbours. */
   status: Status.nullable(),
-  /** Prompt whose diff the changed node links to; null for neighbours and optional for older servers. */
-  promptIndex: z.number().int().nonnegative().nullable().optional(),
   /** The changed file no longer exists on disk: no edges, click target disabled. */
   deleted: z.boolean(),
   /** Changed nodes: index of the last non-inherited prompt that changed the file (session map) or the requested prompt; null for neighbours. */
@@ -278,8 +276,6 @@ export const ImportMapResponse = z.object({
   truncated: z.boolean(),
   /** Number of ranked 1-hop neighbours dropped by the node cap. */
   hiddenNeighbours: z.number().int().nonnegative(),
-  /** One-line explanations of skipped scan work (missing git, caps hit, external files). */
-  notes: z.array(z.string()).optional(),
   layers: z.array(MapLayer),
   nodes: z.array(MapNode),
   edges: z.array(MapEdge),
```

---

## 4. Verification & Check Results

After applying the fix, `pnpm check` was executed in `/home/jack/git/lgtm-review-import-map`:
- **Result**: `Tasks: 10 successful, 10 total`
- **Typechecks**:
  - `@lgtm/core`: PASSED
  - `@lgtm/web`: PASSED
  - `lgtm-review`: PASSED
- **Builds**:
  - `@lgtm/core` (`tsup` + DTS): PASSED
  - `@lgtm/web` (`vite build`): PASSED
  - `lgtm-review` (`tsup` + `copy-web.mjs`): PASSED
- **Tests**:
  - `@lgtm/core` tests: 18 test files passed (1235 tests)
  - `@lgtm/web` tests: PASSED
  - `lgtm-review` tests: 12 test files passed (461 tests)
  - `lgtm-review:smoke`: ALL PASSED (tarball, --summary, forked sessions, subagent status, --export, server auth, detail routes, conditional requests 200->304, UI served)

No commits or pushes were made. The working tree retains the minimal uncommitted fix ready for review.
