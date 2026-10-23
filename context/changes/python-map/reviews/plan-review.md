# Plan Review: Python imports + Django preset (S-09)

Reviewed: `context/changes/python-map/plan.md`, `packages/core/src/map-extract.ts`, `packages/core/src/map-layout.ts`, `packages/core/src/hints.ts`, `packages/cli/src/map.ts`, `packages/web/src/MapView.tsx`, `context/archive/import-map/plan.md`.

**Verdict:** `approve with changes`
**Findings count:** 10 (0 blocker, 5 major, 5 minor)

---

## Executive Summary

The overall design is sound, adhering strictly to the reduced-scope, node-free core principles established in S-04. The auto-detection of Django roots via `manage.py`, layer derivation, and hint extensions are pragmatic. However, several critical edge cases in the Python import resolution rules (D1/D2) and root ordering (D4) require specification fixes before delegation to prevent worker confusion and bugs.

Phasing assessment: **Yes, Phase 1 and Phase 2 can be completed in a single worker brief** (~320 LOC production, ~300 LOC test code across 8 files), though a 2-phase sequential brief split remains a clean alternative if incremental commits are preferred.

---

## Major Findings

### F1 — MAJOR: Wildcard import `from M import *` drops dependency completely
- **Location:** `plan.md` D1 (line 36) & D2 (line 46)
- **Detail:** D1 extracts `from a import *` as `{ module: "a", names: [] }`. D2 specifies resolution by iterating `names`: *"for each name, try submodule M.n first; names that are not submodules fall back to M itself (added once)"*. When `names` is empty (`names: []`), the loop does not run, and `resolve()` returns `[]`. As a result, wildcard imports produce zero dependency edges on the map.
- **Fix:** Explicitly add to D2: *"If `names.length === 0` (wildcard `from M import *`), resolve directly to module `M` itself (`M.py` or `M/__init__.py`)."*

---

### F2 — MAJOR: Relative dot-only imports (`from . import x`, `from .. import x`) lack fallback to `__init__.py`
- **Location:** `plan.md` D2 (line 47)
- **Detail:** Line 47 defines relative imports as `from . import x = module x in base dir`. If `x` is a function, constant or class defined in `base/__init__.py` rather than a separate submodule `base/x.py`, the rule fails to resolve to `base/__init__.py`. Additionally, the plan does not specify multi-level dot-only imports (e.g. `from .. import x`).
- **Fix:** Unify relative resolution:
  1. Let `k` be the count of leading dots and `rest` the submodule name after the dots (e.g. `""` for `.`, `"models"` for `.models`, `"pkg.mod"` for `..pkg.mod`).
  2. `baseDir` = directory of `fromFile` ascended by `k - 1` directories. If this ascends past repo root, return `[]`.
  3. If `rest` is non-empty, target = `baseDir + "/" + rest.replace(/\./g, "/")`. If `rest` is empty, target = `baseDir`.
  4. For each imported name `x`: check if `target/x.py` or `target/x/__init__.py` exists. If not, fall back to `target.py` or `target/__init__.py`.

---

### F3 — MAJOR: Inline comments and comments inside multi-line parentheses corrupt parsed tokens
- **Location:** `plan.md` D1 (lines 36, 39)
- **Detail:** D1 states: *"Ignored: lines whose first non-space char is #"*. This strips full comment lines, but does not strip inline comments, such as:
  ```python
  from app.models import (
      User,  # primary auth model
      Order,
  )
  import os  # system
  ```
  Splitting by commas without stripping inline comments leaves `# primary auth model\n Order` in the token stream, corrupting the extracted names.
  Similarly, commented-out names (`# OldModel,`) inside parentheses would be parsed as names or corrupt adjacent names.
- **Fix:** Specify that prior to token extraction, trailing comments `#.*$` must be stripped from each line (or stripped after docstring removal).

---

