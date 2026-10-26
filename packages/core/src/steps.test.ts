import { beforeEach, describe, expect, test } from "vitest";
import { createAnalyzer } from "./analyze.js";
import { parseLines } from "./parse.js";
import type { PromptDetail, Step } from "./schema.js";
import { oneLine } from "./steps.js";
import { at, bash, bgBash, edit, F, patchResult, prompt, rec, resetIds, taskNotification, toolResult, toolUse } from "./testing/records.js";
import { listFixtures, readFixtureLines } from "./testing/fixtures.js";
import { analyzeSession } from "./analyze.js";

beforeEach(resetIds);

const P = "/home/user/project";
const say = (text: string): string => rec("assistant", { message: { role: "assistant", content: [{ type: "text", text }] } });
const read = (id: string, path = `${P}/src/a.ts`): string[] => [toolUse(id, "Read", { file_path: path }), toolResult(id, "content")];

function run(lines: string[]): PromptDetail[] {
  const a = createAnalyzer({ detail: true });
  for (const l of lines) a.push(l);
  return a.details();
}
function steps(lines: string[], prompt0 = 0): Step[] {
  return run(lines)[prompt0]!.steps;
}
const phases = (s: Step[]): string[] => s.map((x) => x.phase);

describe("step grouping", () => {
  test("consecutive actions of one phase form a step", () => {
    const s = steps([prompt("p"), ...read("r1"), ...read("r2"), ...read("r3")]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ n: 1, phase: "read", title: "Read 3 files" });
    expect(s[0]!.actions.map((a) => a.tool)).toEqual(["Read", "Read", "Read"]);
  });

  test("phase changes start a new step; numbering is 1-based", () => {
    const s = steps([prompt("p"), ...read("r1"), ...edit("e1"), ...read("r2")]);
    expect(phases(s)).toEqual(["read", "write", "read"]);
    expect(s.map((x) => x.n)).toEqual([1, 2, 3]);
  });

  test("a check is always its own step, also back to back", () => {
    const s = steps([prompt("p"), ...bash("b1", "pnpm test"), ...bash("b2", "pnpm lint")]);
    expect(phases(s)).toEqual(["check", "check"]);
  });

  test("work after a failing check is Fix until a check passes", () => {
    const s = steps([prompt("p"), ...edit("e1"), ...bash("b1", "pnpm test", { exit: 1, output: "boom" }), ...read("r1"), ...edit("e2"), ...bash("b2", "pnpm test"), ...read("r2")]);
    expect(phases(s)).toEqual(["write", "check", "fix", "check", "read"]);
    expect(s[2]!.title).toBe("Fix: read 1 file, edit src/add.js (+1 -1)");
  });

  test("a read in a pure Read step is not prefixed; titles list the mix", () => {
    const s = steps([
      prompt("p"),
      toolUse("g", "Grep", { pattern: "foo" }),
      toolResult("g", "x"),
      toolUse("w", "WebFetch", { url: "https://example.com" }),
      toolResult("w", "x"),
      ...bash("b1", "git log"),
      ...read("r1"),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]!.title).toBe("Search 1 time, do 1 web lookup, run 1 command, read 1 file");
  });

  test("unclassified tools join the surrounding step", () => {
    const s = steps([prompt("p"), ...read("r1"), toolUse("t", "TodoWrite", { todos: [] }), toolResult("t", "ok"), ...read("r2")]);
    expect(s).toHaveLength(1);
    expect(s[0]!.actions.map((a) => a.tool)).toEqual(["Read", "TodoWrite", "Read"]);
    expect(s[0]!.title).toBe("Read 2 files, use TodoWrite");
  });

  test("with no step open an unclassified tool opens a Read step", () => {
    const s = steps([prompt("p"), toolUse("t", "TodoWrite", { todos: [] }), toolResult("t", "ok"), ...edit("e1")]);
    expect(phases(s)).toEqual(["read", "write"]);
    expect(s[0]!.title).toBe("Use TodoWrite");
  });

  test("unclassified tools after a check stay in the check step", () => {
    const s = steps([prompt("p"), ...bash("b1", "pnpm test"), toolUse("t", "TodoWrite", {}), toolResult("t", "ok"), ...read("r1")]);
    expect(phases(s)).toEqual(["check", "read"]);
    expect(s[0]!.actions).toHaveLength(2);
    expect(s[0]!.title).toBe("Run pnpm test -> passed");
  });

  test("an Agent call adds a partial note to the title", () => {
    const s = steps([prompt("p"), ...read("r1"), toolUse("a", "Agent", { description: "Review it", prompt: "x" }), toolResult("a", "done")]);
    expect(s[0]!.title).toBe("Read 1 file, delegate to a subagent (partial: subagent activity not analysed)");
    expect(s[0]!.actions[1]).toMatchObject({ tool: "Agent", summary: "Agent: Review it" });
  });

  test("parallel calls keep the order of the calls, not of the results", () => {
    const s = steps([
      prompt("p"),
      toolUse("a", "Read", { file_path: `${P}/a` }),
      toolUse("b", "Read", { file_path: `${P}/b` }),
      toolUse("c", "Read", { file_path: `${P}/c` }),
      toolResult("c", "x"),
      toolResult("a", "x"),
      toolResult("b", "x"),
    ]);
    expect(s[0]!.actions.map((a) => a.summary)).toEqual(["a", "b", "c"].map((x) => `${P}/${x}`).map((x) => x.replace(`${P}/`, "")));
  });

  test("a shell edit is a write step with its files", () => {
    const s = steps([
      prompt("p"),
      toolUse("b", "Bash", { command: "sed -i s/a/b/ src/x.ts" }),
      toolResult("b", "", { toolUseResult: { stdout: "", bashEditDiff: { files: [{ filePath: `${P}/src/x.ts`, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] }] } } }),
    ]);
    expect(s[0]).toMatchObject({ phase: "write", title: "Edit src/x.ts (+1 -1)", files: [`${P}/src/x.ts`] });
  });

  test("titles: create, many files and failed edits", () => {
    const w = toolUse("w", "Write", { file_path: `${P}/src/new.ts`, content: "a\nb\n" });
    const wr = toolResult("w", "ok", { toolUseResult: { type: "create", content: "a\nb\n", structuredPatch: [] } });
    expect(steps([prompt("p"), w, wr])[0]!.title).toBe("Create src/new.ts (+2)");
    const many = [prompt("p"), ...edit("e1", `${P}/a`), ...edit("e2", `${P}/b`), ...edit("e3", `${P}/c`)];
    expect(steps(many)[0]!.title).toBe("Edit 3 files (+3 -3)");
    const failed = [prompt("p"), toolUse("e", "Edit", { file_path: `${P}/a` }), toolResult("e", "nope", { isError: true })];
    const s = steps(failed);
    expect(s[0]!.title).toBe("1 failed edit");
    expect(s[0]!.actions[0]).toMatchObject({ ok: false });
    expect(s[0]!.files).toEqual([]);
  });

  test("actions: summaries are paths, truncated commands and patterns, never content", () => {
    const long = "echo " + "x".repeat(500);
    const s = steps([
      prompt("p"),
      toolUse("w", "Write", { file_path: `${P}/src/n.ts`, content: "SECRET CONTENT" }),
      toolResult("w", "ok", { toolUseResult: { type: "create", content: "SECRET CONTENT" } }),
      toolUse("b", "Bash", { command: long }),
      toolResult("b", "x"),
      toolUse("g", "Grep", { pattern: "needle", path: `${P}/src` }),
      toolResult("g", "x"),
    ]);
    const all = s.flatMap((x) => x.actions);
    expect(all.map((a) => a.summary)).toEqual(["src/n.ts", "echo", "needle"]);
    expect(JSON.stringify(s)).not.toContain("SECRET");
  });

  test("an action without result is not ok; step timing ignores it", () => {
    const s = steps([prompt("p"), toolUse("r", "Read", { file_path: `${P}/a` }, at(1))]);
    expect(s[0]!.actions[0]).toMatchObject({ ok: false });
    expect(s[0]!.durationMs).toBe(0);
  });

  test("startedAt and ts are ISO strings, null without timestamps", () => {
    const withTs = steps([prompt("p", { timestamp: at(4) }), toolUse("r", "Read", { file_path: `${P}/a` }, at(5)), toolResult("r", "x", { ts: at(6) })]);
    expect(withTs[0]!.startedAt).toBe(at(5));
    expect(withTs[0]!.actions[0]!.ts).toBe(at(5));
    expect(withTs[0]!.durationMs).toBe(2000);
    const none = steps([rec("user", { message: { role: "user", content: "p" }, timestamp: null }), toolUse("r", "Read", { file_path: `${P}/a` }, null), toolResult("r", "x", { ts: null })]);
    expect(none[0]!.startedAt).toBeNull();
    expect(none[0]!.actions[0]!.ts).toBeNull();
  });

  test("steps belong to their prompt", () => {
    const d = run([prompt("one"), ...read("r1"), prompt("two"), ...edit("e1")]);
    expect(d.map((p) => p.steps.length)).toEqual([1, 1]);
    expect(d.map((p) => p.steps[0]!.phase)).toEqual(["read", "write"]);
  });
});

