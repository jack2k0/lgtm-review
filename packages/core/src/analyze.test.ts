import { beforeEach, describe, expect, test } from "vitest";
import { analyzeSession, createAnalyzer } from "./analyze.js";
import { F, bash, edit, prompt, resetIds, toolResult, toolUse } from "./testing/records.js";

beforeEach(resetIds);

const one = (lines: string[], opts = {}) => {
  const a = analyzeSession(lines, opts);
  return a.prompts[0]!;
};

describe("status rule", () => {
  test("no edits => no-changes, even with a failing check", () => {
    expect(one([prompt("q"), ...bash("b1", "pnpm test", { exit: 1 })]).status).toBe("no-changes");
  });

  test("edit without any check => unchecked, no checks ran", () => {
    expect(one([prompt("q"), ...edit("e1")])).toMatchObject({ status: "unchecked", reason: "no checks ran" });
  });

  test("edit, passing check => checked", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test")])).toMatchObject({
      status: "checked",
      reason: "pnpm test passed after last edit",
    });
  });

  test("edit, failing check => failing with single-line output", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pytest -q", { exit: 1, output: "line one\n\nline   two" })]);
    expect(p).toMatchObject({ status: "failing", reason: "pytest -q failed: line one line two" });
  });

  test("failure output is cut to 200 chars", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pytest", { exit: 1, output: "z".repeat(400) })]);
    expect(p.reason).toBe(`pytest failed: ${"z".repeat(200)}`);
  });

  test("failed then passed => checked; passed then failed => failing", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test", { exit: 1 }), ...bash("b2", "pnpm test")]).status).toBe("checked");
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...bash("b2", "pnpm lint", { exit: 2 })]).status).toBe("failing");
  });

  test("edit after the last check => unchecked with count (also after a failed check)", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...edit("e2"), ...edit("e3")])).toMatchObject({
      status: "unchecked",
      reason: "2 edits after last check",
    });
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test", { exit: 1 }), ...edit("e2")])).toMatchObject({
      status: "unchecked",
      reason: "1 edit after last check",
    });
  });

  test("check before the edit does not count", () => {
    expect(one([prompt("q"), ...bash("b1", "pnpm test"), ...edit("e1")]).status).toBe("unchecked");
  });

  test("a check without a result did not complete", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test", { none: true })])).toMatchObject({
      status: "unchecked",
      reason: "check did not complete",
    });
  });

  test("a background check is not completed", () => {
    const lines = [
      prompt("q"),
      ...edit("e1"),
      toolUse("b1", "Bash", { command: "pnpm test", run_in_background: true }),
      toolResult("b1", "started", { toolUseResult: { backgroundTaskId: "bg" } }),
    ];
    expect(one(lines)).toMatchObject({ status: "unchecked", reason: "check did not complete" });
  });

  test("a tool error without exit code means the command did not run", () => {
    const lines = [
      prompt("q"),
      ...edit("e1"),
      toolUse("b1", "Bash", { command: "pnpm test" }),
      toolResult("b1", "<tool_use_error>Blocked</tool_use_error>", { isError: true }),
    ];
    expect(one(lines)).toMatchObject({ status: "unchecked", reason: "no checks ran" });
  });

  test("failed edits are not edits", () => {
    const lines = [
      prompt("q"),
      toolUse("e1", "Edit", { file_path: F }),
      toolResult("e1", "String to replace not found", { isError: true }),
    ];
    expect(one(lines)).toMatchObject({ status: "no-changes", files: [] });
  });

  test("unreliable passing check is flagged in the reason", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pytest | tail -5")]);
    expect(p.status).toBe("checked");
    expect(p.reason).toContain("may be masked");
  });

  test("results are paired by id, not by position", () => {
    const lines = [
      prompt("q"),
      ...edit("e1"),
      toolUse("b1", "Bash", { command: "ls" }),
      toolUse("b2", "Bash", { command: "pnpm test" }),
      toolResult("b2", "Exit code 1\nfail", { isError: true }),
      toolResult("b1", "files"),
    ];
    expect(one(lines).status).toBe("failing");
  });

  test("each prompt gets its own turn", () => {
    const a = analyzeSession([prompt("one"), ...edit("e1"), ...bash("b1", "pnpm test"), prompt("two"), ...edit("e2")]);
    expect(a.prompts.map((p) => p.status)).toEqual(["checked", "unchecked"]);
  });

  test("Agent tool marks the prompt partial", () => {
    const p = one([prompt("q"), toolUse("a1", "Agent", { prompt: "x" }), ...edit("e1")]);
    expect(p.partial).toBe(true);
    expect(p.reason).toBe("no checks ran; subagent activity not analysed");
  });

  test("repo scripts are honoured", () => {
    const lines = [prompt("q"), ...edit("e1"), ...bash("b1", "make ci")];
    expect(one(lines).status).toBe("unchecked");
    expect(one(lines, { repo: { packageScripts: [], makeTargets: ["ci"], scriptFiles: [] } }).status).toBe("checked");
  });
});

