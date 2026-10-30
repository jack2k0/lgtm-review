import { describe, expect, test } from "vitest";
import { resolveScope, SCOPE_LABEL_MAX, scopeCovers, scopeGaps, type ScopeCheck } from "./scope.js";

const R = "/r";

describe("resolveScope", () => {
  test("the whole project is not scoped", () => {
    expect(resolveScope(["."], R, R)).toBeNull();
  });

  test("a subfolder of the session root", () => {
    expect(resolveScope(["."], "/r/packages/web", R)).toEqual({ roots: ["/r/packages/web"], label: "packages/web" });
  });

  test("the whole test suite is not scoped", () => {
    expect(resolveScope(["tests"], R, R)).toBeNull();
    expect(resolveScope(["tests/unit/../e2e"], R, R)).toBeNull();
  });

  test("a test subfolder with a name is scoped", () => {
    expect(resolveScope(["tests/api"], R, R)).toEqual({ roots: ["/r/tests/api"], label: "tests/api" });
  });

  test("a root outside the session shows its last two segments", () => {
    expect(resolveScope(["/x/other/pkg"], R, R)).toEqual({ roots: ["/x/other/pkg"], label: "…/other/pkg" });
  });

  test("an ancestor of the session root is not scoped", () => {
    expect(resolveScope([".."], R, R)).toBeNull();
    expect(resolveScope(["/"], R, R)).toBeNull();
  });

  test("three roots: two names then a count", () => {
    expect(resolveScope(["a", "b", "c"], R, R)?.label).toBe("a, b +1");
  });

  test("duplicate roots are merged", () => {
    expect(resolveScope(["a", "a/."], R, R)).toEqual({ roots: ["/r/a"], label: "a" });
  });

  test("a long label is cut to the maximum and ends in an ellipsis", () => {
    const scope = resolveScope(["x".repeat(100)], R, R);
    expect(scope?.label.length).toBe(SCOPE_LABEL_MAX);
    expect(scope?.label.endsWith("…")).toBe(true);
  });

  test("unknown base or session root, or no roots, give null", () => {
    expect(resolveScope(["a"], null, R)).toBeNull();
    expect(resolveScope(["a"], "packages/web", R)).toBeNull();
    expect(resolveScope(["a"], R, null)).toBeNull();
    expect(resolveScope(["a"], R, "relative")).toBeNull();
    expect(resolveScope(null, R, R)).toBeNull();
    expect(resolveScope([], R, R)).toBeNull();
  });
});

describe("scopeCovers", () => {
  test("a folder covers everything under it", () => {
    expect(scopeCovers("/r/packages/web", "/r/packages/web/src/a.ts")).toBe(true);
    expect(scopeCovers("/r/packages/web", "/r/packages/core/src/b.ts")).toBe(false);
  });

  test("a test folder covers the source folder with the same last name", () => {
    expect(scopeCovers("/r/tests/api", "/r/src/api/route.ts")).toBe(true);
  });

  test("a test file covers the source file with the same stem", () => {
    expect(scopeCovers("/r/tests/test_cart.py", "/r/src/cart.py")).toBe(true);
    expect(scopeCovers("/r/tests/test_cart.py", "/r/src/orders.py")).toBe(false);
    expect(scopeCovers("/r/src/cart.test.ts", "/r/src/cart.ts")).toBe(true);
  });

  test("a folder does not cover a sibling with another name", () => {
    expect(scopeCovers("/r/internal/foo", "/r/internal/bar/b.go")).toBe(false);
  });

  test("a root with no usable name covers only its own prefix", () => {
    expect(scopeCovers("/tests", "/src/a.ts")).toBe(false);
    expect(scopeCovers("/r/tests", "/r/src/a.ts")).toBe(true);
  });

  test("a non-test file only covers itself, not same-named files elsewhere", () => {
    expect(scopeCovers("/r/packages/web/src/index.ts", "/r/packages/web/src/index.ts")).toBe(true);
    expect(scopeCovers("/r/packages/web/src/index.ts", "/r/packages/web/src/index.tsx")).toBe(false);
    expect(scopeCovers("/r/packages/web/src/index.ts", "/r/packages/core/src/index.ts")).toBe(false);
    expect(scopeCovers("/r/scripts/deploy.sh", "/r/src/deploy.ts")).toBe(false);
    expect(scopeCovers("/repo/packages/core/src/node/lines.ts", "/repo/packages/core/src/text/lines/formatter.ts")).toBe(false);
  });

  test("the stem rule does not cross package boundaries", () => {
    expect(scopeCovers("/r/packages/web/src/cart.test.ts", "/r/packages/web/src/cart.ts")).toBe(true);
    expect(scopeCovers("/r/packages/web/src/cart.test.ts", "/r/packages/core/src/cart.ts")).toBe(false);
  });

  test("a test package keeps its own name instead of its container", () => {
    expect(scopeCovers("/r/packages/e2e", "/r/packages/core/src/b.ts")).toBe(false);
    expect(scopeCovers("/r/apps/e2e", "/r/apps/web/src/a.ts")).toBe(false);
  });

  test("directory-key coverage stays in the same package", () => {
    expect(scopeCovers("/r/tests/api", "/r/src/api/route.ts")).toBe(true);
    expect(scopeCovers("/r/tests/api", "/r/packages/billing/api/handler.ts")).toBe(false);
    expect(scopeCovers("/r/packages/web/tests/api", "/r/packages/web/src/api/route.ts")).toBe(true);
    expect(scopeCovers("/r/packages/web/tests/api", "/r/packages/core/src/api/route.ts")).toBe(false);
  });
});

describe("scopeGaps", () => {
  const pass = (coveredSeq: number, scope: ScopeCheck["scope"] = null): ScopeCheck => ({ coveredSeq, passed: true, scope });

  test("an edit before an unscoped passing check is covered even if a later scoped check misses it", () => {
    const files = [{ path: "/r/src/a.ts", lastSeq: 1 }];
    const checks = [pass(2), { coveredSeq: 3, passed: true, scope: { roots: ["/r/packages/web"], label: "packages/web" } }];
    expect(scopeGaps(files, checks)).toEqual([]);
  });

  test("a failing check never covers", () => {
    const files = [{ path: "/r/src/a.ts", lastSeq: 1 }];
    expect(scopeGaps(files, [{ coveredSeq: 2, passed: false, scope: null }])).toEqual(["/r/src/a.ts"]);
  });

  test("a passing check that finished before the last edit does not cover it", () => {
    const files = [{ path: "/r/src/a.ts", lastSeq: 3 }];
    expect(scopeGaps(files, [pass(2)])).toEqual(["/r/src/a.ts"]);
  });

  test("a scoped check covers only its scope", () => {
    const files = [
      { path: "/r/packages/web/a.ts", lastSeq: 1 },
      { path: "/r/packages/core/b.ts", lastSeq: 1 },
    ];
    const checks = [pass(2, { roots: ["/r/packages/web"], label: "packages/web" })];
    expect(scopeGaps(files, checks)).toEqual(["/r/packages/core/b.ts"]);
  });

  test("a relative path is never a gap", () => {
    expect(scopeGaps([{ path: "(shell edit)", lastSeq: 1 }], [])).toEqual([]);
  });

  test("output keeps input order", () => {
    const files = [
      { path: "/r/z.ts", lastSeq: 1 },
      { path: "/r/a.ts", lastSeq: 1 },
    ];
    expect(scopeGaps(files, [])).toEqual(["/r/z.ts", "/r/a.ts"]);
  });
});
