import { beforeEach, describe, expect, test } from "vitest";
import { analyzeSession, createAnalyzer } from "./analyze.js";
import { F, bash, bgBash, edit, prompt, resetIds, taskNotification, toolResult, toolUse } from "./testing/records.js";

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
    expect(p.reason).toContain("(exit code not verified)");
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

  test("Bash edits come from bashEditDiff; a command without one is counted heuristically (maybeIncomplete)", () => {
    const lines = [
      prompt("q"),
      toolUse("b1", "Bash", { command: "sed -i s/a/b/ x.txt" }),
      toolResult("b1", "", {
        toolUseResult: { bashEditDiff: { files: [{ filePath: "/home/user/project/x.txt", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] }] } },
      }),
      ...bash("b2", "sed -i s/a/b/ y.txt"),
    ];
    const p = one(lines);
    expect(p.files).toEqual([
      { path: "/home/user/project/x.txt", kind: "M", added: 1, removed: 1, maybeIncomplete: false },
      { path: "/home/user/project/y.txt", kind: "M", added: 0, removed: 0, maybeIncomplete: true },
    ]);
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

describe("masked exit codes", () => {
  const run = (cmd: string, output: string) => one([prompt("q"), ...edit("e1"), ...bash("b1", cmd, { output })]);

  test("pipe to tail with failures in the output => failing, even though the exit is 0", () => {
    expect(run("pytest -q 2>&1 | tail -3", "=== 2 failed, 10 passed in 1s ===")).toMatchObject({
      status: "failing",
      reason: "pytest -q 2>&1 output indicates failures (exit code masked)",
    });
  });

  test("pipe to tail with clean output stays checked, with a reason suffix", () => {
    expect(run("pytest -q | tail -3", "12 passed in 1s")).toMatchObject({
      status: "checked",
      reason: "pytest -q passed after last edit (exit code not verified)",
    });
  });

  test("trailing echo of the exit code is read from the output", () => {
    expect(run("pytest; echo EXIT=$?", "...\nEXIT=1")).toMatchObject({ status: "failing" });
    expect(run("pytest; echo EXIT=$?", "...\nEXIT=0")).toMatchObject({ status: "checked" });
  });

  test("only the tail of a long output counts (the head is cut at parse time)", () => {
    const long = `${"progress line\n".repeat(200)}=== 1 failed, 4 passed ===`;
    expect(run("pytest | tail -300", long).status).toBe("failing");
    expect(run("pytest | tail -300", `Traceback (most recent call last):\n  boom\n${"progress line\n".repeat(200)}12 passed`).status).toBe("checked");
  });

  test("a reliable exit code is trusted: no inspection of the output", () => {
    expect(run("pytest -q", "1 failed")).toMatchObject({ status: "checked", reason: "pytest -q passed after last edit" });
  });

  test("mutation probe: a clean pass is checked but flagged as possibly reverted", () => {
    expect(run("pytest -q 2>&1 | tail -1; git checkout -q src/add.js", "12 passed")).toMatchObject({
      status: "checked",
      reason: "pytest -q 2>&1 passed after last edit (edits may have been reverted)",
    });
  });

  test("mutation probe with failing output => failing", () => {
    expect(run("pytest -q 2>&1 | tail -1; git checkout -q src/add.js", "1 failed").status).toBe("failing");
  });

  test("a masked failure is superseded by a later clean check", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pytest | tail -1", { output: "1 failed" }), ...edit("e2"), ...bash("b2", "pytest -q")]);
    expect(p.status).toBe("checked");
  });

  test("a masked failure followed by an edit => unchecked, edits after last check", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pytest | tail -1", { output: "1 failed" }), ...edit("e2")]);
    expect(p).toMatchObject({ status: "unchecked", reason: "1 edit after last check" });
  });

  test("detail mode: the masked check is shown as failed with the signal line", () => {
    const a = createAnalyzer({ detail: true });
    for (const l of [prompt("q"), ...edit("e1"), ...bash("b1", "pytest | tail -2", { output: "x\n2 failed, 1 passed" })]) a.push(l);
    a.finish();
    const check = a.details()[0]!.steps.find((s) => s.check !== undefined)!;
    expect(check.title).toContain("failed (exit code masked)");
    expect(check.check).toMatchObject({ exitCode: 0, passed: false, excerpt: "2 failed, 1 passed" });
    expect(a.details()[0]!.status).toBe("failing");
  });
});

