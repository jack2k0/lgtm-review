import { describe, expect, test } from "vitest";
import { analyzeSession, createAnalyzer } from "./analyze.js";
import {
  computeHints,
  emptyStats,
  isConfigPath,
  isDocPath,
  isManifestPath,
  isScratchPath,
  isTestPath,
  publicSurfaceKind,
  recommend,
  relativePath,
  scanContent,
  scanDiffLines,
  sensitiveMatch,
  type EditEvidence,
  type EditStats,
} from "./hints.js";
import type { Hint, HintRule, Status } from "./schema.js";
import { bash, edit, patchResult, prompt, resetIds, toolResult, toolUse } from "./testing/records.js";

describe("isTestPath", () => {
  test.each<[string, boolean]>([
    ["src/add.test.ts", true],
    ["src/add.spec.js", true],
    ["tests/add.ts", true],
    ["test/add.ts", true],
    ["src/__tests__/add.ts", true],
    ["spec/add.rb", true],
    ["pkg/test_add.py", true],
    ["pkg/add_test.go", true],
    ["Tests/Add.ts", true],
    ["conftest.py", true],
    ["tests.py", true],
    ["test.py", true],
    ["src/latest_test.py", true],
    ["tests/__snapshots__/foo.test.ts.snap", false],
    ["src/__tests__/__snapshots__/add.ts.snap", false],
    ["__snapshots__/add.snap", false],
    ["tests/add.snap", false],
    ["__snapshots__/add.ts", false],
    ["src/add.ts", false],
    ["src/testing/records.ts", false],
    ["src/contest.ts", false],
    ["src/test.ts", false],
    ["src/testing_helper.py", false],
    ["src/specification.ts", false],
  ])("%s => %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});

describe("sensitiveMatch", () => {
  test.each<[string, string | null]>([
    ["src/auth/session.ts", "auth"],
    ["src/login.tsx", "login"],
    ["src/AuthService.ts", "auth"],
    ["src/auth-middleware.ts", "auth"],
    ["config/secrets.yaml", "secrets"],
    ["src/credentials.ts", "credentials"],
    ["src/tokens/refresh.ts", "tokens"],
    ["db/migrations/001_init.sql", "migrations"],
    ["db/migration/001_init.sql", "migration"],
    ["src/user_migration.py", "migration"],
    ["src/user-migration.ts", "migration"],
    ["001-create-users-migration.sql", "migration"],
    ["db/migrate.ts", "migrate"],
    ["src/permissions.ts", "permissions"],
    ["src/security/policy.ts", "security"],
    [".env", ".env"],
    [".env.production", ".env"],
    [".env.example", null],
    [".env.sample", null],
    [".env.template", null],
    [".env.dist", null],
    ["config/.env.example", null],
    ["src/immigration.ts", null],
    ["src/emigration.ts", null],
    ["apps/web/Dockerfile", "Dockerfile"],
    ["Dockerfile.dev", "Dockerfile"],
    [".github/workflows/ci.yml", ".github/workflows"],
    ["src/password_reset.ts", "password"],
    ["src/design-tokens.ts", null],
    ["src/tokenizer.ts", null],
    ["src/authors.ts", null],
    ["src/author.ts", null],
    ["styles/tokens.css", null],
    ["styles/auth.scss", null],
    ["src/oauthish.ts", null],
    ["src/secretary.ts", null],
    ["src/add.ts", null],
    ["docs/readme.md", null],
  ])("%s => %s", (path, expected) => {
    expect(sensitiveMatch(path)).toBe(expected);
  });

  test("authorization is not swallowed by the author exclusion", () => {
    expect(sensitiveMatch("src/authorization.ts")).toBe("authorization");
  });
});

describe("manifest, public surface and config classifiers", () => {
  test.each<[string, boolean]>([
    ["package.json", true],
    ["packages/a/package.json", true],
    ["pnpm-lock.yaml", true],
    ["package-lock.json", true],
    ["yarn.lock", true],
    ["bun.lockb", true],
    ["bun.lock", true],
    ["Gemfile.lock", true],
    ["composer.lock", true],
    ["Cargo.lock", true],
    ["go.sum", true],
    ["requirements.txt", true],
    ["requirements-dev.txt", true],
    ["pyproject.toml", true],
    ["poetry.lock", true],
    ["uv.lock", true],
    ["Pipfile", true],
    ["Pipfile.lock", true],
    ["setup.py", true],
    ["setup.cfg", true],
    ["go.mod", true],
    ["Cargo.toml", true],
    ["pom.xml", true],
    ["build.gradle.kts", true],
    ["src/package.json.ts", false],
    ["bun.lock.ts", false],
    ["composer.lock.bak", false],
    ["other.lock", false],
    ["docs/requirements.md", false],
  ])("manifest %s => %s", (path, expected) => {
    expect(isManifestPath(path)).toBe(expected);
  });

  test.each<[string, string | null]>([
    ["index.ts", "package entry point"],
    ["src/index.js", "package entry point"],
    ["packages/core/src/index.ts", "package entry point"],
    ["src/components/index.ts", null],
    ["src/routes/users.ts", "routes or API"],
    ["pages/api/hello.ts", "routes or API"],
    ["urls.py", "routes or API"],
    ["backend/shop/urls.py", "routes or API"],
    ["backend/shop/urls/v1.py", "routes or API"],
    ["views.py", "routes or API"],
    ["backend/shop/views.py", "routes or API"],
    ["backend/shop/views/orders.py", "routes or API"],
    ["serializers.py", "routes or API"],
    ["backend/shop/serializers.py", "routes or API"],
    ["api.py", "routes or API"],
    ["openapi.yaml", "schema or OpenAPI"],
    ["src/schema.ts", "schema or OpenAPI"],
    ["prisma/schema.prisma", "schema or OpenAPI"],
    ["src/rapid/add.ts", null],
    ["src/add.ts", null],
  ])("public surface %s => %s", (path, expected) => {
    expect(publicSurfaceKind(path)).toBe(expected);
  });

  test.each<[string, boolean]>([
    ["tsconfig.json", true],
    ["packages/a/tsconfig.build.json", true],
    ["eslint.config.js", true],
    [".eslintrc.json", true],
    ["biome.json", true],
    [".prettierrc", true],
    ["vite.config.ts", true],
    ["webpack.config.js", true],
    ["rollup.config.mjs", true],
    ["tsup.config.ts", true],
    [".github/workflows/ci.yml", true],
    [".circleci/config.yml", true],
    [".gitlab-ci.yml", true],
    ["tox.ini", true],
    ["pytest.ini", true],
    ["mypy.ini", true],
    [".flake8", true],
    ["ruff.toml", true],
    [".ruff.toml", true],
    [".pre-commit-config.yaml", true],
    [".pre-commit-config.yml", true],
    ["noxfile.py", true],
    ["settings.py", true],
    ["backend/settings.py", true],
    ["backend/settings/dev.py", true],
    ["wsgi.py", true],
    ["asgi.py", true],
    ["setup.py", false],
    ["src/config.ts", false],
    ["src/tsconfig.ts", false],
  ])("config %s => %s", (path, expected) => {
    expect(isConfigPath(path)).toBe(expected);
  });
});

describe("isDocPath", () => {
  test.each<[string, boolean]>([
    ["README.md", true],
    ["docs/guide.MD", true],
    ["/home/user/project/notes.markdown", true],
    ["a.mdown", true],
    ["b.mkd", true],
    ["c.mkdn", true],
    ["x.rst", true],
    ["y.adoc", true],
    ["z.asciidoc", true],
    ["LICENSE", true],
    ["LICENCE", true],
    ["COPYING", true],
    ["NOTICE", true],
    ["AUTHORS", true],
    ["CONTRIBUTORS", true],
    ["CHANGELOG", true],
    ["CHANGES", true],
    ["HISTORY", true],
    ["README", true],
    ["CONTRIBUTING", true],
    ["SECURITY", true],
    ["CODE_OF_CONDUCT.txt", true],
    ["INSTALL", true],
    ["scripts/changelog", false],
    ["bin/authors", false],
    ["tools/history", false],
    ["readme.txt", true],
    ["LICENSE.txt", true],
    ["C:\\repo\\README.md", true],
    [".github/pull_request_template.md", true],
    ["page.mdx", false],
    ["notes.txt", false],
    ["requirements.txt", false],
    ["README.md.ts", false],
    ["src/index.ts", false],
    ["Makefile", false],
    ["Dockerfile", false],
    [".env", false],
    ["(shell edit)", false],
    ["", false],
    ["docs/", false],
    ["docs/guide", false],
    ["CHANGELOG.json", false],
    ["history.py", false],
  ])("%s => %s", (path, expected) => {
    expect(isDocPath(path)).toBe(expected);
  });
});

describe("isScratchPath", () => {
  test.each<[string, string | null, string | null, boolean]>([
    ["/tmp/claude-1000/x/scratchpad/a.py", "/home/u/repo", "/home/u/repo", true],
    ["/tmp/notes.ts", "/home/u/repo", null, true],
    ["/var/tmp/a.js", "/home/u/repo", null, true],
    ["/private/var/folders/ab/T/x.ts", "/Users/u/repo", null, true],
    ["/home/u/scratch/a.py", "/home/u/repo", null, true],
    ["/home/u/work/scratchpad/b.go", "/home/u/repo", null, true],
    ["/home/u/repo/src/a.ts", "/home/u/repo", null, false],
    ["/home/u/repo/scratch/a.ts", "/home/u/repo", null, false],
    ["/tmp/repo/src/a.ts", "/tmp/repo", null, false],
    ["/tmp/wt/src/a.ts", "/home/u/repo", "/tmp/wt", false],
    ["/tmp/x/.claude/worktrees/w/a.ts", "/home/u/repo", null, false],
    ["/home/u/other-repo/src/a.ts", "/home/u/repo", null, false],
    ["src/a.ts", "/home/u/repo", null, false],
    ["(shell edit)", "/home/u/repo", null, false],
    ["/tmp/a.ts", null, null, true],
    ["C:\\tmp\\a.ts", null, null, false],
    ["/tmp/repo/src/index.ts", "/private/tmp/repo", "/private/tmp/repo", false],
    ["/private/tmp/repo/a.ts", "/tmp/repo", null, false],
    ["/private/tmp/x.txt", "/tmp/repo", null, true],
  ])("%s (%s, %s) => %s", (path, sessionRoot, callCwd, expected) => {
    expect(isScratchPath(path, sessionRoot, callCwd)).toBe(expected);
  });
});

describe("relativePath", () => {
  test.each<[string, string | null, string]>([
    ["/home/user/project/src/a.ts", "/home/user/project", "src/a.ts"],
    ["/home/user/project/src/a.ts", "/home/user/project/", "src/a.ts"],
    ["/home/user/other/a.ts", "/home/user/project", "/home/user/other/a.ts"],
    ["/home/user/projectx/a.ts", "/home/user/project", "/home/user/projectx/a.ts"],
    ["src\\a.ts", null, "src/a.ts"],
  ])("%s in %s", (path, cwd, expected) => {
    expect(relativePath(path, cwd)).toBe(expected);
  });

  test("a repo located under a sensitive directory name does not make every file sensitive", () => {
    const hints = computeHints({ edits: [ev("/home/user/secrets/app/src/add.ts")], lastCheckSeq: 10, cwd: "/home/user/secrets/app" });
    expect(hints).toEqual([]);
  });
});

function diff(lines: string[]): EditStats {
  const s = emptyStats();
  scanDiffLines(lines, s, { left: 2000 });
  return s;
}

describe("assertion and skip evidence", () => {
  test.each<[string, string, Partial<EditStats>]>([
    ["expect(", "+  expect(a).toBe(1);", { assertAdded: 1 }],
    ["removed expect(", "-  expect(a).toBe(1);", { assertRemoved: 1 }],
    ["assertEqual(", "+    self.assertEqual(a, 1)", { assertAdded: 1 }],
    ["assert_eq style", "+  assertEquals(a, 1);", { assertAdded: 1 }],
    ["python assert statement", "+    assert a == 1", { assertAdded: 1 }],
    ["chai should", "+  a.should.equal(1);", { assertAdded: 1 }],
    ["require.equal", "+  require.equal(a, 1);", { assertAdded: 1 }],
    ["should in a test title", '+  it("should add", () => {', {}],
    [".expect( method call", '+  let v = res.expect("boom");', {}],
    ["plain code", "+  return a + b;", {}],
    ["context line", "   expect(a).toBe(1);", {}],
    ["comment // expect", "+  // expect(a).toBe(1);", {}],
    ["comment # assert", "+  # assert a == 1", {}],
    ["comment /* it.skip", '+  /* it.skip("x") */', {}],
    ["comment * expect", "+   * expect(a).toBe(1);", {}],
    ["comment <!-- it.skip", '+  <!-- it.skip("x") -->', {}],
    ["removed comment // expect", "-  // expect(a).toBe(1);", {}],
    ["string literal with expect in double quotes", '+  const s = "expect(a).toBe(1)";', {}],
    ["string literal with assert in single quotes", "+  const s = 'assert a == 1';", {}],
    ["string literal with it.skip in backticks", "+  const s = `it.skip('x')`;", {}],
    ["string literal with escaped quotes", '+  const s = "use \\"it.skip()\\" here";', {}],
    ["code then string literal with it.skip", '+  expect(msg).toBe("it.skip()");', { assertAdded: 1 }],
    ["string literal then code with expect", '+  const s = "test"; expect(a).toBe(1);', { assertAdded: 1 }],
    ["it.skip", '+  it.skip("x", () => {', { skipAdded: 1 }],
    ["describe.skip", '-  describe.skip("x", () => {', { skipRemoved: 1 }],
    ["xit", '+  xit("x", () => {', { skipAdded: 1 }],
    ["xdescribe", '+  xdescribe("x", () => {', { skipAdded: 1 }],
    ["it.todo", '+  it.todo("x");', { skipAdded: 1 }],
    ["test.todo", '+  test.todo("x");', { skipAdded: 1 }],
    ["pytest skip", "+@pytest.mark.skip(reason='x')", { skipAdded: 1 }],
    ["pytest xfail", "+@pytest.mark.xfail", { skipAdded: 1 }],
    ["go t.Skip", "+\tt.Skip(\"later\")", { skipAdded: 1 }],
    ["junit @Disabled", "+  @Disabled", { skipAdded: 1 }],
    ["a line with both", "+  expect(x).skip();", { assertAdded: 1, skipAdded: 1 }],
  ])("%s", (_name, line, expected) => {
    expect(diff([line])).toEqual({ ...emptyStats(), ...expected });
  });

  test("scanContent counts a written file as added, up to the line cap", () => {
    const s = emptyStats();
    scanContent(["expect(1)", "xit('a')", "const a = 1", "expect(2)"].join("\n") + "\n", s);
    expect(s).toEqual({ assertAdded: 2, assertRemoved: 0, skipAdded: 1, skipRemoved: 0 });
    const capped = emptyStats();
    scanContent(Array.from({ length: 50 }, () => "expect(1)").join("\n"), capped, 10);
    expect(capped.assertAdded).toBe(10);
  });

  test("the diff line budget is shared and bounded", () => {
    const s = emptyStats();
    scanDiffLines(Array.from({ length: 30 }, () => "+expect(1)"), s, { left: 5 });
    expect(s.assertAdded).toBe(5);
  });
});

function ev(path: string, o: Omit<Partial<EditEvidence>, "stats"> & { stats?: Partial<EditStats> } = {}): EditEvidence {
  return { seq: 1, path, inFix: false, changed: 2, ...o, stats: { ...emptyStats(), ...o.stats } };
}

const rules = (hints: Hint[]): string[] => hints.map((h) => `${h.rule}:${h.path}`);

describe("computeHints rules", () => {
  const base = { lastCheckSeq: 100, cwd: "/p" };

  test.each<[string, EditEvidence[], string[]]>([
    ["test edited in Fix", [ev("/p/tests/a.test.ts", { inFix: true })], ["test-modified-during-fix:/p/tests/a.test.ts"]],
    ["test edited outside Fix", [ev("/p/tests/a.test.ts")], []],
    ["non-test edited in Fix", [ev("/p/src/a.ts", { inFix: true })], []],
    ["assertions removed", [ev("/p/tests/a.test.ts", { stats: { assertRemoved: 2, assertAdded: 1 } })], ["assertions-removed:/p/tests/a.test.ts"]],
    ["assertions moved between test files (net 0) produces no hint", [ev("/p/tests/a.test.ts", { stats: { assertRemoved: 2 } }), ev("/p/tests/b.test.ts", { stats: { assertAdded: 2 } })], []],
    ["assertions net removed across files fires only on file with removal", [ev("/p/tests/a.test.ts", { stats: { assertRemoved: 3 } }), ev("/p/tests/b.test.ts", { stats: { assertAdded: 1 } })], ["assertions-removed:/p/tests/a.test.ts"]],
    ["assertions balanced", [ev("/p/tests/a.test.ts", { stats: { assertRemoved: 2, assertAdded: 2 } })], []],
    ["assertions removed in a non-test file", [ev("/p/src/a.ts", { stats: { assertRemoved: 3 } })], []],
    ["snapshot file gets no test rules", [ev("/p/tests/__snapshots__/a.test.ts.snap", { stats: { assertRemoved: 5, skipAdded: 2 } })], []],
    ["standalone .snap file gets no test rules", [ev("/p/tests/a.snap", { inFix: true, stats: { assertRemoved: 5 } })], []],
    ["skip added", [ev("/p/tests/a.test.ts", { stats: { skipAdded: 1 } })], ["test-skipped:/p/tests/a.test.ts"]],
    ["skip moved", [ev("/p/tests/a.test.ts", { stats: { skipAdded: 1, skipRemoved: 1 } })], []],
    ["skip in a non-test file", [ev("/p/src/a.ts", { stats: { skipAdded: 1 } })], []],
    ["sensitive path", [ev("/p/src/auth/a.ts")], ["sensitive-path:/p/src/auth/a.ts"]],
    ["migration path is sensitive", [ev("/p/db/migration/001.sql")], ["sensitive-path:/p/db/migration/001.sql"]],
    ["env example is not sensitive", [ev("/p/.env.example")], []],
    ["env sample is not sensitive", [ev("/p/config/.env.sample")], []],
    ["non-sensitive path", [ev("/p/src/author/a.ts")], []],
    ["unchecked edit", [ev("/p/src/a.ts", { seq: 101 })], ["unchecked-edit:/p/src/a.ts"]],
    ["checked edit", [ev("/p/src/a.ts", { seq: 99 })], []],
    ["manifest", [ev("/p/package.json")], ["dependency-change:/p/package.json"]],
    ["public surface", [ev("/p/src/index.ts")], ["public-surface:/p/src/index.ts"]],
    ["public surface in a test is ignored", [ev("/p/tests/schema.test.ts")], []],
    ["config", [ev("/p/tsconfig.json")], ["config-change:/p/tsconfig.json"]],
    ["large change", [ev("/p/src/a.ts", { changed: 301 })], ["large-change:/p/src/a.ts"]],
    ["300 lines is not large", [ev("/p/src/a.ts", { changed: 300 })], []],
    ["large change adds up over edits", [ev("/p/src/a.ts", { changed: 200 }), ev("/p/src/a.ts", { changed: 150 })], ["large-change:/p/src/a.ts"]],
    ["one hint per (rule, path) over several edits", [ev("/p/tests/a.test.ts", { inFix: true }), ev("/p/tests/a.test.ts", { inFix: true })], ["test-modified-during-fix:/p/tests/a.test.ts"]],
    ["doc: sensitive name ignored", [ev("/p/SECURITY.md")], []],
    ["doc: extensionless SECURITY ignored", [ev("/p/SECURITY")], []],
    ["doc: sensitive directory ignored", [ev("/p/docs/auth/login.md")], []],
    ["doc: unchecked edit ignored", [ev("/p/README.md", { seq: 101 })], []],
    ["doc: README in a test directory gets no test rules", [ev("/p/tests/README.md", { inFix: true, stats: { assertRemoved: 2 } })], []],
    ["doc: public surface ignored", [ev("/p/src/api/README.md")], []],
    ["doc: large change still flagged", [ev("/p/docs/big.md", { changed: 301 })], ["large-change:/p/docs/big.md"]],
    ["mdx is code", [ev("/p/src/auth/page.mdx")], ["sensitive-path:/p/src/auth/page.mdx"]],
    ["code file next to a doc file keeps its hints", [ev("/p/README.md", { seq: 101 }), ev("/p/src/a.ts", { seq: 101 })], ["unchecked-edit:/p/src/a.ts"]],
  ])("%s", (_name, edits, expected) => {
    expect(rules(computeHints({ ...base, edits }))).toEqual(expected);
  });

  test("a SECURITY-only edit gets no sensitive-path hint", () => {
    const h = computeHints({ ...base, edits: [ev("/p/SECURITY")] });
    expect(h).toEqual([]);
  });

  test("no completed check: every edited file is unchecked", () => {
    const h = computeHints({ edits: [ev("/p/src/a.ts"), ev("/p/src/b.ts")], lastCheckSeq: null, cwd: "/p" });
    expect(rules(h)).toEqual(["unchecked-edit:/p/src/a.ts", "unchecked-edit:/p/src/b.ts"]);
    expect(h[0]?.reason).toContain("no check completed");
  });

  test("a sensitive test file is only a warning", () => {
    const h = computeHints({ ...base, edits: [ev("/p/src/auth.test.ts")] });
    expect(h).toEqual([{ rule: "sensitive-path", severity: "warn", path: "/p/src/auth.test.ts", reason: 'path matches sensitive pattern "auth" (test file)' }]);
  });

  test("sorted by severity, then rule, then path; reasons carry counts", () => {
    const h = computeHints({
      ...base,
      edits: [
        ev("/p/tsconfig.json"),
        ev("/p/package.json"),
        ev("/p/src/secrets/b.ts"),
        ev("/p/src/auth/a.ts"),
        ev("/p/tests/x.test.ts", { stats: { assertRemoved: 3 } }),
      ],
    });
    expect(h.map((x) => `${x.severity}:${x.rule}:${x.path}`)).toEqual([
      "high:assertions-removed:/p/tests/x.test.ts",
      "high:sensitive-path:/p/src/auth/a.ts",
      "high:sensitive-path:/p/src/secrets/b.ts",
      "warn:dependency-change:/p/package.json",
      "info:config-change:/p/tsconfig.json",
    ]);
    expect(h[0]?.reason).toBe("3 assertion lines removed, 0 added");
  });

  test("deterministic: same input, same output, independent of edit order", () => {
    const edits = [ev("/p/src/auth/a.ts"), ev("/p/package.json"), ev("/p/tsconfig.json"), ev("/p/tests/x.test.ts", { stats: { skipAdded: 2 } })];
    const a = computeHints({ ...base, edits });
    const b = computeHints({ ...base, edits: [...edits].reverse() });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("check-scope hint (FR-017)", () => {
  const base = { lastCheckSeq: 100, cwd: "/p" };

  test("a file outside the passing check's scope gets a warn hint with the label", () => {
    const h = computeHints({ ...base, edits: [ev("/p/src/b.ts")], outOfScope: new Map([["/p/src/b.ts", "packages/web"]]) });
    expect(h).toEqual([
      { rule: "check-scope", severity: "warn", path: "/p/src/b.ts", reason: "outside the scope of the passing check (packages/web)" },
    ]);
  });

  test("a documentation path in outOfScope is ignored", () => {
    expect(computeHints({ ...base, edits: [ev("/p/README.md")], outOfScope: new Map([["/p/README.md", "packages/web"]]) })).toEqual([]);
  });

  test("no outOfScope map or no entry for the file means no hint", () => {
    expect(computeHints({ ...base, edits: [ev("/p/src/b.ts")] })).toEqual([]);
    expect(computeHints({ ...base, edits: [ev("/p/src/b.ts")], outOfScope: new Map() })).toEqual([]);
  });
});

describe("recommend", () => {
  const hint = (rule: HintRule, severity: Hint["severity"], path = "a"): Hint => ({ rule, severity, path, reason: "r" });
  const high = (rule: HintRule, path?: string): Hint => hint(rule, "high", path);

  test.each<[string, Hint[], Status, string]>([
    ["no hints, checked", [], "checked", "skim"],
    ["only warn/info, checked", [hint("unchecked-edit", "warn"), hint("config-change", "info")], "checked", "skim"],
    ["one high, checked", [high("sensitive-path")], "checked", "read-flagged"],
    ["two high rules, checked", [high("sensitive-path"), high("test-skipped")], "checked", "read-flagged"],
    ["three high instances of one rule", [high("sensitive-path", "a"), high("sensitive-path", "b"), high("sensitive-path", "c")], "checked", "read-flagged"],
    ["three distinct high rules", [high("sensitive-path"), high("test-skipped"), high("assertions-removed")], "checked", "read-all"],
    ["failing with a high hint", [high("sensitive-path")], "failing", "read-all"],
    ["failing without hints", [], "failing", "read-flagged"],
    ["failing with warn only", [hint("unchecked-edit", "warn")], "failing", "read-flagged"],
    ["unchecked without hints", [], "unchecked", "read-flagged"],
    ["unchecked with warn only", [hint("unchecked-edit", "warn")], "unchecked", "read-flagged"],
    ["unchecked with one high", [high("sensitive-path")], "unchecked", "read-flagged"],
    ["no-changes", [], "no-changes", "skim"],
    ["no-changes ignores hints", [high("sensitive-path")], "no-changes", "skim"],
  ])("%s", (_name, hints, status, expected) => {
    expect(recommend(hints, status)).toBe(expected);
  });
});

describe("integration through the analyzer", () => {
  const cwd = "/home/user/project";
  const write = (id: string, file: string, content: string, result: Record<string, unknown>): string[] => [
    toolUse(id, "Write", { file_path: file, content }),
    toolResult(id, "ok", { toolUseResult: result }),
  ];

  test("a Write without create marker or patch counts the written content as added", () => {
    resetIds();
    const f = `${cwd}/tests/a.test.ts`;
    const a = analyzeSession([prompt("x"), ...write("w1", f, "it.skip('a');\nexpect(1);\n", {}), ...bash("b1", "pnpm test")]);
    expect(rules(a.prompts[0]!.hints)).toEqual([`test-skipped:${f}`]);
  });

  test("a created test file adds assertions: nothing removed, nothing flagged", () => {
    resetIds();
    const f = `${cwd}/tests/a.test.ts`;
    const a = analyzeSession([prompt("x"), ...write("w1", f, "expect(1);\n", { type: "create", content: "expect(1);\n", structuredPatch: [] }), ...bash("b1", "pnpm test")]);
    expect(a.prompts[0]!.hints).toEqual([]);
    expect(a.prompts[0]!.recommendation).toBe("skim");
  });

  test("an edit in Fix is recognised by the shared phase classifier, also via a shell edit", () => {
    resetIds();
    const f = `${cwd}/tests/a.test.ts`;
    const lines = [
      prompt("x"),
      ...edit("e1", `${cwd}/src/a.ts`),
      ...bash("b1", "pnpm test", { exit: 1, output: "1 failed" }),
      toolUse("s1", "Bash", { command: "sed -i s/a/b/ tests/a.test.ts" }),
      toolResult("s1", "ok", {
        toolUseResult: { bashEditDiff: { files: [{ filePath: f, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-expect(a)", "+expect(b)"] }] }] } },
      }),
      ...bash("b2", "pnpm test"),
    ];
    const a = analyzeSession(lines);
    expect(rules(a.prompts[0]!.hints)).toEqual([`test-modified-during-fix:${f}`]);
  });

  test("an edit before the failing check is not a Fix edit", () => {
    resetIds();
    const f = `${cwd}/tests/a.test.ts`;
    const a = analyzeSession([prompt("x"), ...edit("e1", f), ...bash("b1", "pnpm test", { exit: 1, output: "1 failed" })]);
    expect(a.prompts[0]!.hints).toEqual([]);
    expect(a.prompts[0]!.recommendation).toBe("read-flagged");
  });

  test("unchecked-edit follows the status: only files edited after the last completed check", () => {
    resetIds();
    const a = analyzeSession([
      prompt("x"),
      ...edit("e1", `${cwd}/src/a.ts`),
      ...bash("b1", "pnpm test"),
      ...edit("e2", `${cwd}/src/b.ts`),
    ]);
    const p = a.prompts[0]!;
    expect(p.status).toBe("unchecked");
    expect(rules(p.hints)).toEqual([`unchecked-edit:${cwd}/src/b.ts`]);
  });

  test("a check that did not run does not count as a completed check", () => {
    resetIds();
    const id = "t1";
    const a = analyzeSession([
      prompt("x"),
      ...edit("e1", `${cwd}/src/a.ts`),
      toolUse(id, "Bash", { command: "pnpm test" }),
      toolResult(id, "permission denied", { isError: true }),
    ]);
    expect(rules(a.prompts[0]!.hints)).toEqual([`unchecked-edit:${cwd}/src/a.ts`]);
  });

  test("detail mode produces identical hints and recommendation", () => {
    resetIds();
    const lines = [
      prompt("x"),
      toolUse("e1", "Edit", { file_path: `${cwd}/tests/a.test.ts`, old_string: "a", new_string: "b" }),
      toolResult("e1", "ok", { toolUseResult: patchResult(["it.skip('a')"], ["expect(a)", "expect(b)"]) }),
      ...bash("b1", "pnpm test"),
    ];
    const plain = analyzeSession(lines);
    const d = createAnalyzer({ detail: true });
    for (const l of lines) d.push(l);
    expect(JSON.stringify(d.finish())).toBe(JSON.stringify(plain));
    expect(rules(plain.prompts[0]!.hints)).toEqual([`assertions-removed:${cwd}/tests/a.test.ts`, `test-skipped:${cwd}/tests/a.test.ts`]);
    expect(plain.prompts[0]!.recommendation).toBe("read-flagged");
  });

  test("hints are computed from counters: a huge change keeps only bounded evidence", () => {
    resetIds();
    const f = `${cwd}/tests/a.test.ts`;
    const many = Array.from({ length: 5000 }, () => "expect(a)");
    const a = analyzeSession([
      prompt("x"),
      toolUse("e1", "Edit", { file_path: f, old_string: "a", new_string: "b" }),
      toolResult("e1", "ok", { toolUseResult: patchResult([], many) }),
      ...bash("b1", "pnpm test"),
    ]);
    const p = a.prompts[0]!;
    expect(p.files[0]?.removed).toBe(5000);
    expect(p.hints.find((h) => h.rule === "assertions-removed")?.reason).toBe("2000 assertion lines removed, 0 added");
    expect(p.hints.some((h) => h.rule === "large-change")).toBe(true);
  });
});
