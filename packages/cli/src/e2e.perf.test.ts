import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");

function startCli(args: string[]): Promise<{ url: string; stdout: () => string; kill: () => Promise<number | null> }> {
  const child = spawn("node", [cli, ...args], { env: { ...process.env, CI: "1" } });
  let out = "";
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no URL printed: ${out}`));
    }, 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /^(http:\/\/127\.0\.0\.1:\d+\/#k=[0-9a-f]{64})$/m.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({
          url: m[1]!,
          stdout: () => out,
          kill: () => {
            child.kill("SIGINT");
            return exited;
          },
        });
      }
    });
    child.on("exit", () => clearTimeout(timer));
  });
}

describe("e2e performance", () => {
  test("20 MB synthetic session through the HTTP API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lgtm-cli-perf-"));
    const pdir = join(dir, "projects", "-home-user-perf");
    mkdirSync(pdir, { recursive: true });
    const sid = "00000000-0000-4000-8000-0000000000aa";
    const base = { sessionId: sid, cwd: "/home/user/perf", gitBranch: "main", version: "2.1.0" };
    const blob = "x".repeat(100_000);
    const lines: string[] = [];
    let n = 0;
    let prev: string | null = null;
    const push = (type: string, message: unknown) => {
      const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      const ts = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
      lines.push(JSON.stringify({ type, uuid, parentUuid: prev, timestamp: ts, ...base, message }));
      prev = uuid;
    };
    for (let i = 0; i < 200; i++) {
      push("user", { role: "user", content: `Prompt number ${i}: do something` });
      push("assistant", { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: "/home/user/perf/a.js" } }] });
      push("user", { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: blob }] });
    }
    writeFileSync(join(pdir, `${sid}.jsonl`), lines.join("\n") + "\n");
    const h = await startCli(["--no-open", "--port", "0", "--projects-dir", join(dir, "projects"), "--dir", "/home/user/perf"]);
    try {
      const u = new URL(h.url);
      const headers = { "X-Lgtm-Token": u.hash.slice(3) };
      const t0 = performance.now();
      const list = (await (await fetch(`${u.origin}/api/sessions`, { headers })).json()) as { sessions: { id: string; promptCount: number }[] };
      const detail = await fetch(`${u.origin}/api/sessions/${sid}`, { headers });
      expect(detail.status).toBe(200);
      await detail.json();
      const ms = performance.now() - t0;
      console.log(`perf: ${(lines.join("\n").length / 1e6).toFixed(1)} MB session, list+detail ${ms.toFixed(0)} ms`);
      expect(list.sessions.length).toBe(1);
      expect(list.sessions[0]!.promptCount).toBeGreaterThan(0);
      expect(ms).toBeLessThan(process.env.CI ? 6000 : 3000);
    } finally {
      await h.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