describe("slash command turns", () => {
  const cmd = (name: string, args = "") =>
    prompt(`<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` + (args ? `\n<command-args>${args}</command-args>` : ""));

  test("a work command with edits is its own prompt", () => {
    const a = analyzeSession([prompt("first"), ...edit("e1"), ...bash("b1", "pnpm test"), cmd("review", "the parser"), ...edit("e2"), ...edit("e3", "/home/user/project/src/b.js")]);
    expect(a.prompts).toHaveLength(2);
    expect(a.prompts[0]).toMatchObject({ status: "checked" });
    expect(a.prompts[1]).toMatchObject({ text: "/review the parser", status: "unchecked", reason: "no checks ran" });
    expect(a.prompts[1]!.files).toHaveLength(2);
  });

  test("a command without tool activity is a no-changes prompt", () => {
    expect(analyzeSession([cmd("review")]).prompts[0]).toMatchObject({ text: "/review", status: "no-changes" });
  });

  test("skipped commands open no prompt", () => {
    expect(analyzeSession([prompt("first"), cmd("clear"), cmd("model", "opus"), ...edit("e1")]).prompts).toHaveLength(1);
  });
});

describe("shell edits without bashEditDiff", () => {
  test("sed -i is an edit with the target path and a reason suffix", () => {
    const p = one([prompt("q"), ...bash("b1", "sed -i 's/a/b/' src/x.js")]);
    expect(p).toMatchObject({ status: "unchecked", reason: "no checks ran (shell edits may be incomplete)" });
    expect(p.files).toEqual([{ path: "/home/user/project/src/x.js", kind: "M", added: 0, removed: 0, maybeIncomplete: true }]);
  });

  test("an unparseable target becomes (shell edit)", () => {
    const p = one([prompt("q"), ...bash("b1", "git apply fix.patch")]);
    expect(p.files.map((f) => f.path)).toEqual(["(shell edit)"]);
  });

  test("edit then passing check => checked, suffix kept", () => {
    expect(one([prompt("q"), ...bash("b1", "perl -pi -e 's/a/b/' lib.pl"), ...bash("b2", "pnpm test")])).toMatchObject({
      status: "checked",
      reason: "pnpm test passed after last edit (shell edits may be incomplete)",
    });
  });

  test("a failed command is not an edit", () => {
    expect(one([prompt("q"), ...bash("b1", "sed -i 's/a/b/' x.js", { exit: 1, output: "no such file" })]).status).toBe("no-changes");
  });

  test("scratch redirects and a check's log capture are not edits", () => {
    expect(one([prompt("q"), ...bash("b1", "echo hi > /tmp/x.txt"), ...bash("b2", "ls > $TMPDIR/l"), ...bash("b3", "bash scripts/verify-x.sh > verify.log 2>&1")]).status).toBe("no-changes");
  });

  test("does not double-count when bashEditDiff is present", () => {
    const lines = [
      prompt("q"),
      toolUse("b1", "Bash", { command: "sed -i s/a/b/ x.txt" }),
      toolResult("b1", "", {
        toolUseResult: { bashEditDiff: { files: [{ filePath: "/home/user/project/x.txt", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] }] } },
      }),
    ];
    const p = one(lines);
    expect(p.files).toHaveLength(1);
    expect(p.reason).toBe("no checks ran");
  });

  describe("empty bashEditDiff", () => {
    const empty = { bashEditDiff: { files: [] } };
    const run = (command: string) => one([prompt("q"), toolUse("b1", "Bash", { command }), toolResult("b1", "", { toolUseResult: empty })]);
    test.each([
      ["sed -i + git commit", "sed -i 's/a/b/' x.js && git commit -am m", "unchecked", "no checks ran (shell edits may be incomplete)", ["/home/user/project/x.js"]],
      ["perl -pi + commit", "perl -pi -e 's/a/b/' x.pl && git commit -am m", "unchecked", "no checks ran (shell edits may be incomplete)", ["/home/user/project/x.pl"]],
      ["printf >> file", "printf 'x' >> notes.txt && git commit -am m", "unchecked", "no checks ran (shell edits may be incomplete)", ["/home/user/project/notes.txt"]],
      ["git apply", "git apply fix.patch && git commit -am m", "unchecked", "no checks ran (shell edits may be incomplete)", ["(shell edit)"]],
      ["heredoc write before check", "cat > x.js <<'EOF'\nx\nEOF\npnpm test", "checked", "pnpm test passed after last edit (shell edits may be incomplete)", ["/home/user/project/x.js"]],
      ["check before sed -i", "pnpm test && sed -i 's/a/b/' x.js", "unchecked", "1 edit after last check (shell edits may be incomplete)", ["/home/user/project/x.js"]],
      ["plain git commit", "git add -A && git commit -m m", "no-changes", "no edits", []],
      ["git-op only", "git merge origin/main", "no-changes", "no edits", []],
      ["scratch redirect", "echo hi > /tmp/x && git commit -m m", "no-changes", "no edits", []],
    ])("%s", (_n, command, status, reason, files) => {
      const p = run(command);
      expect({ status: p.status, reason: p.reason, files: p.files.map((f) => f.path) }).toEqual({ status, reason, files });
    });
  });

  test("check and sed -i in one command: order decides", () => {
    expect(one([prompt("q"), ...bash("b1", "sed -i s/a/b/ x.js && pnpm test")])).toMatchObject({ status: "checked" });
    expect(one([prompt("q"), ...bash("b1", "pnpm test && sed -i s/a/b/ x.js")])).toMatchObject({ status: "unchecked", reason: "1 edit after last check (shell edits may be incomplete)" });
  });

  test("subagent suffix follows the shell suffix", () => {
    const p = one([prompt("q"), toolUse("a1", "Agent", { prompt: "x" }), toolResult("a1", "done"), ...bash("b1", "tee out.js < in.js")]);
    expect(p.reason).toBe("no checks ran (shell edits may be incomplete); subagent activity not analysed");
  });
});

