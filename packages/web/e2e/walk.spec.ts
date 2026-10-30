import { test, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../../packages/cli/dist/cli.js", import.meta.url));

test.describe("E2E browser walkthrough", () => {
  let tmp: string;
  let repoDir: string;
  let projectsDir: string;
  let child: ChildProcess;
  let serverUrl: string;

  test.beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "lgtm-e2e-"));
    repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });

    // Initialize a git repo so git operations and branch resolution succeed
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "E2E Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: repoDir });

    const srcDir = join(repoDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const addFile = join(srcDir, "add.js");
    writeFileSync(addFile, "export const add = (a, b) => a - b;\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

    // Synthetic Claude Code session directory
    projectsDir = join(tmp, "projects");
    const projectName = repoDir.replace(/[/\\]+$/, "").replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = join(projectsDir, projectName);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "00000000-0000-4000-8000-000000000001";
    const xssPayload = "<img src=x onerror=alert(1)>";
    const sessionRecords = [
      {
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000001",
        parentUuid: null,
        sessionId,
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: repoDir,
        gitBranch: "main",
        version: "2.1.0",
        message: { role: "user", content: `Fix the add function ${xssPayload}` },
      },
      {
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000002",
        parentUuid: "00000000-0000-4000-8000-000000000001",
        sessionId,
        timestamp: "2026-01-01T00:00:02.000Z",
        cwd: repoDir,
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `Reading ${addFile}.` },
            { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: addFile } },
          ],
        },
      },
      {
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000003",
        parentUuid: "00000000-0000-4000-8000-000000000002",
        sessionId,
        timestamp: "2026-01-01T00:00:03.000Z",
        cwd: repoDir,
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "export const add = (a, b) => a - b;\n" }],
        },
      },
      {
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000004",
        parentUuid: "00000000-0000-4000-8000-000000000003",
        sessionId,
        timestamp: "2026-01-01T00:00:04.000Z",
        cwd: repoDir,
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `Editing ${addFile}.` },
            {
              type: "tool_use",
              id: "toolu_02",
              name: "Edit",
              input: { file_path: addFile, old_string: "a - b", new_string: "a + b" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000005",
        parentUuid: "00000000-0000-4000-8000-000000000004",
        sessionId,
        timestamp: "2026-01-01T00:00:05.000Z",
        cwd: repoDir,
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_02", content: "File updated." }],
        },
        toolUseResult: {
          type: "update",
          filePath: addFile,
          oldString: "a - b",
          newString: "a + b",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-export const add = (a, b) => a - b;", "+export const add = (a, b) => a + b;"],
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000006",
        parentUuid: "00000000-0000-4000-8000-000000000005",
        sessionId,
        timestamp: "2026-01-01T00:00:06.000Z",
        cwd: repoDir,
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running tests." },
            { type: "tool_use", id: "toolu_03", name: "Bash", input: { command: "pnpm test" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000007",
        parentUuid: "00000000-0000-4000-8000-000000000006",
        sessionId,
        timestamp: "2026-01-01T00:00:07.000Z",
        cwd: repoDir,
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_03", content: "Tests: 1 passed" }],
        },
      },
      {
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000008",
        parentUuid: "00000000-0000-4000-8000-000000000007",
        sessionId,
        timestamp: "2026-01-01T00:00:08.000Z",
        cwd: repoDir,
        gitBranch: "main",
        version: "2.1.0",
        message: { role: "assistant", content: [{ type: "text", text: "Fixed; tests pass." }] },
      },
    ];

    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      sessionRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

    // Start CLI
    child = spawn("node", [cliPath, "--no-open", "--dir", repoDir, "--projects-dir", projectsDir], {
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverUrl = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Timed out waiting for CLI URL. Output: ${out}`));
      }, 15000);

      child.stdout?.on("data", (chunk) => {
        out += chunk.toString();
        const m = /^(http:\/\/127\.0\.0\.1:\d+\/#k=[0-9a-f]{64})$/m.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });

      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`CLI exited prematurely with code ${code}. Output: ${out}`));
      });
    });
  });

  test.afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGINT");
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          resolve();
        }, 3000);
      });
    }
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("walks list, session, Steps, diff and Map with no console errors and no 390px scroll", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });

    const checkNoHorizontalScroll = async () => {
      await page.setViewportSize({ width: 390, height: 800 });
      // Give layout a tick to settle
      await page.waitForTimeout(50);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1280, height: 800 });
    };

    // 1. List view
    await page.goto(serverUrl);
    const sessionLink = page.getByRole("link", { name: /Fix the add function|00000000/ });
    await expect(sessionLink).toBeVisible();
    await checkNoHorizontalScroll();

    // 2. Session view
    await sessionLink.click();
    await expect(page.getByRole("heading", { level: 2 })).toContainText("Fix the add function");
    await checkNoHorizontalScroll();

    // Verify log text containing <img src=x onerror=...> shows as text and does not render <img>
    expect(await page.locator("img[src='x']").count()).toBe(0);
    await expect(page.locator("body")).toContainText("<img src=x onerror=alert(1)>");

    // 3. Steps view
    const stepsLink = page.getByRole("link", { name: /Steps of prompt 1|Steps/ }).first();
    await stepsLink.click();
    await expect(page.locator(".step, .steps").first()).toBeVisible();
    await checkNoHorizontalScroll();

    // 4. Diff view
    // Either click file link from Steps or navigate via hash
    const fileLink = page.getByRole("button", { name: /add\.js/ }).or(page.getByRole("link", { name: /add\.js/ })).first();
    if (await fileLink.isVisible()) {
      await fileLink.click();
    } else {
      // Find diff link in prompt table or navigate directly
      const hash = await page.evaluate(() => window.location.hash);
      const baseHash = hash.replace(/\/steps.*$/, "");
      await page.evaluate((h) => { window.location.hash = `${h}/diff?path=src%2Fadd.js`; }, baseHash);
    }
    await expect(page.locator(".diff, .diff-body").first()).toBeVisible();
    await checkNoHorizontalScroll();

    // 5. Map view
    // Navigate back: Diff -> Steps -> Session -> Map
    const backToSteps = page.getByRole("link", { name: /Back to steps/ }).first();
    await backToSteps.click();
    const backToSession = page.getByRole("link", { name: /Back to session/ }).first();
    await backToSession.click();
    const mapLink = page.getByRole("link", { name: "Map" }).first();
    await expect(mapLink).toBeVisible();
    await mapLink.click();
    await expect(page.locator(".import-map, svg").first()).toBeVisible();
    await checkNoHorizontalScroll();

    // No console or page errors throughout the walk
    expect(consoleErrors).toEqual([]);
  });
});
