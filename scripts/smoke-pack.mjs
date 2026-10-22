// Pack packages/cli, verify tarball contents, run it via npx in isolation.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/cli");
const dirs = [];

function fail(reason) {
  throw new Error(reason);
}

try {
  const packDir = mkdtempSync(join(tmpdir(), "lgtm-smoke-pack-"));
  dirs.push(packDir);
  const runDir = mkdtempSync(join(tmpdir(), "lgtm-smoke-run-"));
  dirs.push(runDir);

  execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: cliDir, stdio: "pipe" });
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) fail(`expected 1 tarball, found ${tarballs.length}`);
  const tarball = join(packDir, tarballs[0]);

  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const required of ["package/package.json", "package/dist/cli.js", "package/README.md", "package/LICENSE"]) {
    if (!entries.includes(required)) fail(`tarball missing ${required}`);
  }
  const bad = entries.filter((e) => e.startsWith("package/src/") || e.includes(".test."));
  if (bad.length) fail(`tarball contains forbidden entries: ${bad.join(", ")}`);

  const pkg = JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (String(spec).startsWith("workspace:")) fail(`dependency ${name} uses ${spec}`);
  }

  const res = spawnSync("npx", ["--yes", `--package=${tarball}`, "lgtm-review", "--version"], { cwd: runDir, encoding: "utf8" });
  if (res.status !== 0) fail(`npx exited ${res.status}: ${(res.stderr || "").trim().split("\n").pop()}`);
  if (!/^lgtm-review \d+\.\d+\.\d+/m.test(res.stdout)) fail(`unexpected stdout: ${res.stdout.trim()}`);
  console.log(`smoke ok: ${res.stdout.trim()}`);
} catch (err) {
  console.error(`smoke FAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
