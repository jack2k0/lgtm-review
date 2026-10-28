import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { projectDirFor } from "@lgtm/core/node";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");

describe("title request shutdown", () => {
  test("SIGINT during a hung title request exits within 2s", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lgtm-llm-stop-"));
    const repo = join(tmp, "repo");
    const projects = join(tmp, "projects");
    const archive = join(tmp, "archive");
    const cache = join(tmp, "titles");
    const home = join(tmp, "home");
    mkdirSync(repo);
    mkdirSync(archive);
    mkdirSync(home);
    const projectDir = projectDirFor(repo, projects);
    mkdirSync(projectDir, { recursive: true });
    const sid = "00000000-0000-4000-8000-0000000000c1";
    const record = {
      type: "user",
      uuid: "00000000-0000-4000-8000-0000000000c2",
      parentUuid: null,
      sessionId: sid,
      timestamp: "2026-01-01T00:00:01.000Z",
      cwd: repo,
      gitBranch: "main",
      version: "2.1.0",
      message: { role: "user", content: "Fix the parser" },
    };
    writeFileSync(join(projectDir, `${sid}.jsonl`), `${JSON.stringify(record)}\n`);

    let hits = 0;
    let gotHit!: () => void;
    const hitOnce = new Promise<void>((resolve) => {
      gotHit = resolve;
    });
    const model = createServer((req, res) => {
      req.on("error", () => {});
      res.on("error", () => {});
      req.on("data", () => {});
      req.on("end", () => {
        hits += 1;
        if (hits === 1) gotHit();
      });
    });
    await new Promise<void>((resolve, reject) => {
      model.once("error", reject);
      model.listen(0, "127.0.0.1", () => {
        model.off("error", reject);
        resolve();
      });
    });
    const port = (model.address() as { port: number }).port;

    const child = spawn(
      "node",
      [
        cli,
        "--llm-url",
        `http://127.0.0.1:${port}/v1`,
        "--llm-model",
        "qwen3:4b",
        "--llm-cache-dir",
        cache,
        "--no-open",
        "--port",
        "0",
        "--no-worktrees",
        "--dir",
        repo,
        "--projects-dir",
        projects,
        "--archive-dir",
        archive,
      ],
      { env: { ...process.env, CI: "1", HOME: home } },
    );
    let stdout = "";
    let stderr = "";
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const kill = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          kill("SIGKILL");
          reject(new Error(`no URL\nstdout=${stdout}\nstderr=${stderr}`));
        }, 8000);
        const ready = () => {
          const match = /^(http:\/\/127\.0\.0\.1:\d+\/#k=[0-9a-f]{64})$/m.exec(stdout);
          if (!match) return;
          clearTimeout(timer);
          resolve(match[1]!);
        };
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          ready();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`exited ${code} before ready\nstdout=${stdout}\nstderr=${stderr}`));
        });
      });
      const page = new URL(url);
      const headers = { "X-Lgtm-Token": page.hash.slice(3) };
      const sessionRes = await fetch(`${page.origin}/api/sessions/${sid}`, { headers });
      expect(sessionRes.status).toBe(200);
      const session = (await sessionRes.json()) as { prompts: unknown[] };
      expect(session.prompts.length).toBeGreaterThan(0);
      const titlesRes = await fetch(`${page.origin}/api/sessions/${sid}/titles`, { headers });
      expect(titlesRes.status).toBe(200);
      await Promise.race([
        hitOnce,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`model was not asked\nstderr=${stderr}`)), 8000)),
      ]);
      expect(hits).toBeGreaterThan(0);

      const started = performance.now();
      kill("SIGINT");
      const outcome = await Promise.race([
        exited.then((code) => ({ kind: "exit" as const, code })),
        new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 2000)),
      ]);
      const ms = performance.now() - started;
      if (outcome.kind === "timeout") kill("SIGKILL");
      expect(outcome.kind).toBe("exit");
      expect(ms).toBeLessThan(2000);
      if (outcome.kind === "exit") expect(outcome.code).toBe(0);
    } finally {
      kill("SIGKILL");
      await exited.catch(() => {});
      await new Promise<void>((resolve) => {
        model.closeAllConnections();
        model.close(() => resolve());
      });
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});