describe("git operations", () => {
  const diffBash = (id: string, command: string, path = "/home/user/project/src/merged.js") => [
    toolUse(id, "Bash", { command }),
    toolResult(id, "", {
      toolUseResult: { bashEditDiff: { files: [{ filePath: path, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-a", "+b", "+c"] }] }] } },
    }),
  ];

  test("G8: check, then git merge with bashEditDiff => still checked, reason unchanged, file listed as maybeIncomplete", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...diffBash("b2", "git merge main")]);
    expect(p).toMatchObject({ status: "checked", reason: "pnpm test passed after last edit" });
    expect(p.files.map((f) => [f.path, f.maybeIncomplete])).toEqual([
      ["/home/user/project/src/add.js", false],
      ["/home/user/project/src/merged.js", true],
    ]);
  });

  test.each(["git rebase main", "git pull --ff-only", "git checkout main", "git stash pop", "git cherry-pick abc123", "git reset --hard HEAD~1", "git restore src/x.js", "git -C ../w mv a.js b.js"])(
    "%s never invalidates a passing check",
    (cmd) => {
      expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...diffBash("b2", cmd)]).status).toBe("checked");
    },
  );

  test("a failing check stays failing and an unchecked prompt stays unchecked after a git op", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test", { exit: 1 }), ...diffBash("b2", "git merge main")]).status).toBe("failing");
    expect(one([prompt("q"), ...edit("e1"), ...diffBash("b2", "git merge main")])).toMatchObject({ status: "unchecked", reason: "no checks ran" });
  });

  test("only git operations => no-changes, files still listed", () => {
    const p = one([prompt("q"), ...diffBash("b1", "git merge main")]);
    expect(p).toMatchObject({ status: "no-changes", reason: "no edits (git operations only)" });
    expect(p.files).toHaveLength(1);
    expect(p.files[0]!.maybeIncomplete).toBe(true);
  });

  test("a git op mixed with another mutating segment is a normal edit", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...diffBash("b2", "git merge main && sed -i s/a/b/ src/merged.js")]).status).toBe("unchecked");
  });

  test("git mv without a diff is a git-op edit: listed, never moves the status", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...bash("b2", "git mv src/a.js src/b.js")]);
    expect(p).toMatchObject({ status: "checked", reason: "pnpm test passed after last edit" });
    expect(p.files.map((f) => f.path)).toContain("/home/user/project/src/b.js");
  });

  test("the audit shape: check and git mv in one command never reports 0 edits", () => {
    const p = one([prompt("q"), ...edit("e1"), ...diffBash("b1", "bash scripts/check.sh && git mv a.js b.js", "/home/user/project/b.js")]);
    expect(p.status).toBe("checked");
    expect(p.reason).not.toMatch(/\b0 edits?\b/);
  });

  test("an edit in a command the classifier cannot order is never reported as 0 edits", () => {
    const p = one([prompt("q"), ...edit("e1"), ...diffBash("b1", "make fmt && pnpm test")]);
    expect(p.reason).toBe("edit in the same command as the last check");
    expect(p.status).toBe("unchecked");
  });

  test("git op edits do not feed the hints", () => {
    const p = one([prompt("q"), ...diffBash("b1", "git merge main", "/home/user/project/src/auth/login.js")]);
    expect(p.hints).toEqual([]);
  });
});

