import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

const corePkg = JSON.parse(
  readFileSync(new URL("./packages/core/package.json", import.meta.url), "utf8")
);
const coreNodeSubpaths = Object.keys(corePkg.exports || {})
  .filter((k) => k !== ".")
  .map((k) => `${corePkg.name}/${k.replace(/^\.\/?/, "")}`);

const bannedNodeBuiltins = Array.from(
  new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), "node:test", "test"])
);

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/fixtures/**",
      "**/__golden__/**",
      "**/coverage/**",
      "**/*.d.ts",
      "node_modules/**",
      ".turbo/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.{js,mjs}"],
    rules: {
      "no-undef": "warn",
    },
  },
  {
    files: ["packages/*/src/**/*.{ts,tsx,js,jsx}", "scripts/**/*.{ts,js,mjs}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "no-control-regex": "warn",
      "no-empty": "warn",
      "no-regex-spaces": "warn",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: [
      "packages/core/src/**",
      "packages/web/src/**",
    ],
    ignores: [
      "packages/core/src/node/**",
      "packages/core/src/testing/**",
      "**/*.test.{ts,tsx,mjs}",
      "**/*.perf.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...bannedNodeBuiltins.map((name) => ({
              name,
              message: `Node builtin '${name}' is forbidden in packages/core (outside src/node/ and src/testing/) and packages/web per AGENTS.md.`,
            })),
            ...coreNodeSubpaths.map((name) => ({
              name,
              message: `Node subpath '${name}' is forbidden in packages/core (outside src/node/ and src/testing/) and packages/web per AGENTS.md.`,
            })),
          ],
          patterns: [
            {
              group: ["./node/*", "../node/*", "**/core/src/node/*"],
              message: "Node-specific code in core/src/node is forbidden in packages/core (outside src/node/ and src/testing/) and packages/web per AGENTS.md.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportExpression[source.value=/^(${bannedNodeBuiltins.map((m) => m.replace("/", ".")).join("|")})$/]`,
          message: "Dynamic import of Node builtins is forbidden in packages/core (outside src/node/ and src/testing/) and packages/web per AGENTS.md.",
        },
      ],
    },
  },
  {
    files: [
      "packages/cli/src/**",
      "packages/core/src/node/**",
      "packages/core/src/testing/**",
      "scripts/**",
    ],
    ignores: [
      "**/*.test.{ts,tsx,mjs}",
      "**/*.perf.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["exec", "execSync"],
              message: "Git and commands must only use execFile or spawn with fixed arguments per AGENTS.md.",
            },
            {
              name: "child_process",
              importNames: ["exec", "execSync"],
              message: "Git and commands must only use execFile or spawn with fixed arguments per AGENTS.md.",
            },
          ],
        },
      ],
    },
  },
);
