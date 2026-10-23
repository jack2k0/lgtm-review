import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { analyzeFile, analyzeFileDetail, SUBAGENT_FILES_MAX } from "@lgtm/core/node";

// 100 subagent transcripts of ~1 MB each (tool calls, edits, checks, long outputs) behind one prompt with 100 `Agent` calls.

const PROJECT = "/home/user/project";
const FILE_BYTES = 1024 * 1024;
let tmp: string;
let session: string;
let totalMB = 0;

const T0 = Date.UTC(2026, 0, 1);
const iso = (sec: number): string => new Date(T0 + Math.round(sec * 1000)).toISOString();
let seq = 0;
function rec(type: string, ts: number, extra: Record<string, unknown>): string {
  seq++;
  return JSON.stringify({ type, uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, sessionId: "s", timestamp: iso(ts), cwd: PROJECT, gitBranch: "main", ...extra });
}
const use = (ts: number, id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  rec("assistant", ts, { message: { role: "assistant", content: [{ type: "text", text: `working on ${id}` }, { type: "tool_use", id, name, input }] }, ...extra });
const result = (ts: number, id: string, content: string, extra: Record<string, unknown> = {}) =>
  rec("user", ts, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, ...extra });

function transcript(agent: number): string {
  const side = { isSidechain: true, agentId: `a${String(agent).padStart(4, "0")}` };
  const out: string[] = [rec("user", 1 + agent * 0.01, { ...side, parentUuid: null, message: { role: "user", content: "task" } })];
  const output = "y".repeat(400);
  let size = 0;
  for (let n = 0; size < FILE_BYTES; n++) {
    const t = 2 + agent * 0.01 + n * 0.001;
    const batch =
      n % 4 === 0
        ? [use(t, `b${agent}_${n}`, "Bash", { command: "pnpm test" }, side), result(t + 0.0005, `b${agent}_${n}`, output, { ...side, toolUseResult: { stdout: output, stderr: "", interrupted: false } })]
        : n % 4 === 1
          ? [use(t, `e${agent}_${n}`, "Edit", { file_path: `${PROJECT}/src/f${n % 50}.ts`, old_string: "a", new_string: "b" }, side), result(t + 0.0005, `e${agent}_${n}`, "File updated.", { ...side, toolUseResult: { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] } })]
          : [use(t, `r${agent}_${n}`, "Read", { file_path: `${PROJECT}/src/f${n % 50}.ts` }, side), result(t + 0.0005, `r${agent}_${n}`, output, side)];
    for (const l of batch) {
      out.push(l);
      size += l.length + 1;
    }
  }
  return out.join("\n") + "\n";
}

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

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-sub-perf-"));
  session = join(tmp, "big.jsonl");
  const dir = join(tmp, "big", "subagents");
  mkdirSync(dir, { recursive: true });
  const parent: string[] = [rec("user", 0, { message: { role: "user", content: "do everything with agents" } })];
  for (let i = 0; i < SUBAGENT_FILES_MAX; i++) {
    parent.push(use(0.5 + i * 0.001, `toolu_${i}`, "Agent", { description: `agent ${i}`, prompt: "x" }));
    const id = `a${String(i).padStart(4, "0")}`;
    const body = transcript(i);
    totalMB += body.length / 1048576;
    writeFileSync(join(dir, `agent-${id}.jsonl`), body);
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: `agent ${i}`, toolUseId: `toolu_${i}`, spawnDepth: 1, model: "synthetic" }));
  }
  for (let i = 0; i < SUBAGENT_FILES_MAX; i++) parent.push(result(5000 + i, `toolu_${i}`, "done"));
  writeFileSync(session, parent.join("\n") + "\n");
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("100 subagent files of ~1 MB", () => {
  test("analyzeFile / analyzeFileDetail stay fast and bounded in memory", async () => {
    const gc = gcFn();
    gc?.();
    const before = process.memoryUsage().heapUsed;

    const t0 = performance.now();
    const analysis = await analyzeFile(session, { sessionId: "big", file: "big.jsonl" });
    const listMs = performance.now() - t0;
    gc?.();
    const listMB = (process.memoryUsage().heapUsed - before) / 1048576;
    console.log(`analyzeFile: ${SUBAGENT_FILES_MAX} subagent files, ${totalMB.toFixed(0)} MB: ${Math.round(listMs)} ms, retained heap delta ${listMB.toFixed(1)} MB (gc ${gc ? "forced" : "unavailable"})`);

    expect(analysis.prompts).toHaveLength(1);
    expect(analysis.prompts[0]?.files.length).toBeGreaterThan(0);
    expect(analysis.prompts[0]?.reason).toContain("subagent transcript truncated (event cap)"); // 100 x ~3,000 events > 20,000 merged
    expect(analysis.prompts[0]?.partial).toBe(false);
    expect(listMs).toBeLessThan(process.env.CI ? 6000 : 3000);
    expect(listMB).toBeLessThan(gc ? 150 : 300);

    gc?.();
    const before2 = process.memoryUsage().heapUsed;
    const t1 = performance.now();
    const d = await analyzeFileDetail(session, { sessionId: "big", file: "big.jsonl" });
    const detailMs = performance.now() - t1;
    const steps = d.analyzer.details()[0]!.steps;
    gc?.();
    const detailMB = (process.memoryUsage().heapUsed - before2) / 1048576;
    console.log(`analyzeFileDetail: ${Math.round(detailMs)} ms, ${steps.length} steps, retained heap delta ${detailMB.toFixed(1)} MB (gc ${gc ? "forced" : "unavailable"})`);
    expect(JSON.stringify(d.analysis)).toBe(JSON.stringify(analysis));
    expect(detailMs).toBeLessThan(process.env.CI ? 6000 : 3000);
    expect(detailMB).toBeLessThan(gc ? 150 : 300);
  }, 120_000);
});