describe("background checks resolved by task notifications", () => {
  const done = (taskId: string, extra: { toolUseId?: string; status?: string; summary?: string } = {}) =>
    taskNotification({ taskId, status: "completed", summary: 'Background command "pnpm test" completed (exit code 0)', ...extra });
  const all = (lines: string[]) => analyzeSession(lines).prompts;

  test("without a notification the background check stays open", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test")])).toMatchObject({ status: "unchecked", reason: "check did not complete" });
  });

  test("completed exit 0, matched by task id, arriving after the next prompt began", () => {
    const [p0, p1] = all([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), prompt("next"), done("t1")]);
    expect(p0).toMatchObject({ status: "checked", reason: "pnpm test passed after last edit" });
    expect(p1!.status).toBe("no-changes");
  });

  test("matched by tool-use id alone", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("other", { toolUseId: "b1" })]).status).toBe("checked");
  });

  test("the tool-use id wins over a task id that names another check", () => {
    const lines = [prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), ...bgBash("b2", "t2", "pnpm lint"), done("t2", { toolUseId: "b1", summary: "exit code 1", status: "failed" })];
    expect(one(lines)).toMatchObject({ status: "failing", reason: "pnpm test failed (exit 1)" });
  });

  test("failed with exit code in the summary => failing (exit N)", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { status: "failed", summary: "failed with exit code 1" })])).toMatchObject({
      status: "failing",
      reason: "pnpm test failed (exit 1)",
    });
  });

  test("failed without an exit code => failing, background check failed", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { status: "failed", summary: "it broke" })])).toMatchObject({
      status: "failing",
      reason: "pnpm test: background check failed",
    });
  });

  test("status failed never passes, even with exit code 0 in the summary", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { status: "failed", summary: "exit code 0" })]).status).toBe("failing");
  });

  test("completed without exit code in the summary counts as exit 0; completed with exit 2 fails", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { summary: "finished" })]).status).toBe("checked");
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { summary: "exit code: 2" })]).reason).toBe("pnpm test failed (exit 2)");
  });

  test("killed, unknown status: stopped => unchecked, check stopped", () => {
    for (const status of ["killed", "stopped", "weird"]) {
      expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { status, summary: "was stopped" })])).toMatchObject({ status: "unchecked", reason: "check stopped" });
    }
  });

  test("status-less notification without exit code is not terminal: ignored", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), taskNotification({ taskId: "t1", summary: "monitor event" })]).reason).toBe("check did not complete");
  });

  test("(a) status-less notification then a later completed exit 0 notification => passed", () => {
    const lines = [prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), taskNotification({ taskId: "t1", summary: "progress" }), done("t1")];
    expect(one(lines).status).toBe("checked");
  });

  test("(b) status-less notification with exit code 1 in summary => failed", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), taskNotification({ taskId: "t1", summary: "finished (exit code 1)" })])).toMatchObject({
      status: "failing",
      reason: "pnpm test failed (exit 1)",
    });
  });

  test("(c) status-less only => check stays unresolved, same as no notification", () => {
    const withNote = one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), taskNotification({ taskId: "t1", summary: "progress" })]);
    const without = one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test")]);
    expect(withNote.status).toBe(without.status);
    expect(withNote.reason).toBe(without.reason);
    expect(withNote).toMatchObject({ status: "unchecked", reason: "check did not complete" });
  });

  test("a stopped check does not hide an older passing foreground check that covers the edit", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...bgBash("b2", "t1", "pnpm lint"), done("t1", { status: "killed" })]).status).toBe("checked");
  });

  test("stopped is not 'did not complete' and counts in the headline's checks", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { status: "killed" })]);
    expect(p.reason).not.toMatch(/did not complete/);
    expect(p.headline).toMatch(/1 check\b/);
  });

  test("a notification with unknown ids has no effect", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("nope", { toolUseId: "toolu_nope" })])).toMatchObject({ status: "unchecked", reason: "check did not complete" });
  });

  test("a notification with neither id is dropped by the parser", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), taskNotification({ status: "completed" })]).reason).toBe("check did not complete");
  });

  test("a notification before the launch result is ignored", () => {
    const lines = [prompt("q"), ...edit("e1"), toolUse("b1", "Bash", { command: "pnpm test", run_in_background: true }), done("t1", { toolUseId: "b1" }), toolResult("b1", "started", { toolUseResult: { backgroundTaskId: "t1" } })];
    expect(one(lines).reason).toBe("check did not complete");
  });

  test("the first terminal notification wins; a later conflicting one is ignored", () => {
    const pass = [prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1"), done("t1", { status: "failed", summary: "exit code 1" })];
    expect(one(pass).status).toBe("checked");
    const fail = [prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { status: "failed", summary: "exit code 1" }), done("t1")];
    expect(one(fail).status).toBe("failing");
    const killedFirst = [prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1", { status: "killed" }), done("t1")];
    expect(one(killedFirst).reason).toBe("check stopped");
  });

  test("two blocks in one record resolve two checks", () => {
    const rec2 = taskNotification([
      { taskId: "t2", status: "completed", summary: "exit code 0" },
      { taskId: "t1", status: "completed", summary: "exit code 0" },
    ]);
    expect(one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), ...bgBash("b2", "t2", "pnpm lint"), rec2]).status).toBe("checked");
  });

  test("out-of-order completion: the check launched last decides, not the one notified last", () => {
    // lint launched first, test second; test fails first, lint passes later -> latest-launched (test) verdict: failing.
    const lines = [prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm lint"), ...bgBash("b2", "t2", "pnpm test"), done("t2", { status: "failed", summary: "exit code 1" }), done("t1")];
    expect(one(lines)).toMatchObject({ status: "failing", reason: "pnpm test failed (exit 1)" });
  });

  test("an edit made while the background check ran is not covered", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), ...edit("e2"), done("t1")]);
    expect(p).toMatchObject({ status: "unchecked", reason: "1 edit after last check" });
    expect(p.hints.map((h) => h.rule)).toContain("unchecked-edit");
  });

  test("an edit before the launch is covered and raises no unchecked-edit hint", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), done("t1")]);
    expect(p.hints.map((h) => h.rule)).not.toContain("unchecked-edit");
  });

  test("a foreground pass after the background start beats a later background failure", () => {
    const lines = [prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm lint"), ...edit("e2"), ...bash("b2", "pnpm test"), done("t1", { status: "failed", summary: "exit code 1" })];
    expect(one(lines)).toMatchObject({ status: "checked", reason: "pnpm test passed after last edit" });
  });

  test("a notification does not resolve a foreground check", () => {
    const lines = [prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test", { exit: 1 }), done("x", { toolUseId: "b1" })];
    expect(one(lines).status).toBe("failing");
  });

  test("a notification in the middle of an unrelated prompt resolves the earlier prompt's check", () => {
    const [p0, p1] = all([prompt("a"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test"), prompt("b"), ...edit("e2", "/home/user/project/src/z.js"), done("t1")]);
    expect(p0!.status).toBe("checked");
    expect(p1).toMatchObject({ status: "unchecked", reason: "no checks ran" });
  });

  test("timing is taken from the launch only (the notification adds nothing)", () => {
    const base = [prompt("q"), ...edit("e1"), ...bgBash("b1", "t1", "pnpm test")];
    const without = analyzeSession(base).prompts[0]!;
    const withNote = analyzeSession([...base, done("t1")]).prompts[0]!;
    expect(withNote.activeMs).toBe(without.activeMs);
    expect(withNote.headline).toBe(without.headline);
  });

  test("a background check in a subagent transcript is resolved by a notification in it", () => {
    const sub = [prompt("task"), ...edit("s1"), ...bgBash("sb", "st1", "pnpm test"), done("st1")];
    const main = [prompt("go"), toolUse("ag", "Agent", { description: "d" }), toolResult("ag", "done")];
    const a = createAnalyzer();
    for (const l of main) a.push(l);
    a.addSubagent("ag", sub, { agentId: "a1", description: "d" });
    expect(a.finish().prompts[0]).toMatchObject({ status: "checked" });
  });
});

describe("scoped checks (FR-017)", () => {
  const P = "/home/user/project";
  const WEB = `${P}/packages/web/src/a.ts`;
  const CORE = `${P}/packages/core/src/b.ts`;

  const withCwd = (line: string, cwd: string): string => {
    const o = JSON.parse(line) as Record<string, unknown>;
    o.cwd = cwd;
    return JSON.stringify(o);
  };
  const bashFrom = (id: string, cwd: string, command: string): string[] => {
    const lines = bash(id, command);
    lines[0] = withCwd(lines[0]!, cwd);
    return lines;
  };
  const diffBash = (id: string, command: string, path: string) => [
    toolUse(id, "Bash", { command }),
    toolResult(id, "", {
      toolUseResult: { bashEditDiff: { files: [{ filePath: path, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-a", "+b", "+c"] }] }] } },
    }),
  ];
  const scoped = (p: ReturnType<typeof one>): (string | null)[] => p.hints.filter((h) => h.rule === "check-scope").map((h) => h.path);

  test("SC-1: a cd-scoped check flags the edited file outside it", () => {
    const p = one([prompt("q"), ...edit("e1", WEB), ...edit("e2", CORE), ...bash("b1", "cd packages/web && pnpm test")]);
    expect(p.status).toBe("checked");
    expect(p.reason).toBe("pnpm test passed after last edit (scoped to packages/web)");
    expect(scoped(p)).toEqual([CORE]);
    expect(p.hints.find((h) => h.rule === "check-scope")).toMatchObject({
      severity: "warn",
      reason: "outside the scope of the passing check (packages/web)",
    });
  });

  test("SC-2: an unscoped check covers every edited file", () => {
    const p = one([prompt("q"), ...edit("e1", WEB), ...edit("e2", CORE), ...bash("b1", "pnpm test")]);
    expect(p).toMatchObject({ status: "checked", reason: "pnpm test passed after last edit" });
    expect(scoped(p)).toEqual([]);
  });

  test("SC-3: a file covered by an earlier full run is no gap", () => {
    const p = one([prompt("q"), ...edit("e1", CORE), ...bash("b1", "pnpm test"), ...edit("e2", WEB), ...bash("b2", "pnpm --filter ./packages/web test")]);
    expect(p.status).toBe("checked");
    expect(scoped(p)).toEqual([]);
  });

  test("SC-4: a named package filter cannot be placed, so nothing is flagged", () => {
    const p = one([prompt("q"), ...edit("e1", CORE), ...bash("b1", "pnpm --filter @acme/web test")]);
    expect(p.status).toBe("checked");
    expect(scoped(p)).toEqual([]);
  });

  test("SC-5: the record cwd scopes the check", () => {
    const p = one([prompt("q"), ...edit("e1", CORE), ...bashFrom("b1", `${P}/packages/web`, "pnpm test")]);
    expect(p.status).toBe("checked");
    expect(p.reason).toContain("(scoped to packages/web)");
    expect(scoped(p)).toEqual([CORE]);
  });

  test("SC-6: a failing scoped check and a later edit are never check-scope hints", () => {
    const failing = one([prompt("q"), ...edit("e1", WEB), ...edit("e2", CORE), ...bash("b1", "cd packages/web && pnpm test", { exit: 1 })]);
    expect(failing.status).toBe("failing");
    expect(scoped(failing)).toEqual([]);
    const later = one([prompt("q"), ...edit("e1", WEB), ...bash("b1", "cd packages/web && pnpm test"), ...edit("e2", CORE)]);
    expect(later.status).toBe("unchecked");
    expect(scoped(later)).toEqual([]);
  });

  test("SC-7: documentation and git-operation edits outside the scope are never flagged", () => {
    const p = one([
      prompt("q"),
      ...edit("e1", WEB),
      ...bash("b1", "cd packages/web && pnpm test"),
      ...edit("e2", `${P}/README.md`),
      ...diffBash("b2", "git merge main", CORE),
    ]);
    expect(p.status).toBe("checked");
    expect(scoped(p)).toEqual([]);
    expect(p.hints.some((h) => (h.path ?? "").endsWith("README.md") || h.path === CORE)).toBe(false);
  });

  test("SC-8: a documentation edit after the scoped check keeps the note and the count", () => {
    const p = one([prompt("q"), ...edit("e1", WEB), ...edit("e2", CORE), ...bash("b1", "cd packages/web && pnpm test"), ...edit("e3", `${P}/README.md`)]);
    expect(p.status).toBe("checked");
    expect(p.reason).toBe("pnpm test passed after last code edit (scoped to packages/web); 1 documentation edit after it");
    expect(scoped(p)).toEqual([CORE]);
    expect(p.hints.some((h) => (h.path ?? "").endsWith("README.md"))).toBe(false);
  });
});

describe("documentation edits (FR-015)", () => {
  const P = "/home/user/project/";
  const diffBash = (id: string, command: string, paths: string[] = [`${P}src/merged.js`]) => [
    toolUse(id, "Bash", { command }),
    toolResult(id, "", {
      toolUseResult: {
        bashEditDiff: { files: paths.map((filePath) => ({ filePath, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-a", "+b", "+c"] }] })) },
      },
    }),
  ];

  test("DOC-1: doc edit after a passing check keeps it checked", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...edit("e2", `${P}README.md`)]);
    expect(p).toMatchObject({ status: "checked", reason: "pnpm test passed after last code edit; 1 documentation edit after it" });
  });

  test("DOC-2: two doc edits are counted", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...edit("e2", `${P}README.md`), ...edit("e3", `${P}docs/a.rst`)]);
    expect(p.status).toBe("checked");
    expect(p.reason.endsWith("; 2 documentation edits after it")).toBe(true);
  });

  test("DOC-3: only doc edits => no-changes, files listed", () => {
    const p = one([prompt("q"), ...edit("e1", `${P}README.md`), ...edit("e2", `${P}LICENSE`)]);
    expect(p).toMatchObject({ status: "no-changes", reason: "no code edits (documentation only)" });
    expect(p.files).toHaveLength(2);
  });

  test("DOC-4: doc edit plus git operation => documentation only", () => {
    const p = one([prompt("q"), ...edit("e1", `${P}README.md`), ...diffBash("b1", "git merge main")]);
    expect(p).toMatchObject({ status: "no-changes", reason: "no code edits (documentation only)" });
  });

  test("DOC-5: only git operations keep their reason", () => {
    expect(one([prompt("q"), ...diffBash("b1", "git merge main")])).toMatchObject({ status: "no-changes", reason: "no edits (git operations only)" });
  });

  test("DOC-6: failing check followed by a doc edit stays failing", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test", { exit: 1 }), ...edit("e2", `${P}README.md`)]);
    expect(p.status).toBe("failing");
    expect(p.reason.startsWith("pnpm test failed")).toBe(true);
  });

  test("DOC-7: doc edit without a check does not add to the unchecked count or hints", () => {
    const p = one([prompt("q"), ...edit("e1"), ...edit("e2", `${P}README.md`)]);
    expect(p).toMatchObject({ status: "unchecked", reason: "no checks ran" });
    expect(p.hints.map((h) => h.rule)).toEqual(["unchecked-edit"]);
    expect(p.hints.every((h) => h.path === F)).toBe(true);
  });

  test("DOC-8: mdx is code", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...edit("e2", `${P}src/page.mdx`)]);
    expect(p).toMatchObject({ status: "unchecked", reason: "1 edit after last check" });
  });

  test("DOC-9: a command editing a doc and a code file is a code edit", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...diffBash("b2", "node fix.js", [`${P}README.md`, `${P}src/e.js`])]);
    expect(p).toMatchObject({ status: "unchecked", reason: "1 edit after last check" });
  });

  test("DOC-10: shell heuristic doc edit keeps the incomplete note", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...bash("b2", "sed -i 's/a/b/' README.md")]);
    expect(p).toMatchObject({
      status: "checked",
      reason: "pnpm test passed after last code edit; 1 documentation edit after it (shell edits may be incomplete)",
    });
  });

  test("DOC-11: code edit after the check still makes it unchecked", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test"), ...edit("e2"), ...edit("e3", `${P}README.md`)]);
    expect(p).toMatchObject({ status: "unchecked", reason: "1 edit after last check" });
  });

  test("DOC-12: unverified exit code note precedes the doc suffix", () => {
    const p = one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test | tail -1"), ...edit("e2", `${P}README.md`)]);
    expect(p.reason).toContain("(exit code not verified); 1 documentation edit after it");
  });

  test("DOC-13: no documentation edits => reason unchanged", () => {
    expect(one([prompt("q"), ...edit("e1"), ...bash("b1", "pnpm test")]).reason).toBe("pnpm test passed after last edit");
  });
});