describe("quotes", () => {
  test("agent text before the first action of a step becomes its quotes", () => {
    const s = steps([prompt("p"), say("Let me look."), ...read("r1"), say("Now editing."), ...edit("e1"), say("Trailing remark.")]);
    expect(s.map((x) => x.quotes)).toEqual([["Let me look."], ["Now editing."]]);
  });

  test("text before an action that joins an existing step is not attached", () => {
    const s = steps([prompt("p"), say("first"), ...read("r1"), say("ignored"), ...read("r2")]);
    expect(s[0]!.quotes).toEqual(["first"]);
  });

  test("at most 3 quotes (the nearest ones), each at most 400 characters", () => {
    const s = steps([prompt("p"), say("one"), say("two"), say("three"), say("x".repeat(900)), ...read("r1")]);
    expect(s[0]!.quotes).toHaveLength(3);
    expect(s[0]!.quotes.slice(0, 2)).toEqual(["two", "three"]);
    expect(s[0]!.quotes[2]).toHaveLength(400);
  });

  test("text of an assistant record with a tool_use is a quote too; blank text and thinking are not", () => {
    const mixed = rec("assistant", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "  " }, { type: "text", text: "Reading now." }, { type: "tool_use", id: "r1", name: "Read", input: { file_path: `${P}/a` } }] },
    });
    const s = steps([prompt("p"), mixed, toolResult("r1", "x")]);
    expect(s[0]!.quotes).toEqual(["Reading now."]);
  });

  test("text before the first prompt is ignored; the parser emits text events only in detail mode", () => {
    const lines = [say("orphan"), prompt("p"), say("hi"), ...read("r1")];
    expect(steps(lines)[0]!.quotes).toEqual(["hi"]);
    resetIds();
    const lines2 = [prompt("p"), say("hi")];
    expect(parseLines(lines2).events.map((e) => e.type)).toEqual(["prompt"]);
    expect(parseLines(lines2, { detail: true }).events.map((e) => e.type)).toEqual(["prompt", "text"]);
  });
});

