// Pack packages/cli, verify tarball contents, run it via npx in isolation.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/cli");
const dirs = [];
let server = null;

/** Starts the packed CLI in server mode; resolves with the printed URL (15 s timeout). */
function startPacked(tarball, cwd, args) {
  server = spawn("npx", ["--yes", `--package=${tarball}`, "lgtm-review", ...args], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  return new Promise((res, rej) => {
    let out = "";
    const timer = setTimeout(() => rej(new Error(`no URL within 15 s; stdout: ${out.trim()}`)), 15000);
    server.stdout.on("data", (d) => {
      out += d;
      const m = /^(http:\/\/127\.0\.0\.1:\d+\/#k=[0-9a-f]{64})$/m.exec(out);
      if (m) {
        clearTimeout(timer);
        res(m[1]);
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`server exited early (${code})`));
    });
  });
}

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

  // Server mode: URL printed, /api needs the token.
  const projects = join(runDir, "projects");
  mkdirSync(projects);
  const url = new URL(await startPacked(tarball, runDir, ["--no-open", "--port", "0", "--projects-dir", projects, "--dir", runDir]));
  const token = url.hash.slice(3);
  const denied = await fetch(`${url.origin}/api/sessions`);
  if (denied.status !== 403) fail(`/api/sessions without token: expected 403, got ${denied.status}`);
  const allowed = await fetch(`${url.origin}/api/sessions`, { headers: { "X-Lgtm-Token": token } });
  if (allowed.status !== 200) fail(`/api/sessions with token: expected 200, got ${allowed.status}`);
  console.log("smoke ok: server auth");
} catch (err) {
  console.error(`smoke FAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  if (server && server.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
