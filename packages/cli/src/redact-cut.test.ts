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
});