describe("check results", () => {
  test("passed: exit code 0, no excerpt", () => {
    const s = steps([prompt("p"), ...bash("b", "pnpm test")]);
    expect(s[0]!.check).toEqual({ command: "pnpm test", exitCode: 0, passed: true, excerpt: "" });
  });

  test("failed: exit code from the structured result, excerpt from the first output lines", () => {
    const s = steps([
      prompt("p"),
      toolUse("b", "Bash", { command: "pnpm test" }),
      toolResult("b", "Exit code 2\n\n  FAIL a.test.ts\n  expected 1\n  more", { isError: true, toolUseResult: "Error: Exit code 2\n..." }),
    ]);
    expect(s[0]!.check).toEqual({ command: "pnpm test", exitCode: 2, passed: false, excerpt: "FAIL a.test.ts\nexpected 1" });
    expect(s[0]!.title).toBe("Run pnpm test -> failed (exit 2)");
  });

  test("the excerpt is at most 200 characters", () => {
    const s = steps([prompt("p"), ...bash("b", "pnpm test", { exit: 1, output: "e".repeat(400) })]);
    expect(s[0]!.check!.excerpt).toHaveLength(200);
  });

  test("no result: exitCode and passed are null", () => {
    const s = steps([prompt("p"), ...bash("b", "pnpm test", { none: true })]);
    expect(s[0]!.check).toEqual({ command: "pnpm test", exitCode: null, passed: null, excerpt: "" });
    expect(s[0]!.title).toBe("Run pnpm test -> no result");
  });

  test("a background check has no known exit code", () => {
    const s = steps([
      prompt("p"),
      toolUse("b", "Bash", { command: "pnpm test", run_in_background: true }),
      toolResult("b", "started", { toolUseResult: { stdout: "", backgroundTaskId: "x" } }),
    ]);
    expect(s[0]!.check).toMatchObject({ exitCode: null, passed: null });
  });

  test("a refused check did not run", () => {
    const s = steps([prompt("p"), toolUse("b", "Bash", { command: "pnpm test" }), toolResult("b", "<tool_use_error>Blocked</tool_use_error>", { isError: true })]);
    expect(s[0]!.check).toMatchObject({ exitCode: null, passed: null });
    expect(s[0]!.title).toBe("Run pnpm test -> did not run");
  });

  test("collision: output text with 'Exit code 0' while is_error is true never counts as passed", () => {
    const textOnly = steps([prompt("p"), toolUse("b", "Bash", { command: "pnpm test" }), toolResult("b", "Exit code 0\nstrange", { isError: true })]);
    expect(textOnly[0]!.check).toMatchObject({ exitCode: null, passed: null });
    expect(textOnly[0]!.actions[0]!.ok).toBe(false);

    resetIds();
    const structured = steps([
      prompt("p"),
      toolUse("b", "Bash", { command: "pnpm test" }),
      toolResult("b", "Exit code 0\nwrapper said so", { isError: true, toolUseResult: "Error: Exit code 3\nwrapper said so" }),
    ]);
    expect(structured[0]!.check).toMatchObject({ exitCode: 3, passed: false });

    resetIds();
    const later = steps([prompt("p"), toolUse("b", "Bash", { command: "pnpm test" }), toolResult("b", "Exit code 1\nlog: Exit code 0 seen", { isError: true })]);
    expect(later[0]!.check).toMatchObject({ exitCode: 1, passed: false });
  });

  test("collision does not turn the prompt status into checked", () => {
    const lines = [prompt("p"), ...edit("e1"), toolUse("b", "Bash", { command: "pnpm test" }), toolResult("b", "Exit code 0", { isError: true })];
    const a = analyzeSession(lines);
    expect(a.prompts[0]!.status).toBe("unchecked");
  });
});

