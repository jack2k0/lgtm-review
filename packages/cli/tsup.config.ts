import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  noExternal: ["@lgtm/core", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  define: {
    __LGTM_VERSION__: JSON.stringify(pkg.version),
  },
});
