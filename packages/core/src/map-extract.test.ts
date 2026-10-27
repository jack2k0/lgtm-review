import { describe, expect, test } from "vitest";
import {
  cleanSpecifier,
  createResolver,
  edgeKindFor,
  extractImports,
  IMPORT_EXTENSIONS,
  loadTsconfigAliases,
  mapLanguageOf,
  normalizePath,
  stripJsonComments,
  type MapHost,
  type TsconfigAlias,
} from "./map-extract.js";

function makeHost(files: readonly string[], configs: Record<string, unknown> = {}): MapHost {
  const set = new Set(files);
  return {
    exists: (path) => set.has(path),
    readJson: (path) => configs[path],
    listDirs: (dir) => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const names = new Set<string>();
      for (const f of [...set, ...Object.keys(configs)]) {
        if (f.startsWith(prefix) && f.indexOf("/", prefix.length) !== -1) names.add(f.slice(prefix.length, f.indexOf("/", prefix.length)));
      }
      return [...names].sort();
    },
  };
}

describe("extractImports", () => {
  const source = [
    'import a from "./a";',
    'import type { B } from "./b";',
    'import "./side.css?raw";',
    "import {",
    "  c,",
    "  d,",
    '} from "./c";',
    'export * from "./e";',
    'export { f } from "./f";',
    'export type { G } from "./g";',
    'const h = await import("./h");',
    'const i = require("./i");',
    "const j = await import(`./j`);",
  ].join("\n");

  test("extracts every M7 syntax with a stripped specifier and its line", () => {
    expect(extractImports(source)).toEqual([
      { specifier: "./a", syntax: "import", line: 1 },
      { specifier: "./b", syntax: "type-import", line: 2 },
      { specifier: "./side.css", syntax: "import", line: 3 },
      { specifier: "./c", syntax: "import", line: 4 },
      { specifier: "./e", syntax: "export", line: 8 },
      { specifier: "./f", syntax: "export", line: 9 },
      { specifier: "./g", syntax: "type-import", line: 10 },
      { specifier: "./h", syntax: "dynamic-import", line: 11 },
      { specifier: "./i", syntax: "require", line: 12 },
    ]);
  });

  test("extracts dynamic import and require with comments inside the call", () => {
    const src = [
      'const a = await import(/* slow */ "./a");',
      'const b = await import( "./b" /* note */ );',
      'const c = import /* lazy */ ( "./c" );',
      'const d = require(/* sync */ "./d");',
      'const e = require( "./e" /* req */ );',
      'const f = require // note\n ( "./f" );',
      'const g = import( // line\n "./g" );',
    ].join("\n");
    const imps = extractImports(src);
    expect(imps.map((i) => i.specifier)).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./g"]);
  });

  test("template-literal dynamic imports are ignored", () => {
    expect(extractImports("const x = import(`./x`); const y = import(name);")).toEqual([]);
  });

  test("query and hash are stripped, including from side-effect imports", () => {
    expect(extractImports('import "./a?url#frag";')).toEqual([{ specifier: "./a", syntax: "import", line: 1 }]);
  });

  test("empty and malformed inputs never throw", () => {
    expect(extractImports("")).toEqual([]);
    expect(extractImports('import x "y"')).toEqual([]);
    expect(extractImports("export { a }")).toEqual([]);
    expect(extractImports("import (./x)")).toEqual([]);
  });

  test("edge kind is type only for import type / export type", () => {
    expect(edgeKindFor("type-import")).toBe("type");
    expect(edgeKindFor("import")).toBe("import");
    expect(edgeKindFor("export")).toBe("import");
    expect(edgeKindFor("dynamic-import")).toBe("import");
    expect(edgeKindFor("require")).toBe("import");
  });

  test("cleanSpecifier trims and cuts query/hash", () => {
    expect(cleanSpecifier("  ./x?raw  ")).toBe("./x");
    expect(cleanSpecifier("./x#a")).toBe("./x");
    expect(cleanSpecifier("react")).toBe("react");
  });
});

describe("paths", () => {
  test("normalizePath collapses . and ..", () => {
    expect(normalizePath("src/./a/../b.ts")).toBe("src/b.ts");
    expect(normalizePath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizePath("../a.ts")).toBe("../a.ts");
    expect(normalizePath("")).toBe(".");
  });
});

