import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { analyzeSession } from "@lgtm/core";
import type { Hint, PromptAnalysis, SessionAnalysis } from "@lgtm/core";
import { formatSummary, mdCode, mdText, redact, summaryReason, summaryTitle } from "./summary.js";

const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), "../../core/fixtures/sessions");
const fixtures = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort();
const ROOT = "/home/user/project";

function analyze(name: string): SessionAnalysis {
  const lines = readFileSync(join(sessionsDir, `${name}.jsonl`), "utf8").split("\n").filter((l) => l !== "");
  return analyzeSession(lines, { sessionId: `${name}-0000`, file: `${name}.jsonl` });
}

const prompt = (over: Partial<PromptAnalysis> = {}): PromptAnalysis => ({
  index: 0,
  uuid: "u",
  text: "fix the bug",
  status: "failing",
  reason: "pnpm test failed: SECRET-OUTPUT-LINE expected 1 got 2",
  files: [{ path: "/home/user/project/src/a.ts", kind: "M", added: 3, removed: 1, maybeIncomplete: false }],
  partial: false,
  timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
  activeMs: 0,
  headline: "No timing data",
  hints: [],
  recommendation: "read-flagged",
  ...over,
});
const session = (prompts: PromptAnalysis[], over: Partial<SessionAnalysis> = {}): SessionAnalysis => ({
  sessionId: "abcdef1234567890",
  title: "A title",
  branch: "feat/x",
  startedAt: "2026-03-04T10:00:00.000Z",
  prompts,
  warnings: [],
  ...over,
});
const hint = (over: Partial<Hint> = {}): Hint => ({ rule: "test-skipped", severity: "high", path: "/home/user/project/src/a.test.ts", reason: "COMMAND-OUTPUT-IN-REASON", ...over });

describe("golden summaries (byte-exact)", () => {
  test.each(fixtures)("%s", async (name) => {
    const md = formatSummary(analyze(name), { titles: true, root: ROOT });
    expect(md).toBe(formatSummary(analyze(name), { titles: true, root: ROOT }));
    await expect(md).toMatchFileSnapshot(join(sessionsDir, "__golden__", `${name}.summary.md`));
  });
  test("without titles: hints-test-edits", async () => {
    await expect(formatSummary(analyze("hints-test-edits"), { titles: false, root: ROOT })).toMatchFileSnapshot(join(sessionsDir, "__golden__", "hints-test-edits.summary-no-titles.md"));
  });
});

describe("summary content", () => {
  test("title, branch, date, session, table, attention section and heuristic footer", () => {
    const md = formatSummary(session([prompt({ hints: [hint()] }), prompt({ index: 1, status: "checked", reason: "pnpm test passed after last edit", recommendation: "skim" })]), { titles: true, root: ROOT });
    expect(md).toContain("# Review summary: A title");
    expect(md).toContain("Branch: `feat/x` · Date: 2026-03-04 · Session: `abcdef12`");
    expect(md).toContain("| 1 | failing | Read flagged | fix the bug | 1 | +3 -1 |");
    expect(md).toContain("| 2 | checked | Skim | fix the bug | 1 | +3 -1 |");
    expect(md).toContain("### Prompt 1: fix the bug");
    expect(md).toContain("- Status: failing (pnpm test failed)");
    expect(md).toContain("- **high** `test-skipped`: `src/a.test.ts`");
    expect(md).not.toContain("### Prompt 2");
    expect(md).toMatch(/heuristic/);
    expect(md.endsWith("\n")).toBe(true);
  });
  test("never contains command output, hint reasons or excerpts", () => {
    const md = formatSummary(session([prompt({ hints: [hint()] })]), { titles: true, root: ROOT });
    expect(md).not.toContain("SECRET-OUTPUT-LINE");
    expect(md).not.toContain("COMMAND-OUTPUT-IN-REASON");
    expect(md.toLowerCase()).not.toContain("excerpt");
    for (const name of fixtures) {
      const out = formatSummary(analyze(name), { titles: true, root: ROOT });
      expect(out.toLowerCase(), name).not.toContain("excerpt");
      expect(out, name).not.toContain("Tests: 1 failed");
    }
  });
  test("failing reason keeps only the command", () => {
    expect(summaryReason({ status: "failing", reason: "pnpm test failed (exit 2)" })).toBe("pnpm test failed");
    expect(summaryReason({ status: "failing", reason: "pnpm test failed: Tests: 1 failed" })).toBe("pnpm test failed");
    expect(summaryReason({ status: "failing", reason: "weird" })).toBe("check failed");
    expect(summaryReason({ status: "unchecked", reason: "2 edits after last check" })).toBe("2 edits after last check");
  });
  test("paths under the repo dir are relative, others stay as they are; prompt-level hints say so", () => {
    const md = formatSummary(session([prompt({ hints: [hint({ path: "/elsewhere/x.ts" }), hint({ rule: "large-change", path: null, severity: "info" })] })]), { titles: true, root: ROOT });
    expect(md).toContain("`/elsewhere/x.ts`");
    expect(md).toContain("`large-change`: (whole prompt)");
  });
  test("a session without prompts", () => {
    const md = formatSummary(session([]), { titles: true });
    expect(md).toContain("This session has no prompts.");
    expect(md).not.toContain("| # |");
  });
  test("no-changes prompts without hints are in the table only", () => {
    const md = formatSummary(session([prompt({ status: "no-changes", reason: "no edits", files: [], recommendation: "skim" })]), { titles: true });
    expect(md).not.toContain("Needs attention");
  });
});