describe("prompt detail", () => {
  test("carries what the Steps view needs (text, status, reason, headline, timing, truncated)", () => {
    const d = run([prompt("Do the thing", { timestamp: at(1) }), ...edit("e1"), ...bash("b", "pnpm test")])[0]!;
    expect(d).toMatchObject({ index: 0, text: "Do the thing", status: "checked", truncated: false, startedAt: at(1) });
    expect(d.reason).toContain("passed after last edit");
    expect(typeof d.headline).toBe("string");
    expect(d.activeMs).toBeGreaterThanOrEqual(0);
  });

  test("carries the hints and recommendation of the analysis", () => {
    const lines = [prompt("p"), ...edit("e1"), ...bash("b", "pnpm test")];
    const a = createAnalyzer({ detail: true });
    for (const l of lines) a.push(l);
    const analysis = a.finish();
    const d = a.details()[0]!;
    expect(d.hints).toEqual(analysis.prompts[0]!.hints);
    expect(d.recommendation).toBe(analysis.prompts[0]!.recommendation);
  });

  test("is deterministic", () => {
    const lines = [prompt("p"), say("a"), ...read("r1"), ...edit("e1"), ...bash("b", "pnpm test", { exit: 1 })];
    const first = JSON.stringify(run(lines));
    expect(JSON.stringify(run(lines))).toBe(first);
  });

  test("default mode retains nothing: details() is empty and diffFor() is null", () => {
    const a = createAnalyzer();
    for (const l of [prompt("p"), ...edit("e1")]) a.push(l);
    expect(a.details()).toEqual([]);
    expect(a.diffFor(0, F)).toBeNull();
    expect(a.detailBytes()).toBe(0);
  });
});

