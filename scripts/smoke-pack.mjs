// Pack packages/cli, verify tarball contents, run it via npx in isolation.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/core/fixtures/sessions");
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
  for (const required of ["package/package.json", "package/dist/cli.js", "package/README.md", "package/LICENSE", "package/dist/web/index.html"]) {
    if (!entries.includes(required)) fail(`tarball missing ${required}`);
  }
  const bad = entries.filter((e) => e.startsWith("package/src/") || e.includes(".test."));
  if (bad.length) fail(`tarball contains forbidden entries: ${bad.join(", ")}`);

  const size = statSync(tarball).size;
  if (size >= 2 * 1024 * 1024) fail(`tarball too large: ${size} bytes (limit 2 MB)`);
  console.log(`smoke ok: tarball ${size} bytes, ${entries.length} entries`);

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

  // --summary on a fixture with hints: key lines present, command output absent, conflicts rejected.
  const sumProjects = join(runDir, "sum-projects");
  const sumDir = join(sumProjects, runDir.replace(/[/.]/g, "-"));
  mkdirSync(sumDir, { recursive: true });
  copyFileSync(join(fixturesDir, "hints-test-edits.jsonl"), join(sumDir, "hints-test-edits.jsonl"));
  copyFileSync(join(fixturesDir, "failing-check.jsonl"), join(sumDir, "failing-check.jsonl"));
  const runSummary = (args) => spawnSync("npx", ["--yes", `--package=${tarball}`, "lgtm-review", "--summary", "--projects-dir", sumProjects, "--dir", runDir, ...args], { cwd: runDir, encoding: "utf8" });
  const sum = runSummary(["--session", "hints-test"]);
  if (sum.status !== 0) fail(`--summary exited ${sum.status}: ${(sum.stderr || "").trim()}`);
  for (const line of [
    "# Review summary: Fix the add function so the tests pass.",
    "| # | Status | Review | Prompt | Files | +/- |",
    "- **high** `assertions-removed`: `/home/user/project/tests/add.test.ts`",
    "- **high** `test-skipped`: `/home/user/project/tests/net.test.ts`",
  ]) {
    if (!sum.stdout.includes(line)) fail(`--summary output lacks ${JSON.stringify(line)}:\n${sum.stdout}`);
  }
  if (!/heuristic/.test(sum.stdout)) fail("--summary output lacks the heuristic footer");
  const failing = runSummary(["--session", "failing-check"]);
  if (failing.status !== 0 || !failing.stdout.includes("(pnpm test failed)")) fail(`--summary of a failing check: ${failing.stdout}`);
  if (failing.stdout.includes("Tests: ") || /excerpt/i.test(sum.stdout + failing.stdout)) fail("--summary leaks command output");
  const noTitles = runSummary(["--session", "hints-test", "--no-titles"]);
  if (noTitles.stdout.includes("Fix the add function")) fail("--no-titles still prints prompt text");
  const conflict = spawnSync("npx", ["--yes", `--package=${tarball}`, "lgtm-review", "--summary", "--json"], { cwd: runDir, encoding: "utf8" });
  if (conflict.status !== 1 || !/cannot be combined/.test(conflict.stderr)) fail(`--summary --json: expected exit 1, got ${conflict.status}`);
  console.log("smoke ok: --summary");

  // Server mode: URL printed, /api needs the token.
  const projects = join(runDir, "projects");
  mkdirSync(projects);
  // One fixture session (Edit, Write, shell edits) so the detail routes have something to serve.
  const sessionId = "diffs-mixed";
  const sessionDir = join(projects, runDir.replace(/[/.]/g, "-"));
  mkdirSync(sessionDir);
  copyFileSync(join(fixturesDir, `${sessionId}.jsonl`), join(sessionDir, `${sessionId}.jsonl`));
  const filePath = "/home/user/project/src/greet.js";
  const url = new URL(await startPacked(tarball, runDir, ["--no-open", "--port", "0", "--projects-dir", projects, "--dir", runDir]));
  const token = url.hash.slice(3);
  const denied = await fetch(`${url.origin}/api/sessions`);
  if (denied.status !== 403) fail(`/api/sessions without token: expected 403, got ${denied.status}`);
  const allowed = await fetch(`${url.origin}/api/sessions`, { headers: { "X-Lgtm-Token": token } });
  if (allowed.status !== 200) fail(`/api/sessions with token: expected 200, got ${allowed.status}`);
  console.log("smoke ok: server auth");

  // Detail routes: steps and diff of one fixture prompt; 403 without the token, 404 for unknown prompt or path.
  const get = (path, withToken = true) => fetch(`${url.origin}${path}`, withToken ? { headers: { "X-Lgtm-Token": token } } : {});
  const stepsPath = `/api/sessions/${sessionId}/prompts/0`;
  const diffPath = `${stepsPath}/diff?path=${encodeURIComponent(filePath)}`;
  for (const p of [stepsPath, diffPath]) {
    const r = await get(p, false);
    if (r.status !== 403) fail(`GET ${p} without token: expected 403, got ${r.status}`);
  }
  const stepsRes = await get(stepsPath);
  if (stepsRes.status !== 200) fail(`GET ${stepsPath}: expected 200, got ${stepsRes.status}`);
  const steps = await stepsRes.json();
  if (!Array.isArray(steps.steps) || steps.steps.length === 0) fail("prompt detail has no steps");
  if (!steps.steps.some((st) => st.files.includes(filePath))) fail("no step lists the edited file");
  const diffRes = await get(diffPath);
  if (diffRes.status !== 200) fail(`GET diff: expected 200, got ${diffRes.status}`);
  const diff = await diffRes.json();
  if (diff.path !== filePath || diff.kind !== "M" || !Array.isArray(diff.hunks) || diff.hunks.length === 0) fail(`unexpected diff: ${JSON.stringify(diff).slice(0, 200)}`);
  if (!diff.hunks[0].lines.some((l) => l.t === "+")) fail("diff has no added lines");
  const outside = await get(`${stepsPath}/diff?path=${encodeURIComponent("/etc/passwd")}`);
  if (outside.status !== 404) fail(`diff of a path outside the prompt's files: expected 404, got ${outside.status}`);
  const noPrompt = await get(`/api/sessions/${sessionId}/prompts/9999`);
  if (noPrompt.status !== 404) fail(`unknown prompt: expected 404, got ${noPrompt.status}`);
  console.log("smoke ok: detail routes (steps, diff, 403, 404)");

  // Conditional requests: 200 with an ETag, then 304 (empty body, same ETag) for each data route; no token still 403.
  for (const p of ["/api/sessions", `/api/sessions/${sessionId}`, stepsPath, diffPath]) {
    const first = await get(p);
    const etag = first.headers.get("etag");
    if (first.status !== 200 || !/^"[0-9a-f]{16}"$/.test(etag ?? "")) fail(`GET ${p}: expected 200 with a strong ETag, got ${first.status} ${etag}`);
    if (first.headers.get("cache-control") !== "no-cache, private") fail(`GET ${p}: cache-control ${first.headers.get("cache-control")}`);
    await first.arrayBuffer();
    const cond = await fetch(`${url.origin}${p}`, { headers: { "X-Lgtm-Token": token, "If-None-Match": etag } });
    if (cond.status !== 304) fail(`GET ${p} with If-None-Match: expected 304, got ${cond.status}`);
    if (cond.headers.get("etag") !== etag) fail(`GET ${p}: 304 ETag ${cond.headers.get("etag")} != ${etag}`);
    if ((await cond.text()) !== "") fail(`GET ${p}: 304 has a body`);
    const denied304 = await fetch(`${url.origin}${p}`, { headers: { "If-None-Match": etag } });
    if (denied304.status !== 403 || denied304.headers.get("etag") !== null) fail(`GET ${p} with If-None-Match, no token: expected 403 without ETag, got ${denied304.status}`);
  }
  console.log("smoke ok: conditional requests (200 -> 304, same ETag)");

  // Bundled UI: index.html and a JS asset with the right Content-Type.
  const root = await fetch(`${url.origin}/`);
  if (root.status !== 200) fail(`GET /: expected 200, got ${root.status}`);
  if (!(root.headers.get("content-type") ?? "").startsWith("text/html")) fail(`GET /: content-type ${root.headers.get("content-type")}`);
  const html = await root.text();
  if (!/<html/i.test(html)) fail("GET /: body is not html");
  const asset = /(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/.exec(html);
  if (!asset) fail("GET /: no JS asset referenced in index.html");
  const js = await fetch(`${url.origin}/${asset[1]}`);
  if (js.status !== 200) fail(`GET /${asset[1]}: expected 200, got ${js.status}`);
  if (!/javascript/.test(js.headers.get("content-type") ?? "")) fail(`GET /${asset[1]}: content-type ${js.headers.get("content-type")}`);
  console.log(`smoke ok: UI served (/ and /${asset[1]})`);
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
