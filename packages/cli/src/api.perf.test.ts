import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FileDiff, PromptDetail } from "@lgtm/core";
import { startServer, type RunningServer } from "./server.js";

// A synthetic ~20 MB session (thousands of prompts, each with an edit that carries a large `originalFile`
// and a test run with long output) served through the real HTTP stack.

const PROJECT = "/home/user/project";
let tmp: string;
let srv: RunningServer;
let fileMB = 0;
let prompts = 0;

let seq = 0;
function rec(type: string, extra: Record<string, unknown>): string {
  seq++;
  return JSON.stringify({
    type,
    uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    sessionId: "00000000-0000-4000-8000-000000000001",
    timestamp: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
    cwd: PROJECT,
    gitBranch: "main",
    ...extra,
  });
}
const use = (id: string, name: string, input: Record<string, unknown>) =>
  rec("assistant", { message: { role: "assistant", content: [{ type: "text", text: `working on ${id}` }, { type: "tool_use", id, name, input }] } });
const result = (id: string, content: string, extra: Record<string, unknown> = {}, isError = false) =>
  rec("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...extra });

function buildSession(minBytes: number): string {
  const originalFile = "const filler = 1;\n".repeat(300); // ~5 KB per edit
  const output = "y".repeat(2000);
  const chunks: string[] = [];
  let size = 0;
  let n = 0;
  while (size < minBytes) {
    const file = `${PROJECT}/src/f${n % 50}.ts`;
    const lines = Array.from({ length: 12 }, (_, i) => `+line ${n} ${i}`);
    const batch = [
      rec("user", { message: { role: "user", content: `task ${n}` } }),
      use(`e${n}`, "Edit", { file_path: file, old_string: "a", new_string: "b" }),
      result(`e${n}`, "File updated.", {
        toolUseResult: { type: "update", originalFile, structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 12, lines }] },
      }),
      use(`b${n}`, "Bash", { command: "pnpm test" }),
      n % 3 === 0 ? result(`b${n}`, `Exit code 1\n${output}`, {}, true) : result(`b${n}`, output, { toolUseResult: { stdout: output, stderr: "", interrupted: false } }),
    ];
    const s = batch.join("\n") + "\n";
    chunks.push(s);
    size += s.length;
    n++;
  }
  prompts = n;
  // One prompt that writes a huge new file (diff cap) and a long run of reads.
  const big = Array.from({ length: 6000 }, (_, i) => `row ${i}`).join("\n");
  chunks.push(
    [
      rec("user", { message: { role: "user", content: "write big file" } }),
      use("w1", "Write", { file_path: `${PROJECT}/data/big.txt`, content: big }),
      result("w1", "created", { toolUseResult: { type: "create", content: big } }),
    ].join("\n") + "\n",
  );
  prompts++;
  fileMB = size / 1048576;
  return chunks.join("");
}

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: srv.port, path, headers: { Host: `127.0.0.1:${srv.port}`, "X-Lgtm-Token": srv.token } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    })
      .on("error", reject)
      .end();
  });
}

/** `gc()` when the runtime exposes it (or can be made to); otherwise null. */
function gcFn(): (() => void) | null {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g === "function") return g;
  try {
    setFlagsFromString("--expose-gc");
    const f = runInNewContext("gc") as unknown;
    return typeof f === "function" ? (f as () => void) : null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-api-perf-"));
  const pdir = join(tmp, "projects", "-home-user-project");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "big.jsonl"), buildSession(20 * 1024 * 1024));
  srv = await startServer({ dir: PROJECT, projectsDir: join(tmp, "projects"), webRoot: join(tmp, "no-web") });
}, 60_000);
afterAll(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("detail API on a ~20 MB session", () => {
  test("first detail request is fast; memory stays bounded after detail + 3 diffs", async () => {
    const gc = gcFn();
    gc?.();
    const before = process.memoryUsage().heapUsed;

    const t0 = performance.now();
    const r = await get("/api/sessions/big/prompts/0");
    const ms = performance.now() - t0;
    console.log(`detail of ${fileMB.toFixed(1)} MB session (${prompts} prompts): ${Math.round(ms)} ms`);
    expect(r.status).toBe(200);
    const d = PromptDetail.parse(JSON.parse(r.body));
    expect(d.steps.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(process.env.CI ? 6000 : 3000);

    // 3 diffs: a regular edited file, the huge created file, and a repeat (cache hit)
    const regular = await get(`/api/sessions/big/prompts/0/diff?path=${encodeURIComponent(`${PROJECT}/src/f0.ts`)}`);
    expect(regular.status).toBe(200);
    expect(FileDiff.parse(JSON.parse(regular.body)).hunks.length).toBeGreaterThan(0);
    const huge = await get(`/api/sessions/big/prompts/${prompts - 1}/diff?path=${encodeURIComponent(`${PROJECT}/data/big.txt`)}`);
    expect(huge.status).toBe(200);
    const hd = FileDiff.parse(JSON.parse(huge.body));
    expect(hd.truncated).toBe(true);
    expect(hd.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThanOrEqual(2000);
    expect((await get(`/api/sessions/big/prompts/0/diff?path=${encodeURIComponent(`${PROJECT}/src/f0.ts`)}`)).status).toBe(200);

    gc?.();
    const deltaMB = (process.memoryUsage().heapUsed - before) / 1048576;
    console.log(`heapUsed delta after detail + 3 diffs: ${deltaMB.toFixed(1)} MB (gc ${gc ? "forced" : "unavailable"})`);
    expect(deltaMB).toBeLessThan(gc ? 150 : 300);
  }, 60_000);
});