describe("retention caps", () => {
  test("at most 5000 actions per prompt; the rest sets truncated", () => {
    const lines = [prompt("p")];
    for (let i = 0; i < 5100; i++) lines.push(...read(`r${i}`, `${P}/f${i}`));
    const d = run(lines)[0]!;
    expect(d.truncated).toBe(true);
    expect(d.steps.reduce((n, s) => n + s.actions.length, 0)).toBe(5000);
    expect(d.steps[0]!.title).toBe("Read 5000 files");
  });

  test("at most 200 steps per prompt; the rest sets truncated", () => {
    const lines = [prompt("p")];
    for (let i = 0; i < 150; i++) lines.push(...read(`r${i}`), ...edit(`e${i}`));
    const d = run(lines)[0]!;
    expect(d.steps).toHaveLength(200);
    expect(d.truncated).toBe(true);
    expect(d.steps[199]!.n).toBe(200);
  });

  test("small prompts are not truncated", () => {
    expect(run([prompt("p"), ...read("r1")])[0]!.truncated).toBe(false);
  });

  test("agent text is cut while parsing", () => {
    const { events } = parseLines([say("y".repeat(5000))].concat(), { detail: true });
    expect(events[0]).toMatchObject({ type: "text" });
    expect((events[0] as { text: string }).text).toHaveLength(400);
  });

  test("detailBytes grows with retained data", () => {
    const a = createAnalyzer({ detail: true });
    a.push(prompt("p"));
    const before = a.detailBytes();
    for (const l of [...read("r1"), ...edit("e1")]) a.push(l);
    expect(a.detailBytes()).toBeGreaterThan(before);
  });
});

describe("phases agree with the time split (single classifier)", () => {
  test.each(listFixtures())("%s", (name) => {
    const lines = readFixtureLines(name);
    const a = createAnalyzer({ detail: true });
    for (const l of lines) a.push(l);
    const analysis = a.finish();
    const details = a.details();
    const key = { read: "readMs", write: "writeMs", check: "checkMs", fix: "fixMs" } as const;
    for (const d of details) {
      const t = analysis.prompts[d.index]!.timeSplit;
      for (const ph of ["read", "write", "check", "fix"] as const) {
        const sum = d.steps.filter((s) => s.phase === ph).reduce((n, s) => n + s.durationMs, 0);
        // The split merges overlapping intervals of one phase; steps of a phase can only add up to at least that.
        expect(sum, `${name}#${d.index} ${ph}`).toBeGreaterThanOrEqual(t[key[ph]]);
        if (t[key[ph]] > 0) expect(d.steps.some((s) => s.phase === ph)).toBe(true);
        if (!d.truncated && !d.steps.some((s) => s.phase === ph)) expect(t[key[ph]]).toBe(0);
      }
    }
  });

  test("sequential work: per-phase step durations equal the time split exactly", () => {
    const lines = [
      prompt("p", { timestamp: at(0) }),
      toolUse("r", "Read", { file_path: `${P}/a` }, at(2)),
      toolResult("r", "x", { ts: at(5) }),
      toolUse("e", "Edit", { file_path: F }, at(6)),
      toolResult("e", "ok", { ts: at(9), toolUseResult: patchResult(["b"], ["a"]) }),
      toolUse("c", "Bash", { command: "pnpm test" }, at(10)),
      toolResult("c", "Exit code 1\nbad", { ts: at(14), isError: true }),
      toolUse("f", "Edit", { file_path: F }, at(15)),
      toolResult("f", "ok", { ts: at(18), toolUseResult: patchResult(["c"], ["b"]) }),
    ];
    const a = createAnalyzer({ detail: true });
    for (const l of lines) a.push(l);
    const t = a.finish().prompts[0]!.timeSplit;
    const d = a.details()[0]!;
    const sum = (ph: string): number => d.steps.filter((s) => s.phase === ph).reduce((n, s) => n + s.durationMs, 0);
    expect({ readMs: sum("read"), writeMs: sum("write"), checkMs: sum("check"), fixMs: sum("fix") }).toEqual(t);
    expect(phases(d.steps)).toEqual(["read", "write", "check", "fix"]);
  });
});

describe("shared classifier", () => {
  test("actionPhase applies the Fix rule to Read/Write only", async () => {
    const { actionPhase } = await import("./timing.js");
    expect(actionPhase("Read", { isCheck: false, edited: false }, false)).toBe("read");
    expect(actionPhase("Read", { isCheck: false, edited: false }, true)).toBe("fix");
    expect(actionPhase("Edit", { isCheck: false, edited: false }, true)).toBe("fix");
    expect(actionPhase("Bash", { isCheck: true, edited: false }, true)).toBe("check");
    expect(actionPhase("Bash", { isCheck: false, edited: true }, false)).toBe("write");
    expect(actionPhase("Agent", { isCheck: false, edited: false }, true)).toBeNull();
  });
});

