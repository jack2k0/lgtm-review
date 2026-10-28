import { beforeEach, describe, expect, test } from "vitest";
import { createParser, parseLines } from "./parse.js";
import { bash, bgBash, edit, notificationBlock, prompt, rec, resetIds, taskNotification, toolResult, toolUse } from "./testing/records.js";

beforeEach(resetIds);
const NO_STATS = { assertAdded: 0, assertRemoved: 0, skipAdded: 0, skipRemoved: 0 };

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

  test("a task notification is not a prompt but yields a task-notification event", () => {
    const { events } = parseLines([taskNotification({ taskId: "t1", toolUseId: "u1", status: "completed", summary: 'Background command "pnpm test" completed (exit code 0)' })]);
    expect(events).toMatchObject([{ type: "task-notification", taskId: "t1", toolUseId: "u1", status: "completed", exitCode: 0 }]);
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
  test("tool_use carries the record's cwd; a record without cwd adds no key", () => {
    const withCwd = rec("assistant", {
      cwd: "/home/user/project/packages/web",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] },
    });
    const withoutCwd = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } }] },
    });
    const uses = parseLines([withCwd, withoutCwd]).events.filter((e) => e.type === "tool_use");
    expect(uses[0]).toMatchObject({ id: "t1", cwd: "/home/user/project/packages/web" });
    expect(uses[1] as { cwd?: string }).not.toHaveProperty("cwd");
  });

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
    // Only a 4 KB tail of the result is kept (for the masked-exit inspection), never the full text.
    expect(JSON.stringify(events).length).toBeLessThan(6000);
    expect((events[1] as { tail?: string }).tail).toHaveLength(4096);
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
      { path: "/home/user/project/x.txt", kind: "M", added: 1, removed: 2, maybeIncomplete: false, stats: NO_STATS },
      { path: "/home/user/project/gone.txt", kind: "D", added: 0, removed: 2, maybeIncomplete: false, stats: NO_STATS },
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

  test("a leading UTF-8 BOM on the first line is stripped; the prompt is kept", () => {
    const { events, warnings } = parseLines(["\uFEFF" + prompt("hello from bom")]);
    expect(events).toMatchObject([{ type: "prompt", text: "hello from bom" }]);
    expect(warnings).toEqual([]);
  });

  test("a BOM in the middle of line 3 is not stripped", () => {
    const broken = prompt("keep").replace(',"uuid"', ',\uFEFF"uuid"');
    const lines = [prompt("first"), prompt("second"), broken, prompt("after")];
    const { events, warnings } = parseLines(lines);
    expect(events.filter((e) => e.type === "prompt").map((e) => (e.type === "prompt" ? e.text : ""))).toEqual(["first", "second", "after"]);
    expect(warnings).toEqual([{ line: 3, reason: "invalid JSON" }]);
  });

  test("a leading BOM on a later line is not stripped", () => {
    const { events, warnings } = parseLines([prompt("first"), "\uFEFF" + prompt("second"), prompt("third")]);
    expect(events.filter((e) => e.type === "prompt").map((e) => (e.type === "prompt" ? e.text : ""))).toEqual(["first", "third"]);
    expect(warnings).toEqual([{ line: 2, reason: "invalid JSON" }]);
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

describe("slash command prompts", () => {
  const cmd = (name: string, args?: string, extra: Record<string, unknown> = {}) =>
    prompt(`<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args !== undefined ? `\n<command-args>${args}</command-args>` : ""}`, extra);
  const texts = (lines: string[]) => parseLines(lines).events.flatMap((e) => (e.type === "prompt" ? [e.text] : []));

  test("a work command opens a prompt: /name args", () => {
    expect(texts([cmd("review", "src/a.ts please")])).toEqual(["/review src/a.ts please"]);
    expect(texts([cmd("review")])).toEqual(["/review"]);
    expect(texts([cmd("my-plugin:ship", "")])).toEqual(["/my-plugin:ship"]);
  });

  test("the name may come before the message and args may span lines", () => {
    expect(texts([prompt("<command-name>/review</command-name>\n<command-args>a\n  b</command-args>")])).toEqual(["/review a b"]);
    expect(texts([prompt([{ type: "text", text: "<command-name>/review</command-name>" }])])).toEqual(["/review"]);
  });

  test("args are truncated like prompts", () => {
    expect(texts([cmd("review", "x".repeat(500))])[0]).toHaveLength(200);
  });

  test.each([
    "clear", "compact", "model", "help", "status", "config", "login", "logout", "cost", "context", "resume", "exit",
    "ide", "permissions", "mcp", "memory", "hooks", "doctor", "terminal-setup", "statusline", "vim", "theme", "fast",
  ])("/%s opens no prompt", (name) => {
    expect(texts([cmd(name, "x")])).toEqual([]);
  });

  test("/goal clear is skipped, /goal with text is a prompt", () => {
    expect(texts([cmd("goal", "clear")])).toEqual([]);
    expect(texts([cmd("goal", "ship the parser")])).toEqual(["/goal ship the parser"]);
  });

  test("the skill expansion record (isMeta) does not open a second prompt", () => {
    expect(texts([cmd("review", "x"), prompt("Base directory for this skill: /somewhere\n\nDo the review.", { isMeta: true })])).toEqual(["/review x"]);
  });

  test("an expansion without isMeta that answers the command record before any agent output is skipped", () => {
    const c = cmd("review", "x");
    const uuid = (JSON.parse(c) as { uuid: string }).uuid;
    expect(texts([c, prompt("Expanded skill body.", { parentUuid: uuid })])).toEqual(["/review x"]);
    // after the agent answered, a follow-up under the same parent is a human prompt
    const lines = [c, ...edit("e1"), prompt("next", { parentUuid: uuid })];
    expect(texts(lines)).toEqual(["/review x", "next"]);
  });

  test("local command output stays hidden", () => {
    expect(texts([cmd("review"), prompt("<local-command-stdout>ok</local-command-stdout>")])).toEqual(["/review"]);
  });
});

describe("result tail", () => {
  test("short results carry no tail; long ones keep the last 4096 characters", () => {
    const short = parseLines([toolResult("t1", "ok")]).events[0] as { tail?: string };
    expect(short.tail).toBeUndefined();
    const text = "h".repeat(3000) + "T".repeat(5000);
    const long = parseLines([toolResult("t1", [{ type: "text", text }])]).events[0] as { text: string; tail?: string };
    expect(long.text).toHaveLength(500);
    expect(long.tail).toBe(text.slice(-4096));
  });
});

describe("task notifications", () => {
  const notes = (lines: string[]) => parseLines(lines).events.filter((e) => e.type === "task-notification");

  test("background tool_result carries backgroundTaskId", () => {
    const { events } = parseLines(bgBash("b1", "task9", "pnpm test"));
    expect(events[1]).toMatchObject({ type: "tool_result", background: true, backgroundTaskId: "task9" });
    expect(parseLines([toolResult("b2", "ok", { toolUseResult: { backgroundTaskId: 42 } })]).events[0]).toMatchObject({ background: true, backgroundTaskId: "42" });
    expect(parseLines([toolResult("b3", "ok")]).events[0]).not.toHaveProperty("backgroundTaskId");
  });

  test("tags in any order, extra tags ignored, status lowercased", () => {
    const text = "<task-notification><summary>done (Exit Code: 3)</summary><weird>x</weird><status>FAILED</status><tool-use-id> toolu_1 </tool-use-id><task-id>t1</task-id></task-notification>";
    expect(notes([prompt(text, { origin: { kind: "task-notification" } })])).toMatchObject([{ taskId: "t1", toolUseId: "toolu_1", status: "failed", exitCode: 3 }]);
  });

  test("missing tool-use-id, missing summary and missing status", () => {
    const ev = notes([taskNotification({ taskId: "t1" })]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ taskId: "t1", status: "", exitCode: null });
    expect(ev[0]).not.toHaveProperty("toolUseId");
  });

  test("no exit code in the summary", () => {
    expect(notes([taskNotification({ taskId: "t1", status: "completed", summary: "Background command finished" })])[0]).toMatchObject({ exitCode: null });
  });

  test("last exit code in the summary decides", () => {
    expect(notes([taskNotification({ taskId: "t1", status: "completed", summary: 'Command "pytest -k \\"exit code 0\\"" failed with exit code 1' })])[0]).toMatchObject({ exitCode: 1 });
  });

  test("several blocks in one record, in order", () => {
    const text = [notificationBlock({ taskId: "a", status: "completed" }), "noise", notificationBlock({ taskId: "b", status: "failed", summary: "exit code 2" })].join("\n");
    expect(notes([prompt(text, { origin: { kind: "task-notification" } })]).map((e) => (e as { taskId?: string }).taskId)).toEqual(["a", "b"]);
  });

  test("text blocks of a content list are scanned", () => {
    const content = [{ type: "text", text: notificationBlock({ taskId: "a", status: "completed" }) }];
    expect(notes([prompt(content, { origin: { kind: "task-notification" } })])).toHaveLength(1);
  });

  test("malformed blocks are ignored without throwing", () => {
    expect(notes([prompt("<task-notification><task-id>t1</task-id>", { origin: { kind: "task-notification" } })])).toEqual([]);
    expect(notes([prompt("<task-notification></task-notification>", { origin: { kind: "task-notification" } })])).toEqual([]);
    expect(notes([prompt("<task-notification><task-id></task-id><status>completed</status></task-notification>")])).toEqual([]);
    expect(() => parseLines([prompt("<task-notification>".repeat(50)), prompt([{ type: "text" }, null, 5] as unknown as string)])).not.toThrow();
  });

  test("emitted for meta, non-human and scheduled records; none of them is a prompt", () => {
    const f = { taskId: "t1", status: "completed" };
    const lines = [taskNotification(f, { isMeta: true }), taskNotification(f, { origin: { kind: "peer" } }), taskNotification(f, { scheduledTaskId: "x" })];
    const { events } = parseLines(lines);
    expect(events.map((e) => e.type)).toEqual(["task-notification", "task-notification", "task-notification"]);
  });

  test("notification and tool_result in one record: result first, then the notification", () => {
    const line = rec("user", {
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "b1", content: "ok" },
          { type: "text", text: notificationBlock({ taskId: "t1", status: "completed" }) },
        ],
      },
    });
    expect(parseLines([line]).events.map((e) => e.type)).toEqual(["tool_result", "task-notification"]);
  });

  test("in a subagent transcript notifications are emitted too (matching is by id)", () => {
    const { events } = parseLines([taskNotification({ taskId: "t1", status: "completed" }, { isSidechain: true })], { sidechain: true });
    expect(events.map((e) => e.type)).toEqual(["task-notification"]);
    expect(parseLines([taskNotification({ taskId: "t1", status: "completed" }, { isSidechain: true })]).events).toEqual([]);
  });

  test("a human prompt that merely mentions the tag mid-text is still a prompt", () => {
    expect(kinds([prompt("what is a <task-notification> block?")])).toEqual(["prompt"]);
  });
});
