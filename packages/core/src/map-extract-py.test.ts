import { describe, expect, test } from "vitest";
import {
  extractPythonImports,
  createPythonResolver,
  type PythonImport,
} from "./map-extract-py.js";
import type { MapHost } from "./map-extract.js";

function makeHost(files: readonly string[]): MapHost {
  const set = new Set(files);
  return {
    exists: (path) => set.has(path),
  };
}

describe("extractPythonImports", () => {
  test("extracts standard import forms and records exact line numbers (D1)", () => {
    const src = [
      "import os",
      "import sys, math",
      "import os.path as osp, json as j",
      "from typing import List, Dict, Optional as Opt",
      "from . import views",
      "from .models import Order, Customer",
      "from ..core.utils import helper",
    ].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "os", names: [], line: 1 },
      { module: "sys", names: [], line: 2 },
      { module: "math", names: [], line: 2 },
      { module: "os.path", names: [], line: 3 },
      { module: "json", names: [], line: 3 },
      { module: "typing", names: ["List", "Dict", "Optional"], line: 4 },
      { module: ".", names: ["views"], line: 5 },
      { module: ".models", names: ["Order", "Customer"], line: 6 },
      { module: "..core.utils", names: ["helper"], line: 7 },
    ]);
  });

  test("handles parenthesized multi-line imports with trailing commas and comments (D1, A3)", () => {
    const src = [
      "from django.db.models import (",
      "    # primary fields",
      "    CharField,",
      "    IntegerField,",
      "    ForeignKey as FK,",
      ")",
    ].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "django.db.models", names: ["CharField", "IntegerField", "ForeignKey"], line: 1 },
    ]);
  });

  test("handles backslash continuation for from and import forms (D1, A3)", () => {
    const src = [
      "# line 1 comment",
      "from myapp.services import \\",
      "    do_work, \\",
      "    cleanup",
      "import \\",
      "    alpha, \\",
      "    beta",
    ].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "myapp.services", names: ["do_work", "cleanup"], line: 2 },
      { module: "alpha", names: [], line: 5 },
      { module: "beta", names: [], line: 5 },
    ]);
  });

  test("handles wildcard import per A1", () => {
    const src = "from .models import *";
    expect(extractPythonImports(src)).toEqual([
      { module: ".models", names: [], line: 1 },
    ]);
  });

  test("semicolon statement separator yields each import (A4)", () => {
    const src = "import os; import sys; from a import b; from c import d as e";
    expect(extractPythonImports(src)).toEqual([
      { module: "os", names: [], line: 1 },
      { module: "sys", names: [], line: 1 },
      { module: "a", names: ["b"], line: 1 },
      { module: "c", names: ["d"], line: 1 },
    ]);
  });

  test("ignores from __future__ import statements (D1)", () => {
    const src = [
      "from __future__ import annotations, unicode_literals",
      "import os",
    ].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
  });

  test("ignores imports inside docstrings and comments (D1, A3)", () => {
    const src = [
      '"""',
      'import fake_in_docstring',
      'from fake import bogus',
      '"""',
      "# import fake_in_comment",
      "'''",
      "import another_fake",
      "'''",
      "import real_mod",
    ].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "real_mod", names: [], line: 9 },
    ]);
  });

  test("ignores a triple quote inside a comment (S-20)", () => {
    const src = ['# use """ for docstrings', "import os"].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
  });

  test("ignores a hash inside a string (S-20)", () => {
    const src = 's = "#"; import json';

    expect(extractPythonImports(src)).toEqual([
      { module: "json", names: [], line: 1 },
    ]);
  });

  test("ignores triple quotes inside a single-line string (S-20)", () => {
    const src = [`x = '"""'`, "import sys"].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "sys", names: [], line: 2 },
    ]);
  });

  test("ignores imports inside a prefixed triple-quoted string (S-20)", () => {
    const src = ['r"""raw', "import fake", '"""', "import real"].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "real", names: [], line: 4 },
    ]);
  });

  test("keeps imports after an f-string containing a hash (S-20)", () => {
    const src = 'f"{a!r}#not a comment"; import re';

    expect(extractPythonImports(src)).toEqual([
      { module: "re", names: [], line: 1 },
    ]);
  });

  test("ends an unterminated single-line string at the end of its line (S-20)", () => {
    const src = ['s = "abc', "import os"].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
  });

  test("consumes CRLF line continuation inside a string (S-20 review fix)", () => {
    const src = 's = "query = \\\r\nimport fake\r\n"';
    expect(extractPythonImports(src)).toEqual([]);
  });

  test("extracts normal imports from a CRLF file (S-20 review fix)", () => {
    const src = ["import os", "from sys import path"].join("\r\n");
    expect(extractPythonImports(src)).toEqual([
      { module: "os", names: [], line: 1 },
      { module: "sys", names: ["path"], line: 2 },
    ]);
  });

  test("extracts imports inside indented scopes (functions, TYPE_CHECKING)", () => {
    const src = [
      "if TYPE_CHECKING:",
      "    import mypy_types",
      "def run():",
      "    from runtime import worker",
    ].join("\n");

    expect(extractPythonImports(src)).toEqual([
      { module: "mypy_types", names: [], line: 2 },
      { module: "runtime", names: ["worker"], line: 4 },
    ]);
  });

  test("returns empty array for empty, whitespace or non-import source", () => {
    expect(extractPythonImports("")).toEqual([]);
    expect(extractPythonImports("   \n\n  ")).toEqual([]);
    expect(extractPythonImports("x = 10\nprint('hello')")).toEqual([]);
  });

  test("ignores import text inside a nested same-quote f-string spanning lines (PEP 701, L2)", () => {
    const src = ["x = f\"\"\"{f\"\"\"", "import fake", "\"\"\"}\"\"\"", "import os"].join("\n");

    expect(extractPythonImports(src)).toEqual([{ module: "os", names: [], line: 4 }]);
  });

  test("ignores import text in a nested f-string on its own field lines (PEP 701, L2)", () => {
    const src = ["x = f\"\"\"", "{f\"\"\"import fake\"\"\"}", "\"\"\"", "import os"].join("\n");

    expect(extractPythonImports(src)).toEqual([{ module: "os", names: [], line: 4 }]);
  });

  test("keeps imports after PEP 701 nested and escaped-brace f-strings (L2)", () => {
    // Each line is a statement on its own; compare with python3: only the `import` after the
    // f-string is real, the text inside the f-string never is.
    expect(extractPythonImports("f\"{x + f'{y}'}\"; import re")).toEqual([
      { module: "re", names: [], line: 1 },
    ]);
    expect(extractPythonImports(["f\"{'a' if b else \"c\"}\"", "import sys"].join("\n"))).toEqual([
      { module: "sys", names: [], line: 2 },
    ]);
    expect(extractPythonImports(["f\"{f\"{y}\"}\"", "import os"].join("\n"))).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
    expect(extractPythonImports("f\"{{}}\"; import os")).toEqual([
      { module: "os", names: [], line: 1 },
    ]);
    expect(extractPythonImports("f\"{v:{w}}\"; import os")).toEqual([
      { module: "os", names: [], line: 1 },
    ]);
    expect(extractPythonImports("x = f\"{v:{'import fake'}}\"\nimport os")).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
    expect(extractPythonImports(["x = f\"\"\"{f\"\"\"a\"\"\"}{f\"\"\"b\"\"\"}\"\"\"", "import os"].join("\n"))).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
  });

  test("comment shapes stay comments even with string markers (L1)", () => {
    expect(extractPythonImports(["s = 'x'  # '''", "import os"].join("\n"))).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
    expect(extractPythonImports(["'''doc'''  # \"\"\" docstring-like", "import os"].join("\n"))).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
    expect(extractPythonImports(["from django.db.models import (", "    CharField,  # \"\"\"", ")", "import os"].join("\n"))).toEqual([
      { module: "django.db.models", names: ["CharField"], line: 1 },
      { module: "os", names: [], line: 4 },
    ]);
  });

  test("treats any f/F anywhere in the string prefix run as an f-string (review)", () => {
    // Both snippets parse in python3 3.14 with only the trailing import: the Rf f-string hides
    // `import fake` behind a nested spanning-lines triple f-string, the rf f-string must not
    // swallow `import m1` behind it.
    expect(extractPythonImports(['x = Rf"{f"""', "import fake", '"""}"', "import m3"].join("\n"))).toEqual([
      { module: "m3", names: [], line: 4 },
    ]);
    expect(extractPythonImports(['x = rf"import fake}}{f"""', "", '"""=:}"', "import m1"].join("\n"))).toEqual([
      { module: "m1", names: [], line: 4 },
    ]);
  });

  test("an escaped backslash cannot swallow the closing quote of an f-string (review)", () => {
    // Both snippets parse in python3 3.14 (os@2 / os@1): `\\` is one escape consuming the second
    // backslash, so the next quote still closes the string (regression vs main).
    expect(extractPythonImports(['x = f"""a\\\\"""', "import os"].join("\n"))).toEqual([
      { module: "os", names: [], line: 2 },
    ]);
    expect(extractPythonImports('x = f"abc\\\\" ; import os')).toEqual([
      { module: "os", names: [], line: 1 },
    ]);
  });

  test("an aborted triple-quoted f-string keeps blanking inside it (review)", () => {
    // Syntax errors in CPython; the scanner keeps main's behaviour: an unterminated field or
    // nested string never re-enters code state inside the still-open triple f-string, so string
    // text (`fake@2`) is never reported and the rest of the string stays blanked.
    expect(extractPythonImports(['x = f"""{\'abc', "import fake", '"""', "import os"].join("\n"))).toEqual([
      { module: "os", names: [], line: 4 },
    ]);
    expect(extractPythonImports(["s = f\"\"\"{x", "import fake", '"""', "import os"].join("\n"))).toEqual([
      { module: "os", names: [], line: 4 },
    ]);
  });

  test("deeply nested f-strings hit the nesting cap instead of overflowing the stack (review)", () => {
    // CPython rejects 150 or more nested f-strings; the only guarantee is that the
    // scan returns instead of throwing RangeError (a hostile file could abort a map build).
    let src = "x";
    for (let k = 0; k < 5000; k++) src = `f"{${src}}"`;
    expect(() => extractPythonImports(`y = ${src}\nimport os\n`)).not.toThrow();
  });
});