describe("background check steps", () => {
  const bgSteps = (note?: Parameters<typeof taskNotification>[0], extra: string[] = []): Step[] =>
    steps([prompt("p"), ...bgBash("b", "t1", "pnpm test"), ...extra, ...(note ? [taskNotification(note)] : [])]);

  test("unresolved: still no result and no flags", () => {
    const s = bgSteps();
    expect(s[0]!.check).toEqual({ command: "pnpm test", exitCode: null, passed: null, excerpt: "" });
    expect(s[0]!.title).toBe("Run pnpm test -> no result");
  });

  test("completed notification rewrites the step's check", () => {
    const s = bgSteps({ taskId: "t1", status: "completed", summary: "exit code 0" });
    expect(s[0]!.check).toEqual({ command: "pnpm test", exitCode: 0, passed: true, excerpt: "", background: true });
    expect(s[0]!.title).toBe("Run pnpm test -> passed");
  });

  test("failed with exit code", () => {
    const s = bgSteps({ taskId: "t1", status: "failed", summary: "failed with exit code 3" });
    expect(s[0]!.check).toMatchObject({ exitCode: 3, passed: false, background: true });
    expect(s[0]!.title).toBe("Run pnpm test -> failed (exit 3)");
  });

  test("failed without exit code", () => {
    const s = bgSteps({ taskId: "t1", status: "failed" });
    expect(s[0]!.check).toMatchObject({ exitCode: null, passed: false, background: true });
    expect(s[0]!.title).toBe("Run pnpm test -> failed");
  });

  test("killed: stopped", () => {
    const s = bgSteps({ toolUseId: "b", status: "killed" });
    expect(s[0]!.check).toMatchObject({ exitCode: null, passed: null, background: true, stopped: true });
    expect(s[0]!.title).toBe("Run pnpm test -> stopped");
  });

  test("status-less without exit code: not terminal, still no result", () => {
    const s = bgSteps({ taskId: "t1", summary: "monitor progress" });
    expect(s[0]!.check).toEqual({ command: "pnpm test", exitCode: null, passed: null, excerpt: "" });
    expect(s[0]!.title).toBe("Run pnpm test -> no result");
  });

  test("the notification may arrive in a later prompt", () => {
    const d = run([prompt("p"), ...bgBash("b", "t1", "pnpm test"), prompt("q"), ...read("r1"), taskNotification({ taskId: "t1", status: "completed", summary: "exit code 0" })]);
    expect(d[0]!.steps[0]!.title).toBe("Run pnpm test -> passed");
    expect(d[1]!.steps.every((x) => x.check === undefined)).toBe(true);
  });

  test("timing is unchanged by the notification (launch only)", () => {
    const base = [prompt("p", { timestamp: at(0) }), toolUse("b", "Bash", { command: "pnpm test", run_in_background: true }, at(1)), toolResult("b", "started", { toolUseResult: { backgroundTaskId: "t1" }, ts: at(2) })];
    const a = run(base)[0]!;
    const b = run([...base, taskNotification({ taskId: "t1", status: "completed", summary: "exit code 0" }, { timestamp: at(600) })])[0]!;
    expect(b.activeMs).toBe(a.activeMs);
    expect(b.steps[0]!.durationMs).toBe(a.steps[0]!.durationMs);
  });
});

describe("oneLine", () => {
  test("mid-word cut: cuts back to the last space", () => {
    expect(oneLine("hello world", 8)).toBe("hello");
    expect(oneLine("one two three four", 11)).toBe("one two");
    expect(oneLine('{"password": "hunter2xyz"}', 20)).toBe('{"password":');
  });

  test("no-space cut: keeps hard cut", () => {
    expect(oneLine("supercalifragilistic", 5)).toBe("super");
    expect(oneLine("abcdefghij", 4)).toBe("abcd");
  });

  test("exact length: returns text unchanged", () => {
    expect(oneLine("hello world", 11)).toBe("hello world");
    expect(oneLine("hello", 5)).toBe("hello");
    expect(oneLine("", 5)).toBe("");
  });

  test("cut at whitespace boundary trims trailing spaces", () => {
    expect(oneLine("hello world", 5)).toBe("hello");
    expect(oneLine("hello world", 6)).toBe("hello");
  });
});

