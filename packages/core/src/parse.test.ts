import { beforeEach, describe, expect, test } from "vitest";
import { createParser, parseLines } from "./parse.js";
import { bash, edit, prompt, rec, resetIds, toolResult, toolUse } from "./testing/records.js";

beforeEach(resetIds);

const kinds = (lines: string[]) => parseLines(lines).events.map((e) => (e.type === "boundary" ? `boundary:${e.kind}` : e.type));

describe("prompt detection", () => {
  test("plain string and text-block prompts are prompts", () => {
    const { events } = parseLines([prompt("Fix it"), prompt([{ type: "text", text: "and again" }]), prompt([{ type: "text", text: "a" }, { type: "image" }])]);
    expect(events.map((e) => e.type)).toEqual(["prompt", "prompt", "prompt"]);
  });

  test("slash commands, local command output, system reminders and task notifications are not prompts", () => {
    const lines = [
      prompt("<command-name>/clear</command-name><command-message>clear</command-message>"),
      prompt("<local-command-stdout>ok</local-command-stdout>"),
      prompt("<local-command-caveat>Caveat</local-command-caveat>"),
      prompt("<task-notification>done</task-notification>"),
      prompt("<system-reminder>x</system-reminder>"),
    ];
    expect(parseLines(lines).events).toEqual([]);
  });

  test("meta, compact summaries, sidechain, non-human origin and scheduled prompts are not prompts", () => {
    const lines = [
      prompt("meta", { isMeta: true }),
      prompt("summary", { isCompactSummary: true }),
      prompt("sidechain", { isSidechain: true }),
      prompt("task", { origin: { kind: "task-notification" } }),
      prompt("peer", { origin: { kind: "peer" } }),
      prompt("cron", { scheduledTaskId: "x" }),
    ];
    expect(parseLines(lines).events).toEqual([]);
    expect(kinds([prompt("human", { origin: { kind: "human" } })])).toEqual(["prompt"]);
  });

  test("[Request interrupted ...] is an interrupt boundary, not a prompt", () => {
    expect(kinds([prompt("[Request interrupted by user]"), prompt("[Request interrupted by user for tool use]")])).toEqual([
      "boundary:interrupt",
      "boundary:interrupt",
    ]);
  });

  test("compact_boundary becomes a compact boundary", () => {
    expect(kinds([rec("system", { subtype: "compact_boundary" }), rec("system", { subtype: "turn_duration" })])).toEqual(["boundary:compact"]);
  });

  test("prompt text is truncated to 200 chars", () => {
    const { events } = parseLines([prompt("x".repeat(500))]);
    expect(events[0]).toMatchObject({ type: "prompt" });
    expect((events[0] as { text: string }).text).toHaveLength(200);
  });

  test("empty prompt is ignored", () => {
    expect(parseLines([prompt(""), prompt("   ")]).events).toEqual([]);
  });
});

describe("tool pairing data", () => {
  test("tool_result carries the id, so reversed result order can be paired by id", () => {
    const lines = [prompt("go"), toolUse("t1", "Bash", { command: "a" }), toolUse("t2", "Bash", { command: "b" }), toolResult("t2", "two"), toolResult("t1", "one")];
    const { events } = parseLines(lines);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((r) => (r.type === "tool_result" ? r.toolUseId : ""))).toEqual(["t2", "t1"]);
  });

  test("Bash failure exit code is parsed; is_error without Exit code has none", () => {
    const { events } = parseLines([
      toolResult("t1", "Exit code 2\nboom", { isError: true }),
      toolResult("t2", "<tool_use_error>Blocked</tool_use_error>", { isError: true }),
      toolResult("t3", [{ type: "text", text: "fine" }]),
    ]);
    const r = events.filter((e) => e.type === "tool_result");
    expect(r[0]).toMatchObject({ isError: true, exitCode: 2 });
    expect(r[1]).toMatchObject({ isError: true });
    expect((r[1] as { exitCode?: number }).exitCode).toBeUndefined();
    expect(r[2]).toMatchObject({ isError: false, text: "fine" });
  });

  test("large fields are not kept", () => {
    const big = "y".repeat(100_000);
    const { events } = parseLines([
      toolUse("t1", "Write", { file_path: "/home/user/project/a.txt", content: big }),
      toolResult("t1", big, { toolUseResult: { type: "create", content: "l1\nl2\n", originalFile: big, structuredPatch: [] } }),
    ]);
    expect(JSON.stringify(events).length).toBeLessThan(2000);
    expect(events[1]).toMatchObject({ createLines: 2, resultType: "create" });
  });

  test("bashEditDiff and structuredPatch deltas", () => {
    const { events } = parseLines([
      toolResult("t1", "ok", {
        toolUseResult: {
          bashEditDiff: {
            files: [
              { filePath: "/home/user/project/x.txt", hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: [" c", "-a", "+b", "-d"] }] },
              { filePath: "/home/user/project/gone.txt", hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ["-a", "-b"] }] },
            ],
          },
        },
      }),
    ]);
    expect((events[0] as { bashEditDiff: unknown }).bashEditDiff).toEqual([
      { path: "/home/user/project/x.txt", kind: "M", added: 1, removed: 2, maybeIncomplete: false },
      { path: "/home/user/project/gone.txt", kind: "D", added: 0, removed: 2, maybeIncomplete: false },
    ]);
  });

  test("background Bash result is flagged", () => {
    const { events } = parseLines([toolResult("t1", "started", { toolUseResult: { backgroundTaskId: "b1" } })]);
    expect(events[0]).toMatchObject({ background: true });
  });
});

