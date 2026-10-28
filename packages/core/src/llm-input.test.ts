import { describe, expect, test } from "vitest";
import type { PromptAnalysis, PromptDetail, Step } from "./schema.js";
import { LlmTitlesResponse, TITLE_PROMPT_VERSION, TITLE_SYSTEM_PROMPT, condenseForTitle, sanitizeTitle, titleRequestBody } from "./index.js";

const KEY = "sk-ant-api03-ABCDEF0123";
const BEARER = "abcd1234abcd1234";

function file(path: string): PromptAnalysis["files"][number] {
  return { path, kind: "M", added: 1, removed: 0, maybeIncomplete: false };
}

function analysis(over: Partial<PromptAnalysis> & Pick<PromptAnalysis, "text" | "files">): PromptAnalysis {
  return {
    index: 0,
    uuid: "u",
    status: "checked",
    reason: "REASON_LEAK",
    partial: false,
    timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
    activeMs: 0,
    headline: "HEADLINE_LEAK",
    hints: [],
    recommendation: "skim",
    ...over,
  };
}

function step(title: string, extra?: Partial<Step>): Step {
  return {
    n: 1,
    phase: "write",
    title,
    startedAt: null,
    durationMs: 0,
    quotes: ["QUOTE_LEAK"],
    actions: [{ tool: "Bash", summary: "ACTION_LEAK", ok: true, ts: null }],
    files: ["ONLY_IN_STEP_FILES.ts"],
    check: { command: "pnpm test", exitCode: 1, passed: false, excerpt: "EXCERPT_LEAK" },
    ...extra,
  };
}

function detail(prompt: PromptAnalysis, steps: Step[]): PromptDetail {
  return {
    index: prompt.index,
    text: prompt.text,
    status: prompt.status,
    reason: prompt.reason,
    headline: prompt.headline,
    startedAt: null,
    activeMs: prompt.activeMs,
    truncated: false,
    hints: prompt.hints,
    recommendation: prompt.recommendation,
    steps,
  };
}

describe("LlmTitlesResponse", () => {
  test("accepts a disabled body and a body with titles", () => {
    expect(LlmTitlesResponse.parse({ enabled: false, titles: {}, pending: 0, error: null })).toEqual({
      enabled: false,
      titles: {},
      pending: 0,
      error: null,
    });
    const body = LlmTitlesResponse.parse({
      enabled: true,
      titles: { "0": "Added a parser", "2": "Fixed the test" },
      pending: 1,
      error: "model server not reachable",
    });
    expect(body.titles["0"]).toBe("Added a parser");
    expect(body.pending).toBe(1);
  });

  test("rejects a negative pending count", () => {
    expect(LlmTitlesResponse.safeParse({ enabled: false, titles: {}, pending: -1, error: null }).success).toBe(false);
    expect(LlmTitlesResponse.safeParse({ enabled: false, titles: {}, pending: 1.5, error: null }).success).toBe(false);
  });
});

