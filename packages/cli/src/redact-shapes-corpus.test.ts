import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { analyzeFileDetail } from "@lgtm/core/node";
import { buildExportInput } from "./export.js";
import { renderExport } from "./export-html.js";
import { formatSummary } from "./summary.js";

/**
 * The context x shape corpus of `packages/core/src/redact-corpus.test.ts`, run through the `--summary` and `--export`
 * renderings of one synthetic session: every line appears as a prompt, as a Bash command and in a failing result.
 * Secrets are assembled from fragments (fixture secret scan).
 */
const PROJECT = "/home/user/project";
const SID = "88888888-8888-4888-8888-888888888888";
const MIN_LEAK = 8;

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B64URL = ALNUM + "-_";
const UPPER_DIGIT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function body(n: number, seed: number, alphabet = ALNUM): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  let s = "";
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    s += alphabet[(x >>> 8) % alphabet.length];
  }
  return "7" + s.slice(1, n - 1) + "Q";
}

const SHAPES: string[] = [
  "AK" + "IA" + body(16, 1, UPPER_DIGIT),
  "gh" + "p_" + body(36, 2),
  "hvs" + "." + body(24, 3),
  "MTA4NjQ5ODc2NTQzMjEwOTg3Ng" + "." + "GxYz12" + "." + "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  "ey" + "J" + body(30, 4, B64URL) + "." + "ey" + "J" + body(50, 5, B64URL) + "." + body(43, 6, B64URL),
  body(20, 7),
  "$" + "uper$" + "ecret99",
];

const CONTEXTS: Array<(s: string) => string> = [
  (s) => `export API_TOKEN=${s}`,
  (s) => `password: ${s}`,
  (s) => `{"client_secret": "${s}"}`,
  (s) => `deploy --password ${s} --env prod`,
  (s) => `postgres://admin:${s}@db.internal:5432/app`,
  (s) => `X-Api-Key: ${s}`,
  (s) => `<password>${s}</password>`,
  (s) => `machine example.test login deploy password ${s}`,
  (s) => `'password' => '${s}',`,
  (s) => `config[:token] = { :token => "${s}" }`,
  (s) => `const t = process.env.API_TOKEN || "${s}";`,
  (s) => `token = getenv("API_TOKEN", "${s}")`,
  (s) => `password = os.environ.get("DB_PASSWORD", "${s}")`,
  (s) => `docker login -u deploy -p ${s} registry.example.test`,
  (s) => `redis-cli -h cache.internal -a ${s} ping`,
  (s) => `sshpass -p ${s} ssh host.internal`,
];

const LINES: Array<{ text: string; secret: string }> = CONTEXTS.flatMap((wrap) => SHAPES.map((secret) => ({ text: wrap(secret), secret })));

const rec = (type: string, n: number, message: unknown) =>
  JSON.stringify({
    type,
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    sessionId: SID,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 1000).toISOString(),
    cwd: PROJECT,
    gitBranch: "main",
    version: "2.1.0",
    message,
  });
const user = (n: number, content: unknown) => rec("user", n, { role: "user", content });
const use = (n: number, id: string, input: unknown) => rec("assistant", n, { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input }] });
const result = (n: number, id: string, content: string) => user(n, [{ type: "tool_result", tool_use_id: id, content, is_error: true }]);

function leaks(text: string, secret: string): string[] {
  const found: string[] = [];
  for (let n = MIN_LEAK; n <= secret.length; n++) if (text.includes(secret.slice(0, n))) found.push(secret.slice(0, n));
  return found;
}

let tmp = "";
let outputs: string[] = [];
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-redact-corpus-"));
  const lines: string[] = [];
  let n = 1;
  LINES.forEach(({ text }, i) => {
    lines.push(user(n++, `note ${i}: ${text}`));
    lines.push(use(n++, `t${i}`, { command: text }));
    lines.push(result(n++, `t${i}`, `Exit code 1\nFAIL ${text}`));
  });
  const file = join(tmp, "corpus.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  const { analysis, analyzer } = await analyzeFileDetail(file, { sessionId: SID, file: "corpus.jsonl" });
  const summary = formatSummary(analysis, { titles: true, root: PROJECT, usernames: [] });
  const { input } = buildExportInput(analysis, analyzer, { diffs: true });
  const html = renderExport(input, { titles: true, diffs: true, exportedAt: "2026-01-01", redact: { usernames: [], repoDir: PROJECT }, diffsCapped: false }).html;
  outputs = [summary, html];
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("redaction corpus through --summary and --export", () => {
  test("the session was analysed (the fixture reaches both outputs)", () => {
    expect(outputs[0]).toContain("note 0");
    expect(outputs[1]!.length).toBeGreaterThan(10_000);
    expect(outputs[1]).toContain("[redacted:");
  });

  test.each(LINES.map((l, i) => ({ i, ...l })))("no secret survives: line $i ($text)", ({ secret }) => {
    for (const out of outputs) expect(leaks(out, secret)).toEqual([]);
  });
});