describe("dedupe, metadata and warnings", () => {
  test("a duplicated uuid is ignored", () => {
    const p = prompt("once");
    expect(parseLines([p, p, p]).events).toHaveLength(1);
  });

  test("metadata of the log is captured; sidechain records do not leak into it", () => {
    const { meta } = parseLines([
      rec("user", { isSidechain: true, gitBranch: "other", message: { role: "user", content: "x" } }),
      rec("ai-title", { aiTitle: "A title" }),
      prompt("hello"),
    ]);
    expect(meta).toMatchObject({ branch: "main", title: "A title", sessionId: "00000000-0000-4000-8000-000000000001" });
  });

  test("known metadata types are skipped silently", () => {
    const types = ["mode", "last-prompt", "atis-latch", "bridge-session", "api-request", "api-request-blob", "cost-state", "permission-mode", "file-history-snapshot", "queue-operation", "attachment", "continued-in", "agent-setting"];
    const { events, warnings } = parseLines(types.map((t) => JSON.stringify({ type: t, payload: 1 })));
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("unknown types give one aggregated warning per type", () => {
    const lines = [JSON.stringify({ type: "zzz" }), JSON.stringify({ type: "aaa" }), JSON.stringify({ type: "zzz" }), JSON.stringify({ type: "zzz" })];
    const { warnings } = parseLines(lines, { file: "f.jsonl" });
    expect(warnings).toEqual([
      { file: "f.jsonl", line: 2, reason: "unknown record type aaa (1 record)" },
      { file: "f.jsonl", line: 1, reason: "unknown record type zzz (3 records)" },
    ].sort((a, b) => a.line - b.line));
  });

  test("malformed line in the middle warns; truncated last line warns once with its own reason", () => {
    const lines = [prompt("a"), "{ nope", "", prompt("b"), '{"type":"user","mess'];
    const { warnings, events } = parseLines(lines);
    expect(events).toHaveLength(2);
    expect(warnings).toEqual([
      { line: 2, reason: "invalid JSON" },
      { line: 5, reason: "truncated last line" },
    ]);
  });

  test("non-object records, missing message and tool_use without id warn", () => {
    const { warnings } = parseLines([
      "null",
      "42",
      JSON.stringify({ type: "user", uuid: "u1" }),
      JSON.stringify({ type: "assistant", uuid: "u2", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } }),
      JSON.stringify({ type: "user", uuid: "u3", message: { content: [{ type: "tool_result", content: "x" }] } }),
    ]);
    expect(warnings.map((w) => w.reason)).toEqual([
      "record is not a JSON object",
      "record is not a JSON object",
      "user record lacking message",
      "tool_use without id",
      "tool_result without tool_use_id",
    ]);
  });

  test("never throws on hostile input", () => {
    const p = createParser();
    const hostile = [
      '{"type":"user","message":{"content":[null,1,"x",{"type":"tool_result"}]}}',
      '{"type":"assistant","message":{"content":"str"}}',
      '{"type":"assistant","message":{"content":[null,{"type":"tool_use","id":"a","name":5,"input":"x"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":[null,{"type":"text","text":5}]}]},"toolUseResult":{"structuredPatch":[1,{"lines":5}],"bashEditDiff":{"files":[null,{"filePath":3},{"filePath":"p","hunks":[1]}]}}}',
      '{"type":5}',
      "[]",
      "\u0000",
    ];
    expect(() => {
      for (const l of hostile) p.push(l);
      p.finish();
    }).not.toThrow();
  });

  test("warnings are capped", () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `{ bad ${i}`);
    lines.push(prompt("x"));
    const { warnings } = parseLines(lines);
    expect(warnings.length).toBe(1001);
    expect(warnings.at(-1)?.reason).toBe("500 further warnings omitted");
  });
});

test("helpers produce expected shapes", () => {
  expect(kinds([prompt("p"), ...edit("e1"), ...bash("b1", "pnpm test")])).toEqual(["prompt", "tool_use", "tool_result", "tool_use", "tool_result"]);
});