describe("titleRequestBody", () => {
  test("is the fixed OpenAI chat body", () => {
    expect(TITLE_PROMPT_VERSION).toBe("1");
    expect(TITLE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(titleRequestBody("qwen3:4b", "Fix the login\nsrc/a.ts")).toEqual({
      model: "qwen3:4b",
      messages: [
        { role: "system", content: TITLE_SYSTEM_PROMPT },
        { role: "user", content: "Fix the login\nsrc/a.ts" },
      ],
      temperature: 0,
      max_tokens: 60,
      stream: false,
    });
  });
});

describe("condenseForTitle", () => {
  const root = "/srv/app";

  test("prompt text, step titles and repo-relative files, in that order", () => {
    const prompt = analysis({
      text: "Fix the login",
      files: [file(`${root}/src/login.ts`), file(`${root}/src/auth.ts`)],
    });
    const out = condenseForTitle(prompt, detail(prompt, [step("Read src/login.ts"), step("Run pnpm test -> passed")]), root);
    expect(out).toBe(["Fix the login", "Read src/login.ts", "Run pnpm test -> passed", "src/login.ts", "src/auth.ts"].join("\n"));
    expect(out).not.toContain("QUOTE_LEAK");
    expect(out).not.toContain("ACTION_LEAK");
    expect(out).not.toContain("EXCERPT_LEAK");
    expect(out).not.toContain("ONLY_IN_STEP_FILES");
    expect(out).not.toContain("REASON_LEAK");
    expect(out).not.toContain("HEADLINE_LEAK");
    expect(out).not.toContain(root);
  });

  test("is deterministic for the same input", () => {
    const prompt = analysis({ text: "Fix the login", files: [file("src/a.ts")] });
    const d = detail(prompt, [step("Read src/a.ts")]);
    expect(condenseForTitle(prompt, d, { repoDir: root, usernames: ["alice"] })).toBe(condenseForTitle(prompt, d, { repoDir: root, usernames: ["alice"] }));
  });

  test("redacts an sk-ant key and a bearer token in text, step titles and file paths", () => {
    const prompt = analysis({
      text: `alice rotated ${KEY} in the client`,
      files: [file(`${root}/secrets/${KEY}.txt`), file(`${root}/src/ok.ts`)],
    });
    const d = detail(prompt, [step(`Call the API with Bearer ${BEARER} now`)]);
    const out = condenseForTitle(prompt, d, { repoDir: root, usernames: ["alice"] });
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("sk-ant-");
    expect(out).not.toContain(BEARER);
    expect(out).toContain("[redacted:anthropic-key]");
    expect(out).toContain("[redacted:bearer]");
    expect(out).toContain("<user>");
    expect(out).not.toContain("alice");
    expect(out).toContain("src/ok.ts");
    expect(out).not.toContain(root);
  });

  test("makes file paths repo-relative and never emits an absolute path", () => {
    const prompt = analysis({
      text: `Edit ${root}/README.md`,
      files: [
        file(`${root}/src/a.ts`),
        file(`${root}-other/secret.ts`),
        file("/tmp/outside/secret.txt"),
        file("../escape.ts"),
        file("C:\\tmp\\outside.ts"),
        file(`${root}/src/b.ts`),
        file("rel/c.ts"),
        file("C:\\srv\\app\\src\\d.ts"),
      ],
    });
    const d = detail(prompt, [step(`Open ${root}/lib/e.ts`)]);
    const out = condenseForTitle(prompt, d, { repoDir: root, usernames: ["alice"] });
    expect(out.split("\n")).toEqual(["Edit <repo>/README.md", "Open <repo>/lib/e.ts", "src/a.ts", "src/b.ts", "rel/c.ts"]);
    expect(out).not.toContain(root);
    expect(out).not.toContain("/tmp/");
    expect(out).not.toContain("escape.ts");
    expect(out).not.toContain("outside");
    expect(out).not.toMatch(/(^|\s)\/[A-Za-z0-9]/);
    expect(out).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  test("a string root is the repository directory", () => {
    const prompt = analysis({ text: "Fix it", files: [file(`${root}/src/a.ts`)] });
    expect(condenseForTitle(prompt, null, root)).toBe("Fix it\nsrc/a.ts");
  });

  test("windows paths under the repo root become forward-slash relative", () => {
    const prompt = analysis({ text: "Fix it", files: [file("C:\\srv\\app\\src\\d.ts")] });
    expect(condenseForTitle(prompt, null, { repoDir: "C:\\srv\\app" })).toBe("Fix it\nsrc/d.ts");
  });

  test("caps step titles at 25 and changed files at 20", () => {
    const steps = Array.from({ length: 30 }, (_, i) => step(`title-${String(i).padStart(2, "0")}`));
    const files = Array.from({ length: 25 }, (_, i) => file(`rel/f${String(i).padStart(2, "0")}.ts`));
    const prompt = analysis({ text: "Prompt line", files });
    const out = condenseForTitle(prompt, detail(prompt, steps), root);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Prompt line");
    expect(lines).toContain("title-00");
    expect(lines).toContain("title-24");
    expect(lines).not.toContain("title-25");
    expect(lines).not.toContain("title-29");
    expect(lines).toContain("rel/f00.ts");
    expect(lines).toContain("rel/f19.ts");
    expect(lines).not.toContain("rel/f20.ts");
    expect(lines).not.toContain("rel/f24.ts");
  });

  test("skipped absolute paths do not consume the 20 file slots", () => {
    const files = [file("/tmp/outside.txt"), file(`${root}/src/kept.ts`)];
    const prompt = analysis({ text: "Fix it", files });
    expect(condenseForTitle(prompt, null, root)).toBe("Fix it\nsrc/kept.ts");
  });

  test("cuts at 2000 characters on a newline and drops a partial last line", () => {
    const line = "n".repeat(100);
    const steps = Array.from({ length: 25 }, (_, i) => step(`${line}${String(i).padStart(2, "0")}`));
    const prompt = analysis({ text: "T".repeat(80), files: [] });
    const out = condenseForTitle(prompt, detail(prompt, steps), root);
    const full = [prompt.text, ...steps.map((s) => s.title)].join("\n");
    expect(full.length).toBeGreaterThan(2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.length).toBeGreaterThan(0);
    expect(full.startsWith(out)).toBe(true);
    expect(full.slice(out.length).startsWith("\n")).toBe(true);
    expect(out.split("\n").every((l) => full.split("\n").includes(l))).toBe(true);
  });

  test("a single line longer than 2000 characters is dropped", () => {
    const prompt = analysis({ text: "a".repeat(2500), files: [] });
    expect(condenseForTitle(prompt, null, root)).toBe("");
  });

  test("null detail sends no step titles", () => {
    const prompt = analysis({ text: "Only the prompt", files: [file("src/a.ts")] });
    expect(condenseForTitle(prompt, null)).toBe("Only the prompt\nsrc/a.ts");
  });
});

describe("sanitizeTitle", () => {
  test("drops a think block and keeps the title after it", () => {
    expect(sanitizeTitle("<think>\nsecret plan\n</think>\n\nShipped the parser")).toBe("Shipped the parser");
    expect(sanitizeTitle("<THINK>hidden</THINK>\nDid the work")).toBe("Did the work");
    expect(sanitizeTitle("before <think>hidden</think> after")).toBe("before after");
  });

  test("an unterminated think block is not a title", () => {
    expect(sanitizeTitle("<think>\nLet me think about the user's request to fix")).toBeNull();
    expect(sanitizeTitle("<think>Okay, the user wants")).toBeNull();
    expect(sanitizeTitle("<THINK>still thinking")).toBeNull();
    expect(sanitizeTitle('<think class="x">reason')).toBeNull();
    expect(sanitizeTitle("<think>hidden</think>\n<think>still open")).toBeNull();
    expect(sanitizeTitle("<think")).toBeNull();
    expect(sanitizeTitle("Title: <think leftover")).toBeNull();
    expect(sanitizeTitle("**<think** leftover")).toBeNull();
    expect(sanitizeTitle("Shipped the parser\n<think more")).toBeNull();
  });

  test("strips surrounding quotes", () => {
    expect(sanitizeTitle('"Shipped the parser"')).toBe("Shipped the parser");
    expect(sanitizeTitle("'Shipped the parser'")).toBe("Shipped the parser");
    expect(sanitizeTitle("\u201cShipped the parser\u201d")).toBe("Shipped the parser");
  });

  test("strips a Title: prefix, headings and list markers", () => {
    expect(sanitizeTitle("Title: Shipped the parser")).toBe("Shipped the parser");
    expect(sanitizeTitle("title: Shipped the parser")).toBe("Shipped the parser");
    expect(sanitizeTitle("# Shipped the parser")).toBe("Shipped the parser");
    expect(sanitizeTitle("## Shipped the parser")).toBe("Shipped the parser");
    expect(sanitizeTitle("* Shipped the parser")).toBe("Shipped the parser");
    expect(sanitizeTitle("- Shipped the parser")).toBe("Shipped the parser");
    expect(sanitizeTitle('"Title: **Shipped** the `parser`"')).toBe("Shipped the parser");
  });

  test("strips markdown emphasis and backticks and keeps snake_case", () => {
    expect(sanitizeTitle("**Shipped** the `parser`")).toBe("Shipped the parser");
    expect(sanitizeTitle("*Shipped* the parser")).toBe("Shipped the parser");
    expect(sanitizeTitle("Updated snake_case helpers")).toBe("Updated snake_case helpers");
  });

  test("uses the first non-empty line", () => {
    expect(sanitizeTitle("\n\nFirst real line\nSecond line stays out")).toBe("First real line");
  });

  test("removes control characters and collapses whitespace", () => {
    expect(sanitizeTitle("Added\u0000 the parser")).toBe("Added the parser");
    expect(sanitizeTitle("Added \u0007 parser")).toBe("Added parser");
    expect(sanitizeTitle("Added\t\tthe   parser")).toBe("Added the parser");
  });

  test("cuts past 120 characters on a word boundary", () => {
    const raw = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const out = sanitizeTitle(raw);
    expect(out).not.toBeNull();
    expect([...(out ?? "")].length).toBeLessThanOrEqual(120);
    expect(out!.endsWith("…")).toBe(true);
    const body = out!.slice(0, -1);
    expect(raw.startsWith(body)).toBe(true);
    expect(raw[body.length]).toBe(" ");
    expect(body.endsWith(" ")).toBe(false);
    expect(sanitizeTitle("a".repeat(150))).toBe(`${"a".repeat(119)}…`);
  });

  test("a clean title is unchanged by a second pass", () => {
    const once = sanitizeTitle("Shipped the parser");
    expect(sanitizeTitle(once!)).toBe(once);
  });

  test("empty input is null", () => {
    for (const raw of ["", "   ", "\n\n", "<think>only</think>", "Title:", '""', "''", "```", "#", "-", "*"]) {
      expect(sanitizeTitle(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});