describe("redaction (D5)", () => {
  const secrets = [
    "sk-ant-api03-abcdefghijklmnop",
    "sk-proj1234567890abcdef",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghij_klmnop",
    "AKIAIOSFODNN7EXAMPLE",
    "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "password=hunter2",
    "token: abc123",
    "0123456789abcdef0123456789abcdef0123",
    "dGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZyE=",
  ];
  test.each(secrets)("redacts %s", (secret) => {
    const out = redact(`use ${secret} here`);
    expect(out).toContain("redacted");
    expect(out).not.toContain(secret.replace(/^(Bearer |password=|token: )/i, ""));
    expect(out.startsWith("use ")).toBe(true);
    expect(out.endsWith(" here") || out.endsWith("[redacted]")).toBe(true);
  });
  test("normal prose and short words stay", () => {
    expect(redact("Fix the add function so it adds 2 numbers in src/add.ts")).toBe("Fix the add function so it adds 2 numbers in src/add.ts");
  });
  test("redaction happens in session title, prompt title and table before cutting to 80 chars", () => {
    const text = `${"x ".repeat(35)}sk-ant-api03-SECRETSECRETSECRET`;
    const md = formatSummary(session([prompt({ text: `deploy with sk-ant-api03-SECRETSECRET1234 now`, hints: [hint()] })], { title: "use ghp_SECRETSECRETSECRET12 please" }), { titles: true });
    expect(md).not.toMatch(/SECRET/);
    expect(md).toContain("redacted");
    expect(summaryTitle(text, 0, true)).not.toContain("SECRET");
  });
  test("a failing command label is redacted too", () => {
    expect(summaryReason({ status: "failing", reason: "curl -H 'Authorization: Bearer abc.def' failed: 401" })).not.toContain("abc.def");
  });
  test("a link smuggled in after a secret stays inert", () => {
    expect(summaryTitle("sk-ant-api03-abcdefgh](http://evil.example/x)", 0, true)).not.toMatch(/(?<!\\)\]\(/);
  });
});

describe("--no-titles", () => {
  test("no prompt text or session title anywhere", () => {
    const md = formatSummary(session([prompt({ text: "TOP-SECRET-PROMPT-TEXT", hints: [hint()] })], { title: "TOP-SECRET-SESSION-TITLE" }), { titles: false, root: ROOT });
    expect(md).not.toContain("TOP-SECRET");
    expect(md).toContain("# Review summary\n");
    expect(md).toContain("| 1 | failing | Read flagged | Prompt 1 | 1 | +3 -1 |");
    expect(md).toContain("### Prompt 1\n");
  });
});

describe("markdown escaping", () => {
  test("titles: pipes, backticks, newlines, emphasis, links and HTML cannot break the table", () => {
    const evil = "a | b `c`\nnext *bold* _it_ [x](http://e) <img src=x onerror=1> ~~s~~";
    const md = formatSummary(session([prompt({ text: evil })]), { titles: true });
    const row = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
    expect(row.split(/(?<!\\)\|/).length).toBe(8);
    expect(row).toContain("a \\| b \\`c\\` next");
    expect(row).toContain("\\*bold\\*");
    expect(row).toContain("\\[x\\]");
    expect(row).toContain("\\<img");
    expect(row).not.toMatch(/(?<!\\)</);
    expect(row).not.toContain("\n");
    expect(mdText("a\r\nb c")).toBe("a b c");
  });
  test("paths: code spans survive backticks, pipes and newlines", () => {
    expect(mdCode("src/a.ts")).toBe("`src/a.ts`");
    expect(mdCode("we`ird|name\nx")).toBe("``we`ird\\|name x``");
    expect(mdCode("`edge`")).toBe("`` `edge` ``");
    const md = formatSummary(session([prompt({ hints: [hint({ path: "/home/user/project/we`ird|x\ny.ts" })] })]), { titles: true, root: ROOT });
    const line = md.split("\n").find((l) => l.startsWith("- **high**"))!;
    expect(line).toBe("- **high** `test-skipped`: ``we`ird\\|x y.ts``");
  });
  test("a long title is cut to 80 characters", () => {
    const t = summaryTitle("word ".repeat(40), 0, true);
    expect([...t.replace(/\\/g, "")].length).toBeLessThanOrEqual(80);
    expect(t.endsWith("…")).toBe(true);
  });
  test("an empty prompt falls back to Prompt N", () => {
    expect(summaryTitle("   ", 3, true)).toBe("Prompt 4");
  });
});
