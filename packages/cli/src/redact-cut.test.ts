import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { analyzeFileDetail } from "@lgtm/core/node";
import { buildExportInput } from "./export.js";
import { renderExport } from "./export-html.js";
import { formatSummary } from "./summary.js";

/**
 * A display cut must not leave a partial secret that redaction no longer recognises. Synthetic secrets only.
 * Each case slides a padding so that, for some padding, every cut of the log-derived text (session title, step
 * title and summary, check label, failure excerpt, tool-result head) lands inside the secret.
 */
const PROJECT = "/home/user/project";
const SID = "77777777-7777-4777-8777-777777777777";
const PASSWORD = "Hunter2SecretPw9";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const MIN_LEAK = 4;

const rec = (type: string, n: number, message: unknown) =>
  JSON.stringify({ type, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, sessionId: SID, timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`, cwd: PROJECT, gitBranch: "main", version: "2.1.0", message });

const user = (n: number, content: unknown) => rec("user", n, { role: "user", content });
const use = (n: number, id: string, name: string, input: unknown) => rec("assistant", n, { role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const result = (n: number, id: string, content: string, isError: boolean) => user(n, [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);

function urlSession(pad: number): string[] {
  const cmd = `psql ${"a".repeat(pad)} postgres://app:${PASSWORD}@db/x -c select`;
  return [
    user(1, `${"b".repeat(pad % 70)} ${cmd}`),
    use(2, "t1", "Bash", { command: cmd }),
    result(3, "t1", "ok", false),
    use(4, "t2", "Bash", { command: `pnpm test -- ${"c".repeat(pad)} postgres://app:${PASSWORD}@db/x` }),
    result(5, "t2", `Exit code 1\nFAIL ${"d".repeat(pad)} postgres://app:${PASSWORD}@db/x`, true),
  ];
}

function awsSession(pad: number): string[] {
  const out = `Exit code 1\n${"e".repeat(pad)} ${AWS_KEY} rejected`;
  return [
    user(1, "run the checks"),
    use(2, "t1", "Bash", { command: "pnpm test" }),
    result(3, "t1", out, true),
    use(4, "t2", "Bash", { command: "pnpm test" }),
    result(5, "t2", `${"f".repeat(pad)} ${AWS_KEY} rejected`, true),
  ];
}

let tmp = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-redact-cut-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** `--summary` and `--export` renderings of one synthetic session. */
async function render(name: string, lines: string[]): Promise<string[]> {
  const file = join(tmp, `${name}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  const { analysis, analyzer } = await analyzeFileDetail(file, { sessionId: SID, file: `${name}.jsonl` });
  const summary = formatSummary(analysis, { titles: true, root: PROJECT, usernames: [] });
  const { input } = buildExportInput(analysis, analyzer, { diffs: true });
  const html = renderExport(input, { titles: true, diffs: true, exportedAt: "2026-01-01", redact: { usernames: [], repoDir: PROJECT }, diffsCapped: false }).html;
  return [summary, html];
}

function leaks(text: string, secret: string): string[] {
  const found: string[] = [];
  for (let n = MIN_LEAK; n <= secret.length; n++) if (text.includes(secret.slice(0, n))) found.push(secret.slice(0, n));
  return found;
}

describe("display cuts leave no secret prefix", () => {
  test("a URL password cut by a title, summary or label limit", async () => {
    for (let pad = 0; pad <= 230; pad++) {
      for (const out of await render("url", urlSession(pad))) expect({ pad, leaks: leaks(out, PASSWORD) }).toEqual({ pad, leaks: [] });
    }
  });

  test("an AWS key cut by the failure excerpt or the tool-result head", async () => {
    for (let pad = 0; pad <= 230; pad++) {
      for (const out of await render("aws", awsSession(pad))) expect({ pad, leaks: leaks(out, AWS_KEY) }).toEqual({ pad, leaks: [] });
    }
  });

  test("--summary and the step label cut inside an AWS key leave no AKIAIOSF prefix", async () => {
    // No whitespace before the key, so a display cut cannot back up out of it. `!` is not a token
    // character, so the full key still redacts when the text is stored uncut.
    const promptText = `${"P".repeat(51)}!${AWS_KEY}`;
    const command = `pnpm test ${"Q".repeat(60)}!${AWS_KEY}`;
    const extra = (n: number, type: string, message: unknown, more: Record<string, unknown> = {}) =>
      JSON.stringify({
        type,
        uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        sessionId: SID,
        timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        cwd: PROJECT,
        gitBranch: "main",
        version: "2.1.0",
        message,
        ...more,
      });
    const lines = [
      user(1, promptText),
      extra(2, "assistant", { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: `${PROJECT}/src/a.ts`, content: "a\n" } }] }),
      extra(3, "user", { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] }, { toolUseResult: { type: "create", content: "a\n", structuredPatch: [] } }),
      use(4, "t1", "Bash", { command }),
      result(5, "t1", "Exit code 1\nfail", true),
    ];
    const file = join(tmp, "aws-cut.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    const { analysis, analyzer } = await analyzeFileDetail(file, { sessionId: SID, file: "aws-cut.jsonl" });
    const summary = formatSummary(analysis, { titles: true, root: PROJECT, usernames: [] });
    const steps = analyzer.details().flatMap((d) => d.steps.map((s) => s.title));
    expect(analysis.title).not.toContain("AKIAIOSF");
    expect(analysis.title.endsWith("!")).toBe(true);
    expect(steps.some((t) => t.includes("pnpm test"))).toBe(true);
    for (const out of [summary, ...steps]) expect(out).not.toContain("AKIAIOSF");
  });
});