describe("files", () => {
  test("deltas are summed per file; sorted by path", () => {
    const p = one([prompt("q"), ...edit("e1", "/home/user/project/b.ts"), ...edit("e2", "/home/user/project/a.ts"), ...edit("e3", "/home/user/project/b.ts")]);
    expect(p.files.map((f) => [f.path, f.kind, f.added, f.removed])).toEqual([
      ["/home/user/project/a.ts", "M", 1, 1],
      ["/home/user/project/b.ts", "M", 2, 2],
    ]);
  });

  test("Write create => A with content line count", () => {
    const lines = [
      prompt("q"),
      toolUse("w1", "Write", { file_path: "/home/user/project/n.ts", content: "a\nb\nc" }),
      toolResult("w1", "created", { toolUseResult: { type: "create", content: "a\nb\nc", structuredPatch: [] } }),
    ];
    expect(one(lines).files).toEqual([{ path: "/home/user/project/n.ts", kind: "A", added: 3, removed: 0, maybeIncomplete: false }]);
  });

  test("Write without create type and without patch => maybeIncomplete (A7)", () => {
    const lines = [
      prompt("q"),
      toolUse("w1", "Write", { file_path: "/home/user/project/n.ts", content: "a\nb\n" }),
      toolResult("w1", "ok"),
    ];
    expect(one(lines).files).toEqual([{ path: "/home/user/project/n.ts", kind: "M", added: 2, removed: 0, maybeIncomplete: true }]);
  });

  test("Bash edits come only from bashEditDiff", () => {
    const lines = [
      prompt("q"),
      toolUse("b1", "Bash", { command: "sed -i s/a/b/ x.txt" }),
      toolResult("b1", "", {
        toolUseResult: { bashEditDiff: { files: [{ filePath: "/home/user/project/x.txt", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] }] } },
      }),
      ...bash("b2", "sed -i s/a/b/ y.txt"),
    ];
    const p = one(lines);
    expect(p.files.map((f) => f.path)).toEqual(["/home/user/project/x.txt"]);
    expect(p.status).toBe("unchecked");
  });

  test("NotebookEdit uses notebook_path and is flagged incomplete without a patch", () => {
    const lines = [prompt("q"), toolUse("n1", "NotebookEdit", { notebook_path: "/home/user/project/n.ipynb" }), toolResult("n1", "ok")];
    expect(one(lines).files).toEqual([{ path: "/home/user/project/n.ipynb", kind: "M", added: 0, removed: 0, maybeIncomplete: true }]);
  });
});

describe("session fields", () => {
  test("title, branch, startedAt, sessionId", () => {
    const a = analyzeSession([prompt("A\n  long   prompt " + "x".repeat(100))]);
    expect(a.title).toHaveLength(60);
    expect(a.title.startsWith("A long prompt")).toBe(true);
    expect(a.branch).toBe("main");
    expect(a.startedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(a.sessionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(analyzeSession([prompt("x")], { title: "T", sessionId: "S" })).toMatchObject({ title: "T", sessionId: "S" });
  });

  test("unknown branch and empty session", () => {
    const a = analyzeSession([]);
    expect(a).toEqual({ sessionId: "unknown", title: "", branch: "unknown", startedAt: null, prompts: [], warnings: [] });
  });

  test("push/finish matches analyzeSession and is idempotent", () => {
    const lines = [prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test")];
    const a = createAnalyzer();
    for (const l of lines) a.push(l);
    const r = a.finish();
    expect(a.finish()).toBe(r);
    expect(r).toEqual(analyzeSession(lines));
  });
});
