# Python imports + Django preset (S-09) Implementation Plan

## Overview

The S-04 import map shows only TS/JS files. Python projects (the owner's wdAir is Django) get an empty map ("No TS/JS files changed"). This slice adds a pure Python import extractor/resolver in core, wires `.py` files into the CLI map scan, adds a Django-aware layer rule, and teaches review hints the common Python/Django manifest, config and public-surface files.

## Current State Analysis

- `packages/core/src/map-extract.ts`: regex TS/JS extractor (`extractImports`), `createResolver` (relative + tsconfig aliases, injected `MapHost`). TS/JS only.
- `packages/core/src/map-layout.ts`: `layerOf(path)` = first segment, or `packages/<x>` / `apps/<x>`. Pure, deterministic.
- `packages/cli/src/map.ts`: `SOURCE_RE = /\.(?:m|c)?[jt]sx?$/`, `isMapSource`, `SKIP_DIRS`; one resolver; `importsOf(rel)` uses `extractImports` + `edgeKindFor`. Candidates for incoming edges = `git ls-files` filtered by `isMapSource`, capped (5000 files / 512 KB).
- `packages/web/src/MapView.tsx:75`: empty state "No TS/JS files changed".
- `packages/core/src/hints.ts`: already Python-aware in places (`test_*.py`, `@pytest.mark.skip`, `assert`, `requirements*.txt`, `pyproject.toml`, `migrations` sensitive). Missing: `conftest.py`/`*_test.py`/`tests.py` as tests, `poetry.lock`/`uv.lock`/`Pipfile(.lock)`/`setup.py`/`setup.cfg` as manifests, Python tool configs, Django `urls.py`/`views.py`/`serializers.py`/`settings.py`.
- `check-patterns.ts` already recognises `pytest`, `python -m pytest|unittest|mypy`, `manage.py test`, `uv run`.

## Desired End State

- Changed `.py` files and their 1-hop in-repo neighbours (both directions) appear on the map, coloured by status like TS/JS nodes, in the same response; mixed TS + Python repos show both.
- Django projects get layers per Django app (e.g. `backend/orders`), not one big `backend` band.
- Review hints flag Python/Django manifests, configs, tests and public surface.

## What We're NOT Doing

- No Python AST / no running Python; regex only (same tolerance stance as S-04 M7).
- No `sys.path` hacks, `.pth` files, namespace-package edge cases beyond "directory without `__init__.py` still resolves `pkg/mod.py`", no `importlib.import_module("x")` / `__import__`.
- No virtualenv / site-packages resolution: anything not resolving inside the repo is external and dropped (as bare TS specifiers are today).
- No `strata.config.json` / user-defined layer config (still parked); the Django preset is auto-detected only.
- No FastAPI preset, no Go/Rust.
- No change to the response schema (`ImportMapResponse`); edges from Python are always kind `"import"`.

## Design decisions (binding for workers)

D1. Extraction (`extractPythonImports(source): PythonImport[]`, core, pure):
  - Recognised statements, at logical line start (leading whitespace allowed, so imports inside functions / `if TYPE_CHECKING:` count):
    - `import a.b.c`, `import a.b as x, d.e` -> one entry per module: `{ module: "a.b.c", names: [], line }`.
    - `from a.b import c, d as e` / `from a.b import (c,\n d,\n)` (parenthesised multi-line, trailing comma, comments inside parens) / `from a import *` (names `[]`) -> `{ module: "a.b", names: ["c","d"], line }`.
    - Relative: `from . import x`, `from .mod import y`, `from ..pkg.mod import z` -> `module` keeps the leading dots (`"."`, `".mod"`, `"..pkg.mod"`).
    - Backslash continuation `from a import b, \` + next line: supported for the `from` form.
  - Ignored: lines whose first non-space char is `#`; `from __future__ import ...`; anything inside triple-quoted strings (strip `"""..."""` and `'''...'''` blocks before matching, preserving newlines so line numbers stay correct); `importlib`/`__import__`.
  - `line` = 1-based line of the `import`/`from` keyword. Output ordered by position.
D2. Resolution (`createPythonResolver({ host, roots })`, core, pure, `host.exists` as in S-04):
  - `roots`: repo-relative source roots, tried in the given order; `""` = repo root. CLI passes them (D4).
  - Module `a.b.c` against root R: `R/a/b/c.py`, then `R/a/b/c/__init__.py`. First hit over roots wins.
  - `resolve(imp, fromFile): string[]` returns 0..n repo-relative paths:
    - `import a.b.c` -> the module file only (not parent `__init__`s).
    - `from M import n1, n2`: for each name, try submodule `M.n` first; names that are not submodules fall back to `M` itself (added once). So `from app import models, utils_fn` -> `app/models.py` + `app/__init__.py`.
    - Relative: level k (number of dots) -> base dir = dirname(fromFile) up (k-1) levels; `from . import x` = module `x` in base dir; `from .m import x` = `base/m` then the same submodule/name rule. A relative import that escapes the repo root -> nothing. Relative imports ignore `roots`.
  - Results deduped, self-import (`fromFile`) dropped, `insideRoot` check as in S-04.
D3. Language dispatch (core): `mapLanguageOf(path): "ts" | "py" | null` (`.py` -> py; the existing TS/JS regex -> ts; `.d.ts` / `.pyi` -> null). CLI uses it instead of its own `SOURCE_RE`.
D4. Python source roots (CLI, from the `git ls-files` list already loaded):
  - always `""`;
  - `src` if any candidate path starts with `src/` and ends in `.py`;
  - every directory containing a `manage.py` (Django project root), e.g. `backend` for `backend/manage.py`;
  - order: dirs of `manage.py` sorted, then `src`, then `""`. Cap 20 roots.
  - If `git ls-files` failed (outgoing-only fallback), roots = `[""]` plus `src` if `src/` exists.
D5. Django layer preset (core `layerOf(path, opts?)`): new optional `opts.layerRoots: string[]`; if `path` starts with `<root>/` for some root (longest root wins) and has at least one more directory segment, the layer is `<root>/<next segment>` (e.g. `backend/orders/models.py` -> `backend/orders`); files directly in the root (`backend/manage.py`) -> layer `<root>`. Without `opts` the behaviour is unchanged (existing tests must stay green). `layoutImportMap(nodes, edges, opts?)` passes it through. CLI passes the non-empty `manage.py` dirs as `layerRoots` (a `manage.py` at repo root needs nothing: first segment already = app).
D6. Hints (core `hints.ts`, path-based only):
  - `isTestPath`: add `conftest.py`, `*_test.py`, `tests.py`.
  - `MANIFEST_RE`: add `poetry.lock`, `uv.lock`, `pipfile`, `pipfile.lock`, `setup.py`, `setup.cfg`.
  - `CONFIG_NAME_RE`: add `tox.ini`, `pytest.ini`, `mypy.ini`, `.flake8`, `ruff.toml`, `.ruff.toml`, `.pre-commit-config.yaml`, `noxfile.py`.
  - `isConfigPath`: `settings.py`, `settings/*.py`, `wsgi.py`, `asgi.py` count as config.
  - `publicSurfaceKind`: `urls.py` -> "routes or API"; `views.py`, `views/*.py`, `serializers.py`, `api.py` -> "routes or API"; `__init__.py` is NOT an entry point (too noisy).
  - Order/precedence: existing rules first; `setup.py` must be a manifest, not config.
D7. Caps/ETag: unchanged mechanism; `.py` files count towards the same 5000-file / 512 KB caps; extra `SKIP_DIRS` for Python: `__pycache__`, `.venv`, `venv`, `.tox`, `site-packages`, `.mypy_cache`, `.pytest_cache`.
D8. Web: empty state text -> "No supported source files changed (TS/JS, Python)". Update the existing test string.

## Implementation Approach

### Phase 1: Core (Python extractor + resolver, language dispatch, layer roots, hints)

**Files**: `packages/core/src/map-extract-py.ts` (new), `packages/core/src/map-extract-py.test.ts` (new), `packages/core/src/map-extract.ts` (only `mapLanguageOf`), `packages/core/src/map-layout.ts` (+ test), `packages/core/src/hints.ts` (+ `hints.test.ts`), `packages/core/src/index.ts` (exports).

- D1, D2, D3, D5, D6. Core stays node-free (no `node:` imports).
- Tests (minimum): every D1 form incl. multi-line parens, backslash continuation, `as` aliases, comment lines, docstring containing `import x`, `__future__`; line numbers; D2: absolute module file vs package `__init__`, submodule-vs-name fallback, relative levels 1-3, escaping root, roots order (`src` layout, Django `backend/` root), missing -> `[]`; D5: `layerRoots` grouping + no-opts regression + determinism; D6: each new path.

#### Success Criteria
- `pnpm check` green; `grep -rn "from \"node:" packages/core/src --include=*.ts | grep -v "/node/"` empty.

### Phase 2: CLI + web (wire `.py` into the map, roots/layers, empty state)

**Files**: `packages/cli/src/map.ts`, `packages/cli/src/api.map.test.ts`, `packages/web/src/MapView.tsx`, `packages/web/src/MapView.test.tsx`.

- Replace `SOURCE_RE` filter with `mapLanguageOf` (keep exported `isMapSource` name); D7 skip dirs.
- Compute Python roots (D4) and `layerRoots` (D5) once per build; `importsOf(rel)` dispatches by language: TS -> existing path; Python -> `extractPythonImports` + `createPythonResolver` (kind `"import"`).
- Test fixture (temp git repo in the existing test style): Django layout `backend/manage.py`, `backend/shop/{__init__,models,views,urls}.py`, `backend/core/utils.py`, plus one TS file; session changes `backend/shop/views.py`. Assert: nodes include `views.py` (changed), `models.py` + `core/utils.py` (outgoing neighbours via `from .models import X` and `from core.utils import y`), `urls.py` (incoming via `from . import views`); layers `backend/shop` and `backend/core`; TS map still works in the same response; edge kinds `"import"`.
- D8 web text.

#### Success Criteria
- `pnpm check` green; new API test passes; existing map tests unchanged and green.

### Phase 3: Docs + roadmap/PRD

**Files**: `README.md` (packages/cli) map section, `context/foundation/roadmap.md` (S-09 Parked -> Done), `context/foundation/prd.md` (FR-013 below).
- Done by the orchestrator, no worker.

## Progress

### Phase 1: Core
- [x] 1.1 Python extractor + resolver (`map-extract-py.ts`) with tests
- [x] 1.2 `mapLanguageOf`, `layerOf`/`layoutImportMap` `layerRoots` option with tests
- [x] 1.3 Python/Django hint paths with tests

### Phase 2: CLI + web
- [x] 2.1 Language dispatch, Python roots, layer roots, skip dirs in `map.ts`
- [x] 2.2 Django fixture API test
- [x] 2.3 Web empty-state text

### Phase 3: Docs
- [ ] 3.1 README, roadmap, PRD

## Proposed PRD addition

### FR-013: Python files in the import map (v0.2)

- **Description**: The import map includes changed Python files and their 1-hop in-repo import neighbours; Django projects are grouped by app.
- **Priority**: should-have
- **Acceptance Criteria**:
  - `import x.y`, `from x import y`, relative `from .m import n` resolve to repo files (`.py` or `__init__.py`) under the repo root, `src/` and Django project roots.
  - Django apps form separate map layers.
  - Python/Django manifests, configs, tests and URL/view modules feed the existing review hints.

## Orchestrator review amendments (Opus, 2026-10-23, from Agy plan-review F1-F9) — override the sections above

- A1 (F1) `from M import *` (names `[]`) resolves to module `M` itself (`M.py` or `M/__init__.py`).
- A2 (F2) Relative resolution, unified: k = leading dots, rest = text after the dots; baseDir = dirname(fromFile) ascended k-1 times (escaping root -> `[]`); target = rest ? `baseDir/rest(dots->/)` : baseDir. For each name x: `target/x.py` or `target/x/__init__.py`; names that miss fall back (once) to `target.py` or `target/__init__.py`. Same rule as absolute imports, just a different base. `from .. import x` works the same way.
- A3 (F3, F7, F8) Pre-processing before matching, all preserving line count: (1) triple-quoted blocks -> as many `\n` as they contained; (2) `#` to end of line removed (outside string literals is not required — regex tolerance as S-04); (3) backslash continuations `\\[ \t]*\r?\n` -> a space, for both forms (line of the statement = line where it starts; keep a line map or compute the line before joining).
- A4 (F4) `;` is a statement separator: `import os; import sys` yields both; a module/name token ends at `;`, `,`, `)`, whitespace or end of line.
- A5 (F5) D4 roots: manageDirs = NON-EMPTY dirs containing `manage.py`, sorted; roots = dedupe([...manageDirs, ...(hasSrc ? ["src"] : []), ""]).
- A6 (F6) `isTestPath`: `/^(?:test_.*|.*_test|tests?|conftest)\.py$/i`.
- A7 (F9) `publicSurfaceKind`: also any `.py` under a `urls/` directory -> "routes or API".
- Phases stay split (two briefs, separate commits, `pnpm check` green after each).