### F4 — MAJOR: Semicolon-separated statements on a single line
- **Location:** `plan.md` D1 (line 34)
- **Detail:** D1 assumes imports occur at logical line start (`^\s*`). In Python, multiple statements may be chained on a single line with semicolons (e.g. `import os; import sys` or `import os; print("init")`). Under the current rule, `import sys` would be missed because it is not preceded by a newline, and code after an import could be captured as part of the module name.
- **Fix:** Specify that statement matching splits lines by `;` or treats `;` as a statement delimiter, matching `import ...` and `from ... import ...` bounded by `;`, `#`, or end-of-line.

---

### F5 — MAJOR: `manage.py` in repo root produces `""`, causing repo root to precede `src/`
- **Location:** `plan.md` D4 (lines 50-54)
- **Detail:** If `manage.py` is at the repository root, `dirOf("manage.py")` is `""`. D4 specifies: *"order: dirs of manage.py sorted, then src, then ""."* If `dirs of manage.py` includes `""`, sorting places `""` at the beginning of the roots array (`["", "src"]`). In a repository with a `src` layout, searching `""` before `src` can cause incorrect resolution. Line 56 already notes that a `manage.py` at repo root needs no prefix.
- **Fix:** Define `manageDirs` as **non-empty** directory paths containing `manage.py`. Order roots as: `[...manageDirs.sort(), ...(hasSrc ? ["src"] : []), ""]` (deduplicated).

---

## Minor Findings

### F6 — MINOR: `isTestPath` missing `test.py`
- **Location:** `plan.md` D6 (line 58)
- **Detail:** D6 adds `conftest.py, *_test.py, tests.py`. In smaller Python projects and older Django setups, `test.py` is very common alongside `tests.py`.
- **Fix:** Match `/^(?:test_.*|.*_test|tests?|conftest)\.py$/i`.

---

### F7 — MINOR: Backslash line continuation should be normalized for both `from` and `import`
- **Location:** `plan.md` D1 (line 38)
- **Detail:** The plan specifies backslash continuation only for `from ... import ...`. However, `import foo, \ \n bar` is valid Python.
- **Fix:** Normalize `\\[ \t]*\r?\n` into whitespace prior to statement matching, naturally handling continuations for both `import` and `from ... import`.

---

### F8 — MINOR: Docstring stripping must preserve exact newline counts
- **Location:** `plan.md` D1 (line 39)
- **Detail:** When replacing `"""..."""` and `'''...'''` blocks, line numbers must be preserved so that `line` in `ExtractedImport` remains accurate.
- **Fix:** Replace matched docstring blocks with `"\n".repeat(newlineCount)` using non-greedy matching `"""[\s\S]*?"""` and `'''[\s\S]*?'''`.

---

### F9 — MINOR: Django package directories for `urls/` in `publicSurfaceKind`
- **Location:** `plan.md` D6 (line 62)
- **Detail:** The plan includes `views/*.py` but only `urls.py`. Large Django projects frequently split URLs into a package (`urls/__init__.py`, `urls/api.py`).
- **Fix:** Check `lowName === "urls.py" || (lowDirs.includes("urls") && lowName.endsWith(".py"))`.

---

### F10 — MINOR: Brief sizing and delegation recommendation
- **Location:** `plan.md` §Phases (lines 69-90)
- **Detail:** The orchestrator inquired whether Phase 1 and Phase 2 can be done in one brief.
- **Assessment:** Phase 1 (core extractor, resolver, layoutRoots, hints) is ~250 LOC + ~200 LOC tests. Phase 2 (CLI scan dispatch, roots detection, web empty-state) is ~70 LOC + ~50 LOC test. Because Phase 2 is tightly coupled to Phase 1 exports and the web change is a single string literal, this is comfortably within the scope of a single implementation brief (~600 LOC total diff). Alternatively, if the team prefers strict intermediate gates (`pnpm check` on core first), Phase 1 and Phase 2 can remain split into two sequential briefs.
