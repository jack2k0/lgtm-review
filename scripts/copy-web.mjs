// Copies the built web app (packages/web/dist) into packages/cli/dist/web.
// Runs after tsup, whose `clean` would otherwise remove it.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "packages/web/dist");
const to = resolve(root, "packages/cli/dist/web");
if (!existsSync(resolve(from, "index.html"))) {
  console.error(`copy-web: ${from}/index.html missing; build @lgtm/web first`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`copy-web: ${from} -> ${to}`);
