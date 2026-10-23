import { describe, expect, test } from "vitest";
import {
  cleanSpecifier,
  createResolver,
  edgeKindFor,
  extractImports,
  IMPORT_EXTENSIONS,
  loadTsconfigAliases,
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