describe("createResolver", () => {
  const resolve = (files: readonly string[], specifier: string, fromFile = "src/from.ts", aliases: readonly TsconfigAlias[] = []) =>
    createResolver({ host: makeHost(files), aliases }).resolve(specifier, fromFile);

  test("resolution order: exact, extensions, index, .js -> .ts", () => {
    expect(resolve(["src/x"], "./x")).toBe("src/x");
    expect(resolve(["src/x.ts", "src/x.tsx"], "./x")).toBe("src/x.ts");
    expect(resolve(["src/x.tsx", "src/x.js"], "./x")).toBe("src/x.tsx");
    expect(resolve(["src/x.mts"], "./x")).toBe("src/x.mts");
    expect(resolve(["src/x.cts"], "./x")).toBe("src/x.cts");
    expect(resolve(["src/x.js"], "./x")).toBe("src/x.js");
    expect(resolve(["src/x.jsx"], "./x")).toBe("src/x.jsx");
    expect(resolve(["src/x.mjs"], "./x")).toBe("src/x.mjs");
    expect(resolve(["src/x.cjs"], "./x")).toBe("src/x.cjs");
    expect(resolve(["src/dir/index.tsx"], "./dir")).toBe("src/dir/index.tsx");
    expect(resolve(["src/b.ts"], "./b.js")).toBe("src/b.ts");
  });

  test("exact path wins over an appended extension", () => {
    expect(resolve(["src/x.js", "src/x.ts"], "./x.js")).toBe("src/x.js");
  });

  test("extension list matches the documented order", () => {
    expect([...IMPORT_EXTENSIONS]).toEqual([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
  });

  test("relative parents and repo-root escape", () => {
    expect(resolve(["src/lib/x.ts"], "../lib/x", "src/sub/from.ts")).toBe("src/lib/x.ts");
    expect(resolve(["x.ts"], "../x", "a.ts")).toBeNull();
    expect(resolve(["/outside.ts"], "/outside")).toBeNull();
  });

  test("query specifiers and external packages", () => {
    expect(resolve(["src/x.ts"], "./x?raw")).toBe("src/x.ts");
    expect(resolve(["src/x.ts"], "react")).toBeNull();
  });

  test("tsconfig literal and wildcard aliases, first matching target wins", () => {
    const files = ["src/foo.ts", "src/bar.ts", "config.ts"];
    expect(resolve(files, "@/foo", "src/a.ts", [{ pattern: "@/*", targets: ["src/*"] }])).toBe("src/foo.ts");
    expect(resolve(files, "@config", "src/a.ts", [{ pattern: "@config", targets: ["config.ts"] }])).toBe("config.ts");
    expect(
      resolve(files, "@/foo", "src/a.ts", [
        { pattern: "@/*", targets: ["missing/*", "src/*"] },
      ]),
    ).toBe("src/foo.ts");
    expect(resolve(files, "@/nope", "src/a.ts", [{ pattern: "@/*", targets: ["src/*"] }])).toBeNull();
  });

  test("host root is only an exists/read prefix; results stay repo-relative", () => {
    const host: MapHost = { exists: (path) => path === "repo/src/x.ts" };
    const resolver = createResolver({ host, root: "repo" });
    expect(resolver.resolve("./x", "src/a.ts")).toBe("src/x.ts");
    const noReadJson: MapHost = { exists: () => false };
    expect(loadTsconfigAliases("", noReadJson)).toEqual([]);
  });
});

describe("loadTsconfigAliases", () => {
  test("reads tsconfig.base.json and tsconfig.json paths", () => {
    const host = makeHost(["tsconfig.base.json", "tsconfig.json"], {
      "tsconfig.base.json": { compilerOptions: { paths: { "~/*": ["lib/*"] } } },
      "tsconfig.json": { compilerOptions: { paths: { "@/*": ["src/*"] } } },
    });
    expect(loadTsconfigAliases("", host)).toEqual([
      { pattern: "~/*", targets: ["lib/*"] },
      { pattern: "@/*", targets: ["src/*"] },
    ]);
  });

  test("JSON with comments is tolerated", () => {
    const host = makeHost(["tsconfig.json"], {
      "tsconfig.json": '{\n // comment\n "compilerOptions": { "paths": { "@/*": ["src/*"] /* x */ } }\n}',
    });
    expect(loadTsconfigAliases("", host)).toEqual([{ pattern: "@/*", targets: ["src/*"] }]);
  });

  test("extends one level: parent aliases are visible and the child overrides them", () => {
    const host = makeHost(["tsconfig.json", "base.json"], {
      "tsconfig.json": { extends: "./base.json", compilerOptions: { paths: { "@/*": ["src/*"] } } },
      "base.json": { compilerOptions: { paths: { "@/*": ["lib/*"], "~/*": ["lib/*"] } } },
    });
    expect(loadTsconfigAliases("", host)).toEqual([
      { pattern: "@/*", targets: ["src/*"] },
      { pattern: "~/*", targets: ["lib/*"] },
    ]);
  });

  test("malformed JSON, missing files and multiple stars are ignored", () => {
    const malformed = makeHost(["tsconfig.json"], { "tsconfig.json": "{ not json" });
    expect(loadTsconfigAliases("", malformed)).toEqual([]);
    const multi = makeHost(["tsconfig.json"], { "tsconfig.json": { compilerOptions: { paths: { "a/*/b*": ["src/*"] } } } });
    expect(loadTsconfigAliases("", multi)).toEqual([]);
    const noJson = makeHost(["tsconfig.json"], { "tsconfig.json": 42 });
    expect(loadTsconfigAliases("", noJson)).toEqual([]);
  });

  test("extends escaping the root is ignored", () => {
    const host = makeHost(["tsconfig.json"], {
      "tsconfig.json": { extends: "../outside.json", compilerOptions: { paths: { "@/*": ["src/*"] } } },
      "../outside.json": { compilerOptions: { paths: { "~/*": ["lib/*"] } } },
    });
    expect(loadTsconfigAliases("", host)).toEqual([{ pattern: "@/*", targets: ["src/*"] }]);
  });

  test("stripJsonComments keeps comment-like text inside strings", () => {
    expect(stripJsonComments('{"a":"// x","b":"/* y */"} // z')).toBe('{"a":"// x","b":"/* y */"} ');
  });
});

describe("mapLanguageOf", () => {
  test.each<[string, "ts" | "py" | null]>([
    ["src/main.ts", "ts"],
    ["src/app.tsx", "ts"],
    ["lib/index.js", "ts"],
    ["lib/component.jsx", "ts"],
    ["src/module.mts", "ts"],
    ["src/module.cts", "ts"],
    ["src/module.mjs", "ts"],
    ["src/module.cjs", "ts"],
    ["backend/manage.py", "py"],
    ["backend/shop/models.py", "py"],
    ["src/types.d.ts", null],
    ["src/types.d.mts", null],
    ["src/types.d.cts", null],
    ["backend/stub.pyi", null],
    ["README.md", null],
    ["package.json", null],
    ["", null],
  ])("%s => %s", (path, expected) => {
    expect(mapLanguageOf(path)).toBe(expected);
  });
});

describe("NodeNext extension mapping", () => {
  const resolve = (files: readonly string[], specifier: string) =>
    createResolver({ host: makeHost(files) }).resolve(specifier, "src/from.ts");

  test(".js maps to .ts then .tsx; .mjs to .mts; .cjs to .cts; .jsx to .tsx", () => {
    expect(resolve(["src/Button.tsx"], "./Button.js")).toBe("src/Button.tsx");
    expect(resolve(["src/Button.ts", "src/Button.tsx"], "./Button.js")).toBe("src/Button.ts");
    expect(resolve(["src/helper.mts"], "./helper.mjs")).toBe("src/helper.mts");
    expect(resolve(["src/helper.cts"], "./helper.cjs")).toBe("src/helper.cts");
    expect(resolve(["src/View.tsx"], "./View.jsx")).toBe("src/View.tsx");
    expect(resolve(["src/helper.ts"], "./helper.mjs")).toBeNull();
  });
});

describe("tsconfig baseUrl", () => {
  test("paths targets are relative to baseUrl", () => {
    const configs = { "tsconfig.json": { compilerOptions: { baseUrl: "src", paths: { "@/*": ["*"], "@lib": ["lib/index"] } } } };
    const host = makeHost(["src/a/b.ts", "src/lib/index.ts"], configs);
    const aliases = loadTsconfigAliases("", host);
    expect(aliases[0]).toEqual({ pattern: "@/*", targets: ["src/*"] });
    expect(aliases[1]).toEqual({ pattern: "@lib", targets: ["src/lib/index"] });
    const r = createResolver({ host, aliases });
    expect(r.resolve("@/a/b", "x.ts")).toBe("src/a/b.ts");
    expect(r.resolve("@lib", "x.ts")).toBe("src/lib/index.ts");
  });

  test("baseUrl-only bare specifier resolves when the file exists, else stays external", () => {
    const configs = { "tsconfig.json": { compilerOptions: { baseUrl: "./src" } } };
    const host = makeHost(["src/utils/fmt.ts"], configs);
    const r = createResolver({ host, aliases: loadTsconfigAliases("", host) });
    expect(r.resolve("utils/fmt", "src/a.ts")).toBe("src/utils/fmt.ts");
    expect(r.resolve("react", "src/a.ts")).toBeNull();
  });

  test("baseUrl '.' and no baseUrl leave aliases unchanged", () => {
    const host = makeHost(["lib/x.ts"], { "tsconfig.json": { compilerOptions: { baseUrl: "." } } });
    const r = createResolver({ host, aliases: loadTsconfigAliases("", host) });
    expect(r.resolve("lib/x", "a.ts")).toBe("lib/x.ts");
  });
});

describe("workspace packages", () => {
  const files = [
    "packages/core/src/index.ts",
    "packages/core/src/node/index.ts",
    "packages/core/src/util.ts",
    "packages/ui/src/button.tsx",
    "packages/lib/src/main.ts",
    "apps/web/src/app.ts",
  ];
  const manifests = {
    "packages/core/package.json": { name: "@lgtm/core", main: "dist/index.js" },
    "packages/ui/package.json": { name: "ui", types: "./dist/button.d.ts" },
    "packages/lib/package.json": { name: "lib", exports: { ".": { types: "./dist/main.d.ts", default: "./dist/main.js" } } },
    "apps/web/package.json": { name: "web" },
  };

  const check = (extra: Record<string, unknown>) => {
    const host = makeHost(files, { ...manifests, ...extra });
    const r = createResolver({ host });
    expect(r.resolve("@lgtm/core", "apps/web/src/app.ts")).toBe("packages/core/src/index.ts");
    expect(r.resolve("@lgtm/core/node", "apps/web/src/app.ts")).toBe("packages/core/src/node/index.ts");
    expect(r.resolve("@lgtm/core/util", "apps/web/src/app.ts")).toBe("packages/core/src/util.ts");
    expect(r.resolve("ui", "apps/web/src/app.ts")).toBe("packages/ui/src/button.tsx");
    expect(r.resolve("lib", "apps/web/src/app.ts")).toBe("packages/lib/src/main.ts");
    expect(r.resolve("@lgtm/unknown", "apps/web/src/app.ts")).toBeNull();
    expect(r.resolve("react", "apps/web/src/app.ts")).toBeNull();
  };

  test("pnpm-workspace.yaml globs", () => {
    check({ "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - apps/* # apps\nallowBuilds:\n  esbuild: true\n' });
  });

  test("package.json workspaces (array and object forms)", () => {
    check({ "package.json": { workspaces: ["packages/*", "apps/*"] } });
    check({ "package.json": { workspaces: { packages: ["packages/*", "apps/*"] } } });
  });

  test("default scan of packages/*, apps/*, libs/*", () => {
    check({});
  });

  test("a package outside the declared globs is external; unmatched dist target falls back to the target itself", () => {
    const host = makeHost([...files, "packages/raw/dist/index.js"], {
      ...manifests,
      "packages/raw/package.json": { name: "raw", main: "dist/index.js" },
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    });
    const r = createResolver({ host });
    expect(r.resolve("@lgtm/core", "a.ts")).toBeNull();
    const all = makeHost([...files, "packages/raw/dist/index.js"], {
      ...manifests,
      "packages/raw/package.json": { name: "raw", main: "dist/index.js" },
    });
    expect(createResolver({ host: all }).resolve("raw", "a.ts")).toBe("packages/raw/dist/index.js");
  });
});

describe("extractImports line lookup (perf parity)", () => {
  const COUNT = 3000;
  const lines = Array.from({ length: COUNT }, (_, i) => `import v${i} from "./m${i}";`);
  const expected = Array.from({ length: COUNT }, (_, i) => ({ specifier: `./m${i}`, syntax: "import", line: i + 1 }));

  test("identical output: every import of a many-line file keeps its 1-based line", () => {
    expect(extractImports(lines.join("\n"))).toEqual(expected);
  });

  test("line numbers stay exact with CRLF endings and a last line without a newline", () => {
    const crlf = 'import a from "./a";\r\nimport b from "./b";\r\nimport c from "./c";';
    expect(extractImports(crlf)).toEqual([
      { specifier: "./a", syntax: "import", line: 1 },
      { specifier: "./b", syntax: "import", line: 2 },
      { specifier: "./c", syntax: "import", line: 3 },
    ]);
    const tail = 'export { x } from "./x";\nimport y from "./y";';
    expect(extractImports(tail)).toEqual([
      { specifier: "./x", syntax: "export", line: 1 },
      { specifier: "./y", syntax: "import", line: 2 },
    ]);
  });
});

describe("tsconfig paths without a baseUrl", () => {
  test("paths of an extended config resolve against the declaring config's directory", () => {
    const host = makeHost(["tsconfig.json", "tsconfigs/base.json", "tsconfigs/lib/base.ts", "lib/base.ts", "app.ts"], {
      "tsconfig.json": { extends: "./tsconfigs/base.json" },
      "tsconfigs/base.json": { compilerOptions: { paths: { "@base": ["lib/base.ts"] } } },
    });
    const aliases = loadTsconfigAliases("", host);
    expect(aliases).toEqual([{ pattern: "@base", targets: ["tsconfigs/lib/base.ts"] }]);
    const r = createResolver({ host, aliases });
    expect(r.resolve("@base", "app.ts")).toBe("tsconfigs/lib/base.ts");
  });

  test("the extended config's own baseUrl is relative to it; child-declared paths stay root-anchored", () => {
    const host = makeHost(["tsconfig.json", "tsconfigs/base.json", "tsconfigs/lib/base.ts", "app.ts"], {
      "tsconfig.json": { extends: "./tsconfigs/base.json", compilerOptions: { paths: { "@root": ["lib/root.ts"] } } },
      "tsconfigs/base.json": { compilerOptions: { baseUrl: "lib", paths: { "@base/*": ["*"] } } },
    });
    const aliases = loadTsconfigAliases("", host);
    expect(aliases).toEqual([
      { pattern: "@base/*", targets: ["tsconfigs/lib/*"] },
      { pattern: "@root", targets: ["lib/root.ts"] },
      { pattern: "*", targets: ["tsconfigs/lib/*"] },
    ]);
    const r = createResolver({ host, aliases });
    expect(r.resolve("@base/base", "app.ts")).toBe("tsconfigs/lib/base.ts");
    // lib/root.ts does not exist on disk: the child's own alias stays declared but does not resolve
    expect(r.resolve("@root", "app.ts")).toBeNull();
  });

  test("a baseUrl set only in the extending config anchors paths declared in the extended base", () => {
    const host = makeHost(
      ["tsconfig.json", "tsconfigs/base.json", "lib/base.ts", "tsconfigs/lib/base.ts", "app.ts"],
      {
        "tsconfig.json": {
          extends: "./tsconfigs/base.json",
          compilerOptions: { baseUrl: "." },
        },
        "tsconfigs/base.json": {
          compilerOptions: { paths: { "@base": ["lib/base.ts"] } },
        },
      },
    );
    const aliases = loadTsconfigAliases("", host);
    expect(aliases).toEqual([
      { pattern: "@base", targets: ["lib/base.ts"] },
      { pattern: "*", targets: ["*"] },
    ]);
    const r = createResolver({ host, aliases });
    expect(r.resolve("@base", "app.ts")).toBe("lib/base.ts");
  });
});