describe("createPythonResolver", () => {
  test("resolves absolute module file vs package __init__ (D2)", () => {
    const host = makeHost([
      "app/models.py",
      "app/services/__init__.py",
      "app/services/worker.py",
    ]);
    const resolver = createPythonResolver({ host });

    expect(resolver.resolve({ module: "app.models", names: [], line: 1 }, "main.py")).toEqual([
      "app/models.py",
    ]);
    expect(resolver.resolve({ module: "app.services", names: [], line: 1 }, "main.py")).toEqual([
      "app/services/__init__.py",
    ]);
  });

  test("submodule-vs-name fallback: submodule wins, miss falls back to package __init__ once (D2)", () => {
    const host = makeHost([
      "app/__init__.py",
      "app/models.py",
      "app/views.py",
    ]);
    const resolver = createPythonResolver({ host });

    // Both are submodules -> returns both submodules, does not add __init__.py
    expect(resolver.resolve({ module: "app", names: ["models", "views"], line: 1 }, "main.py")).toEqual([
      "app/models.py",
      "app/views.py",
    ]);

    // One submodule ("models") and one non-submodule ("helper_fn") -> adds submodule and falls back to app/__init__.py
    expect(resolver.resolve({ module: "app", names: ["models", "helper_fn"], line: 1 }, "main.py")).toEqual([
      "app/models.py",
      "app/__init__.py",
    ]);

    // from app.models import User -> User misses, falls back to target app/models.py
    expect(resolver.resolve({ module: "app.models", names: ["User"], line: 1 }, "main.py")).toEqual([
      "app/models.py",
    ]);
  });

  test("wildcard import resolves to module or package __init__ per A1", () => {
    const host = makeHost(["app/__init__.py", "app/models.py"]);
    const resolver = createPythonResolver({ host });

    expect(resolver.resolve({ module: "app", names: [], line: 1 }, "main.py")).toEqual([
      "app/__init__.py",
    ]);
    expect(resolver.resolve({ module: "app.models", names: [], line: 1 }, "main.py")).toEqual([
      "app/models.py",
    ]);
  });

  test("relative imports with levels 1 to 3 (A2)", () => {
    const host = makeHost([
      "backend/shop/__init__.py",
      "backend/shop/models.py",
      "backend/shop/views.py",
      "backend/shop/sub/deep.py",
      "backend/core/utils.py",
      "backend/manage.py",
    ]);
    const resolver = createPythonResolver({ host });

    // Level 1: from . import models (in backend/shop/views.py)
    expect(resolver.resolve({ module: ".", names: ["models"], line: 1 }, "backend/shop/views.py")).toEqual([
      "backend/shop/models.py",
    ]);

    // Level 1 with rest: from .models import Order
    expect(resolver.resolve({ module: ".models", names: ["Order"], line: 1 }, "backend/shop/views.py")).toEqual([
      "backend/shop/models.py",
    ]);

    // Level 2 with rest: from ..core.utils import helper (in backend/shop/views.py)
    expect(resolver.resolve({ module: "..core.utils", names: ["helper"], line: 1 }, "backend/shop/views.py")).toEqual([
      "backend/core/utils.py",
    ]);

    // Level 2 without rest: from .. import manage (in backend/shop/views.py)
    expect(resolver.resolve({ module: "..", names: ["manage"], line: 1 }, "backend/shop/views.py")).toEqual([
      "backend/manage.py",
    ]);

    // Level 3 with rest: from ...core.utils import helper (in backend/shop/sub/deep.py)
    expect(resolver.resolve({ module: "...core.utils", names: ["helper"], line: 1 }, "backend/shop/sub/deep.py")).toEqual([
      "backend/core/utils.py",
    ]);
  });

  test("relative import that escapes repo root yields empty array (D2, A2)", () => {
    const host = makeHost(["root.py"]);
    const resolver = createPythonResolver({ host });

    // from .. import something from a file in repo root
    expect(resolver.resolve({ module: "..", names: ["foo"], line: 1 }, "root.py")).toEqual([]);

    // from ... import something from a 1-level deep file
    expect(resolver.resolve({ module: "...", names: ["foo"], line: 1 }, "pkg/a.py")).toEqual([]);
  });

  test("roots order: Django backend/ root and src/ layout (D2, D4)", () => {
    const host = makeHost([
      "backend/orders/models.py",
      "backend/orders/__init__.py",
      "src/shared/utils.py",
      "shared/utils.py",
    ]);

    // With roots = ["backend", "src", ""]
    const resolver = createPythonResolver({ host, roots: ["backend", "src", ""] });

    // from orders import models -> finds under "backend"
    expect(resolver.resolve({ module: "orders", names: ["models"], line: 1 }, "main.py")).toEqual([
      "backend/orders/models.py",
    ]);

    // from shared.utils import fn -> "src" comes before "", so "src/shared/utils.py" wins
    expect(resolver.resolve({ module: "shared.utils", names: ["fn"], line: 1 }, "main.py")).toEqual([
      "src/shared/utils.py",
    ]);
  });

  test("drops self-imports and dedupes (D2)", () => {
    const host = makeHost(["app/models.py"]);
    const resolver = createPythonResolver({ host });

    // inside app/models.py, importing app.models -> self-import dropped
    expect(resolver.resolve({ module: "app.models", names: [], line: 1 }, "app/models.py")).toEqual([]);

    // multiple names resolving to same module are deduped
    expect(resolver.resolve({ module: "app.models", names: ["A", "B", "C"], line: 1 }, "main.py")).toEqual([
      "app/models.py",
    ]);
  });

  test("unresolvable imports return empty array", () => {
    const host = makeHost(["app/models.py"]);
    const resolver = createPythonResolver({ host });

    expect(resolver.resolve({ module: "external_pkg", names: ["something"], line: 1 }, "main.py")).toEqual([]);
    expect(resolver.resolve({ module: "external_pkg.sub", names: [], line: 1 }, "main.py")).toEqual([]);
  });
});
