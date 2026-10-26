import { beforeEach, describe, expect, test } from "vitest";
import { analyzeSession, createAnalyzer } from "./analyze.js";
import { parseLines, type Event } from "./parse.js";
import {
  createSubagentCollector,
  mergeSubagents,
  parseSubagent,
  PROMPT_SUBAGENT_EVENTS_MAX,
  TRANSCRIPT_EVENTS_MAX,
  type MergeContext,
  type SubagentTranscript,
} from "./subagents.js";
import { at, bash, edit, prompt, resetIds, toolResult, toolUse } from "./testing/records.js";

beforeEach(resetIds);

let n = 0;
/** Record builders for a subagent file. */
function agentLines(agentId: string) {
  const base = (type: string, ts: string | null, message: unknown, extra: Record<string, unknown> = {}): string => {
    n++;
    const o: Record<string, unknown> = { type, uuid: `${agentId}-${n}`, isSidechain: true, agentId, sessionId: "s", cwd: "/home/user/project", message, ...extra };
    if (ts !== null) o.timestamp = ts;
    return JSON.stringify(o);
  };
  const F = "/home/user/project/src/add.js";
  return {
    task: (ts = at(0)) => base("user", ts, { role: "user", content: "the delegated task" }),
    use: (id: string, name: string, input: Record<string, unknown>, ts: string | null) =>
      base("assistant", ts, { role: "assistant", content: [{ type: "tool_use", id, name, input }] }),
    res: (id: string, content: string, ts: string | null, extra: Record<string, unknown> = {}, isError = false) =>
      base("user", ts, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, extra),
    edit(id: string, t0: number, t1: number, file = F): string[] {
      return [
        this.use(id, "Edit", { file_path: file, old_string: "a", new_string: "b" }, at(t0)),
        this.res(id, "File updated.", at(t1), { toolUseResult: { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] } }),
      ];
    },
    check(id: string, t0: number, t1: number, exit = 0): string[] {
      return [
        this.use(id, "Bash", { command: "pnpm test" }, at(t0)),
        exit === 0 ? this.res(id, "ok", at(t1), { toolUseResult: { stdout: "ok" } }) : this.res(id, `Exit code ${exit}\nfailed`, at(t1), {}, true),
      ];
    },
  };
}

const tr = (agentId: string, lines: string[], description = `agent ${agentId}`): SubagentTranscript => parseSubagent(lines, { agentId, description });
const agentCall = (id: string, ts: string): string => toolUse(id, "Agent", { description: "d", prompt: "p" }, ts);

describe("sidechain parser", () => {
  test("keeps sidechain records, skips the task record and tags events with the agent id", () => {
    const a = agentLines("a1");
    const { events } = parseLines([a.task(), ...a.edit("e1", 1, 2), a.use("t", "Read", { file_path: "/x" }, at(3))], { sidechain: true });
    expect(events.map((e) => e.type)).toEqual(["tool_use", "tool_result", "tool_use"]);
    for (const e of events) expect(e).toMatchObject({ agentId: "a1" });
  });

  test("the default parser still skips sidechain records", () => {
    const a = agentLines("a1");
    expect(parseLines([a.task(), ...a.edit("e1", 1, 2)]).events).toEqual([]);
  });

  test("falls back to the option when records lack agentId; emits no prompts or boundaries", () => {
    const line = JSON.stringify({ type: "assistant", uuid: "u1", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] } });
    const interrupt = JSON.stringify({ type: "user", uuid: "u2", isSidechain: true, message: { role: "user", content: "[Request interrupted by user]" } });
    const { events } = parseLines([line, interrupt], { sidechain: true, agentId: "fallback" });
    expect(events).toMatchObject([{ type: "tool_use", agentId: "fallback" }]);
  });
});

describe("transcript collector caps", () => {
  test("event cap counts non-text events only and sets truncated", () => {
    const a = agentLines("a1");
    const c = createSubagentCollector({ agentId: "a1" });
    for (let i = 0; i < TRANSCRIPT_EVENTS_MAX + 5; i++) c.push(a.use(`r${i}`, "Read", { file_path: "/x" }, at(1)));
    const t = c.finish();
    expect(t.events).toHaveLength(TRANSCRIPT_EVENTS_MAX);
    expect(t).toMatchObject({ truncated: true, truncation: "events" });
  });

  test("text cap sets truncated with its own reason", () => {
    const a = agentLines("a1");
    const c = createSubagentCollector({ agentId: "a1" });
    const big = "x".repeat(10_000); // a result keeps 500 head + 4096 tail chars
    for (let i = 0; i < 1300; i++) c.push(a.res(`b${i}`, big, at(1)));
    expect(c.finish()).toMatchObject({ truncated: true, truncation: "text" });
  });

  test("description is capped at 200 chars", () => {
    expect(parseSubagent([], { agentId: "a", description: "d".repeat(500) }).description).toHaveLength(200);
  });
});

function ctxOf(map: Map<string, SubagentTranscript>): MergeContext {
  return { subagents: map, used: new Set(), descriptions: new Map() };
}
const describeEv = (e: Event): string => (e.type === "tool_use" ? `${e.agentId ?? "P"}:${e.id}` : e.type === "tool_result" ? `${e.agentId ?? "P"}:${e.toolUseId}` : e.type);

describe("merge order", () => {
  function parentOf(lines: string[]): Event[] {
    return parseLines(lines).events;
  }

  test("guest events go after the last host event with ts <= theirs; ties host first", () => {
    const a = agentLines("A");
    const host = parentOf([
      prompt("q", { timestamp: at(0) }),
      agentCall("ag", at(1)),
      toolUse("p1", "Read", { file_path: "/x" }, at(5)),
      toolUse("p2", "Read", { file_path: "/x" }, at(10)),
    ]);
    const t = tr("A", [a.use("g1", "Read", { file_path: "/x" }, at(5)), a.use("g2", "Read", { file_path: "/x" }, at(7)), a.use("g3", "Read", { file_path: "/x" }, at(12))]);
    const out = mergeSubagents(host, ctxOf(new Map([["ag", t]]))).events.map(describeEv);
    expect(out).toEqual(["prompt", "P:ag", "P:p1", "A:g1", "A:g2", "P:p2", "A:g3"]);
  });

  test("guest events earlier than the Agent call attach right after it; later than the end attach at the end", () => {
    const a = agentLines("A");
    const host = parentOf([prompt("q", { timestamp: at(10) }), agentCall("ag", at(11)), toolUse("p1", "Read", { file_path: "/x" }, at(12))]);
    const t = tr("A", [a.use("early", "Read", { file_path: "/x" }, at(1)), a.use("late", "Read", { file_path: "/x" }, at(99))]);
    expect(mergeSubagents(host, ctxOf(new Map([["ag", t]]))).events.map(describeEv)).toEqual(["prompt", "P:ag", "A:early", "P:p1", "A:late"]);
  });

  test("events without a timestamp inherit the previous one (guest and host)", () => {
    const a = agentLines("A");
    const host = parentOf([
      prompt("q", { timestamp: at(0) }),
      agentCall("ag", at(1)),
      toolUse("p1", "Read", { file_path: "/x" }, null),
      toolUse("p2", "Read", { file_path: "/x" }, at(10)),
    ]);
    const t = tr("A", [a.use("g1", "Read", { file_path: "/x" }, at(2)), a.use("g2", "Read", { file_path: "/x" }, null), a.use("g3", "Read", { file_path: "/x" }, at(11))]);
    // p1 inherits 1; g1 (2) and g2 (inherits 2) go after p1; g3 after p2.
    expect(mergeSubagents(host, ctxOf(new Map([["ag", t]]))).events.map(describeEv)).toEqual(["prompt", "P:ag", "P:p1", "A:g1", "A:g2", "P:p2", "A:g3"]);
  });

  test("host order is kept even when host timestamps are not monotonic", () => {
    const a = agentLines("A");
    const host = parentOf([
      prompt("q", { timestamp: at(0) }),
      agentCall("ag", at(1)),
      toolUse("p1", "Read", { file_path: "/x" }, at(20)),
      toolUse("p2", "Read", { file_path: "/x" }, at(5)),
      toolUse("p3", "Read", { file_path: "/x" }, at(30)),
    ]);
    const t = tr("A", [a.use("g1", "Read", { file_path: "/x" }, at(6))]);
    const out = mergeSubagents(host, ctxOf(new Map([["ag", t]]))).events.map(describeEv);
    expect(out.filter((x) => x.startsWith("P:"))).toEqual(["P:ag", "P:p1", "P:p2", "P:p3"]);
    // last host event with ts <= 6 is p2
    expect(out).toEqual(["prompt", "P:ag", "P:p1", "P:p2", "A:g1", "P:p3"]);
  });

  test("two agents interleave by timestamp, ties by parent call order; each keeps its own order", () => {
    const a = agentLines("A");
    const b = agentLines("B");
    const host = parentOf([prompt("q", { timestamp: at(0) }), agentCall("agB", at(1)), agentCall("agA", at(1))]);
    const ta = tr("A", [a.use("a1", "Read", { file_path: "/x" }, at(5)), a.use("a2", "Read", { file_path: "/x" }, at(3))]);
    const tb = tr("B", [b.use("b1", "Read", { file_path: "/x" }, at(4)), b.use("b2", "Read", { file_path: "/x" }, at(5))]);
    const out = mergeSubagents(host, ctxOf(new Map([["agA", ta], ["agB", tb]]))).events.map(describeEv);
    // A's second event has a smaller ts but cannot overtake a1 (monotone within a transcript).
    // B was called before A in the host, so on tie at ts=5 B:b2 precedes A:a1 and A:a2.
    expect(out.slice(3)).toEqual(["B:b1", "B:b2", "A:a1", "A:a2"]);
  });
});

describe("effects on the analysis", () => {
  const dir = "/home/user/project/src/";

  test("subagent edit after the parent's passing check => unchecked, names the subagent", () => {
    const a = agentLines("A");
    const lines = [prompt("q", { timestamp: at(0) }), ...edit("e1"), ...bash("b1", "pnpm test"), agentCall("ag", at(50))];
    const p = analyzeSession(lines, { subagents: new Map([["ag", tr("A", [a.task(), ...a.edit("s1", 60, 61, `${dir}b.js`)], "Write b")]]) }).prompts[0]!;
    expect(p).toMatchObject({ status: "unchecked", partial: false, reason: "1 edit after last check (by subagent Write b)" });
    expect(p.files.map((f) => f.path)).toEqual(["/home/user/project/src/add.js", `${dir}b.js`]);
  });

  test("finding 2.1: subagent edit with clock skew (ts earlier than parent check) cannot slot before its Agent call", () => {
    const a = agentLines("A");
    // Parent check at 20, Agent call at 50; subagent edit has ts=5 (earlier than the check).
    const lines = [
      prompt("q", { timestamp: at(0) }),
      toolUse("b1", "Bash", { command: "pnpm test" }, at(20)),
      toolResult("b1", "ok", { toolUseResult: { stdout: "ok" }, ts: at(21) }),
      agentCall("ag", at(50)),
    ];
    const p = analyzeSession(lines, { subagents: new Map([["ag", tr("A", [a.task(), ...a.edit("s1", 5, 6, `${dir}b.js`)], "Write b")]]) }).prompts[0]!;
    // Subagent edit is floored at the call time (50) and slotted after the Agent call, remaining after the check.
    expect(p).toMatchObject({ status: "unchecked", partial: false, reason: "1 edit after last check (by subagent Write b)" });
    expect(p.files.map((f) => f.path)).toEqual([`${dir}b.js`]);
  });

  test("finding 1.2: parallel subagents sharing timestamp are ordered by parent call order, not agentId", () => {
    const makeRun = (editAgentId: string, testAgentId: string) => {
      const ed = agentLines(editAgentId);
      const te = agentLines(testAgentId);
      const lines = [
        prompt("q", { timestamp: at(0) }),
        agentCall("agEdit", at(10)),
        agentCall("agTest", at(10)),
      ];
      const tEdit = tr(editAgentId, [...ed.edit("e1", 20, 21, `${dir}b.js`)], "editor");
      const tTest = tr(testAgentId, te.check("c1", 20, 21), "tester");
      return analyzeSession(lines, { subagents: new Map([["agEdit", tEdit], ["agTest", tTest]]) }).prompts[0]!;
    };
    // Whether edit agent is "A" or "Z", call order (agEdit before agTest) ensures the check is after the edit.
    const resAZ = makeRun("A", "Z");
    const resZA = makeRun("Z", "A");
    expect(resAZ.status).toBe("checked");
    expect(resAZ.reason).toBe("pnpm test passed after last edit (by subagent tester)");
    expect(resZA.status).toBe("checked");
    expect(resZA.reason).toBe("pnpm test passed after last edit (by subagent tester)");
  });

  test("subagent check after the parent's edit => checked; failed subagent check => failing", () => {
    const a = agentLines("A");
    const lines = [prompt("q", { timestamp: at(0) }), ...edit("e1"), agentCall("ag", at(50))];
    const pass = analyzeSession(lines, { subagents: new Map([["ag", tr("A", a.check("c1", 60, 62), "Run tests")]]) }).prompts[0]!;
    expect(pass).toMatchObject({ status: "checked", reason: "pnpm test passed after last edit (by subagent Run tests)" });
    const fail = analyzeSession(lines, { subagents: new Map([["ag", tr("A", a.check("c1", 60, 62, 1), "Run tests")]]) }).prompts[0]!;
    expect(fail.status).toBe("failing");
    expect(fail.reason).toContain("(by subagent Run tests)");
  });

  test("the Fix phase is per thread: a failing check in one agent does not make another agent's work Fix", () => {
    const a = agentLines("A");
    const b = agentLines("B");
    const lines = [prompt("q", { timestamp: at(0) }), agentCall("agA", at(1)), agentCall("agB", at(1))];
    const ta = tr("A", [...a.check("c1", 2, 3, 1), a.use("ar", "Read", { file_path: "/x" }, at(4)), a.res("ar", "x", at(5))]);
    const tb = tr("B", [b.use("br", "Read", { file_path: "/x" }, at(4)), b.res("br", "x", at(5))]);
    const an = createAnalyzer({ detail: true, subagents: new Map([["agA", ta], ["agB", tb]]) });
    for (const l of lines) an.push(l);
    const steps = an.details()[0]!.steps;
    const phaseOf = (tool: string, summary: string) => steps.find((s) => s.actions.some((x) => x.tool === tool && x.summary === summary && x.ts !== null))?.phase;
    expect(steps.filter((s) => s.phase === "fix")).toHaveLength(1);
    expect(phaseOf("Read", "/x")).toBeDefined();
    const readSteps = steps.filter((s) => s.actions.some((x) => x.tool === "Read"));
    expect(readSteps.map((s) => s.phase).sort()).toEqual(["fix", "read"]);
  });

  test("parallel agents: intervals are united in the time split", () => {
    const a = agentLines("A");
    const b = agentLines("B");
    const lines = [prompt("q", { timestamp: at(0) }), agentCall("agA", at(0)), agentCall("agB", at(0))];
    const reads = (x: ReturnType<typeof agentLines>, p: string) => [x.use(`${p}1`, "Read", { file_path: "/x" }, at(10)), x.res(`${p}1`, "x", at(20))];
    const one = analyzeSession(lines, { subagents: new Map([["agA", tr("A", reads(a, "a"))]]) }).prompts[0]!;
    const two = analyzeSession(lines, { subagents: new Map([["agA", tr("A", reads(a, "a"))], ["agB", tr("B", reads(b, "b"))]]) }).prompts[0]!;
    expect(two.timeSplit.readMs).toBe(one.timeSplit.readMs);
    expect(two.activeMs).toBe(one.activeMs);
  });

  test("steps: subagent actions are marked and titles prefixed", () => {
    const a = agentLines("A");
    const an = createAnalyzer({ detail: true, subagents: new Map([["ag", tr("A", a.edit("s1", 5, 6))]]) });
    for (const l of [prompt("q", { timestamp: at(0) }), agentCall("ag", at(1))]) an.push(l);
    const steps = an.details()[0]!.steps;
    const sub = steps.find((s) => s.actions.some((x) => x.via === "subagent"))!;
    expect(sub.title.startsWith("Subagent: ")).toBe(true);
    expect(sub.actions.every((x) => x.via === "subagent")).toBe(true);
    expect(steps[0]!.title).not.toMatch(/partial/);
    expect(steps.flatMap((s) => s.actions).filter((x) => x.via === undefined).length).toBe(1);
  });

  test("addSubagent accepts lines and transcripts; an analyzer gets the same result both ways", () => {
    const a = agentLines("A");
    const sub = [a.task(), ...a.check("c1", 60, 62)];
    const lines = [prompt("q", { timestamp: at(0) }), ...edit("e1"), agentCall("ag", at(50))];
    const x = createAnalyzer();
    const y = createAnalyzer();
    for (const l of lines) {
      x.push(l);
      y.push(l);
    }
    x.addSubagent("ag", sub, { agentId: "A", description: "Run tests" });
    y.addSubagent("ag", tr("A", sub, "Run tests"));
    expect(JSON.stringify(x.finish())).toBe(JSON.stringify(y.finish()));
    expect(x.finish().prompts[0]!.status).toBe("checked");
  });

  test("a subagent from an earlier prompt's Agent call never affects other prompts", () => {
    const a = agentLines("A");
    const lines = [prompt("one", { timestamp: at(0) }), agentCall("ag", at(1)), prompt("two", { timestamp: at(10) }), ...edit("e2")];
    const ps = analyzeSession(lines, { subagents: new Map([["ag", tr("A", a.edit("s1", 3, 4))]]) }).prompts;
    expect(ps.map((p) => p.status)).toEqual(["unchecked", "unchecked"]);
    expect(ps[1]!.files).toHaveLength(1);
  });
});

describe("partial, suffixes and warnings", () => {
  const F = "/home/user/project/src/add.js";
  const base = (): string[] => [prompt("q", { timestamp: at(0) }), ...edit("e1"), ...bash("b1", "pnpm test"), agentCall("ag", at(50))];

  test("missing transcript: partial and 'not analysed' suffix", () => {
    const p = analyzeSession(base()).prompts[0]!;
    expect(p).toMatchObject({ partial: true, reason: "pnpm test passed after last edit; subagent activity not analysed" });
  });

  test("found transcript: not partial, no suffix", () => {
    const a = agentLines("A");
    const p = analyzeSession(base(), { subagents: new Map([["ag", tr("A", a.edit("s", 60, 61))]]) }).prompts[0]!;
    expect(p.partial).toBe(false);
    expect(p.reason).not.toContain("not analysed");
  });

  test("nesting beyond depth 3 is partial with the depth suffix; depth 3 is merged", () => {
    const mk = (id: string, nextCall: string | null, t: number): SubagentTranscript => {
      const x = agentLines(id);
      return tr(id, [...x.edit(`${id}e`, t, t + 1, F), ...(nextCall ? [x.use(nextCall, "Agent", { description: "d" }, at(t + 2))] : [])]);
    };
    const map = new Map<string, SubagentTranscript>([
      ["ag", mk("L1", "c2", 60)],
      ["c2", mk("L2", "c3", 70)],
      ["c3", mk("L3", "c4", 80)],
      ["c4", mk("L4", null, 90)],
    ]);
    const p = analyzeSession(base(), { subagents: map });
    expect(p.prompts[0]).toMatchObject({ partial: true, reason: expect.stringContaining("; subagent activity not analysed (depth > 3)") });
    expect(p.prompts[0]!.reason).not.toMatch(/analysed; /);
    // L1..L3 merged: three edits after the check + the parent's edit file; L4 not merged.
    expect(p.prompts[0]!.reason.startsWith("3 edits after last check")).toBe(true);
    expect(p.warnings).toEqual([]);
  });

  test("per-prompt event cap is applied while merging and has its own suffix", () => {
    const a = agentLines("A");
    const b = agentLines("B");
    const reads = (x: ReturnType<typeof agentLines>, p: string, count: number): string[] =>
      Array.from({ length: count }, (_, i) => x.use(`${p}${i}`, "Read", { file_path: "/x" }, at(60 + i / 1000)));
    const ta = tr("A", reads(a, "a", TRANSCRIPT_EVENTS_MAX));
    const tb = tr("B", [...reads(b, "b", 100), ...b.edit("beyond", 70, 71)]);
    const lines = [prompt("q", { timestamp: at(0) }), agentCall("agA", at(1)), agentCall("agB", at(1))];
    expect(PROMPT_SUBAGENT_EVENTS_MAX).toBe(TRANSCRIPT_EVENTS_MAX);
    const p = analyzeSession(lines, { subagents: new Map([["agA", ta], ["agB", tb]]) }).prompts[0]!;
    // A fills the whole budget; B's events are cut, so its edit never reaches the analysis.
    expect(p.files).toEqual([]);
    expect(p.reason).toContain("; subagent transcript truncated (event cap)");
    expect(p.partial).toBe(false);
  });

  test("a transcript truncated by its own event cap: event suffix; by text cap: text suffix", () => {
    const x = agentLines("A");
    const lines = [prompt("q", { timestamp: at(0) }), agentCall("ag", at(1))];
    const ev = analyzeSession(lines, { subagents: new Map([["ag", { ...tr("A", []), truncated: true, truncation: "events" as const }]]) }).prompts[0]!;
    expect(ev.reason).toContain("; subagent transcript truncated (event cap)");
    const tx = analyzeSession(lines, { subagents: new Map([["ag", { ...tr("A", x.edit("e", 5, 6)), truncated: true, truncation: "text" as const }]]) }).prompts[0]!;
    expect(tx.reason).toContain("; subagent transcript truncated (text cap)");
    expect(tx.reason).not.toContain("event cap");
  });

  test("an unmatched transcript is attributed to no prompt: warning only", () => {
    const a = agentLines("Orphan");
    const lines = [prompt("q", { timestamp: at(0) }), ...edit("e1"), ...bash("b1", "pnpm test")];
    const res = analyzeSession(lines, { file: "s.jsonl", subagents: new Map([["nope", tr("Orphan", a.edit("s", 1, 2))]]) });
    expect(res.prompts[0]).toMatchObject({ status: "checked", partial: false });
    expect(res.prompts[0]!.files).toHaveLength(1);
    expect(res.warnings).toEqual([{ file: "s.jsonl", line: 0, reason: "unmatched subagent Orphan" }]);
  });

  test("subagents are never read for sessions without Agent calls (streaming path unchanged)", () => {
    const lines = [prompt("a"), ...edit("e1"), prompt("b"), ...bash("b1", "pnpm test")];
    expect(JSON.stringify(analyzeSession(lines, { subagents: new Map() }))).toBe(JSON.stringify(analyzeSession(lines)));
  });
});

describe("determinism", () => {
  test("two runs and any order of the transcripts give the same result", () => {
    const a = agentLines("A");
    const b = agentLines("B");
    const c = agentLines("C");
    const lines = [prompt("q", { timestamp: at(0) }), ...edit("e1"), agentCall("agA", at(2)), agentCall("agB", at(2)), agentCall("agC", at(2)), ...bash("b1", "pnpm test"), prompt("two", { timestamp: at(100) })];
    const transcripts: [string, SubagentTranscript][] = [
      ["agA", tr("A", [...a.edit("a1", 5, 6, "/home/user/project/src/a.js"), ...a.check("ac", 7, 9)])],
      ["agB", tr("B", [...b.edit("b1", 5, 6, "/home/user/project/src/b.js"), ...b.check("bc", 7, 9, 1)])],
      ["agC", tr("C", [...c.edit("c1", 5, 6, "/home/user/project/src/c.js")])],
    ];
    const run = (order: number[], detail = false): string => {
      const an = createAnalyzer({ detail, subagents: new Map(order.map((i) => transcripts[i]!)) });
      for (const l of lines) an.push(l);
      return JSON.stringify([an.finish(), an.details()]);
    };
    const first = run([0, 1, 2]);
    expect(run([0, 1, 2])).toBe(first);
    for (const order of [[2, 1, 0], [1, 2, 0], [2, 0, 1]]) expect(run(order)).toBe(first);
    const d = run([0, 1, 2], true);
    expect(run([2, 0, 1], true)).toBe(d);
  });
});

describe("misc", () => {
  test("tool result lines are paired within a thread: equal tool ids in parent and subagent do not clash", () => {
    const a = agentLines("A");
    const lines = [prompt("q", { timestamp: at(0) }), agentCall("ag", at(1)), ...edit("same")];
    const t = tr("A", [a.use("same", "Read", { file_path: "/x" }, at(3)), a.res("same", "x", at(4))]);
    const p = analyzeSession(lines, { subagents: new Map([["ag", t]]) }).prompts[0]!;
    expect(p.files).toHaveLength(1);
  });
});

describe("continued agents (SendMessage)", () => {
  const dir = "/home/user/project/src/";
  const send = (id: string, to: string, ts: string, extra: Record<string, unknown> = {}): string => toolUse(id, "SendMessage", { to, message: "go on", summary: "s", ...extra }, ts);
  const sent = (id: string, ts: string, tur: Record<string, unknown> | undefined): string => toolResult(id, "Message sent.", { ts, ...(tur !== undefined ? { toolUseResult: tur } : {}) });
  const resumed = (id = "A") => ({ success: true, message: "resumed", pin: false, resumedAgentId: id });
  /** Run 0 edits a.js and passes the check; the continuation message starts the later run. */
  const run0 = (a: ReturnType<typeof agentLines>): string[] => [a.task(at(1)), ...a.edit("a1", 2, 3, `${dir}a.js`), ...a.check("c0", 4, 5)];
  const cont = (a: ReturnType<typeof agentLines>, t: number): string => a.task(at(t));
  const head = (): string[] => [prompt("one", { timestamp: at(0) }), agentCall("ag", at(1)), prompt("two", { timestamp: at(100) })];
  const analyse = (lines: string[], agent: string[]) => analyzeSession(lines, { subagents: new Map([["ag", tr("A", agent, "Worker")]]) }).prompts;

  test("(a) a continued run without a check belongs to the prompt that continued it", () => {
    const a = agentLines("A");
    const lines = [...head(), send("s1", "A", at(101)), sent("s1", at(102), resumed())];
    const ps = analyse(lines, [...run0(a), cont(a, 101.5), ...a.edit("b1", 103, 104, `${dir}b.js`)]);
    expect(ps[0]).toMatchObject({ status: "checked", reason: "pnpm test passed after last edit (by subagent Worker)" });
    expect(ps[0]!.files.map((f) => f.path)).toEqual([`${dir}a.js`]);
    expect(ps[1]!.status).toBe("unchecked");
    expect(ps[1]!.files.map((f) => f.path)).toEqual([`${dir}b.js`]);
    expect(ps.map((p) => p.partial)).toEqual([false, false]);
  });

  test("(b) a continued run that edits and checks makes the continuing prompt checked", () => {
    const a = agentLines("A");
    const lines = [...head(), send("s1", "A", at(101)), sent("s1", at(102), resumed())];
    const ps = analyse(lines, [...run0(a), cont(a, 101.5), ...a.edit("b1", 103, 104, `${dir}b.js`), ...a.check("c1", 105, 106)]);
    expect(ps[0]!.status).toBe("checked");
    expect(ps[1]).toMatchObject({ status: "checked", reason: "pnpm test passed after last edit (by subagent Worker)" });
    expect(ps[1]!.files.map((f) => f.path)).toEqual([`${dir}b.js`]);
  });

  test("(c) two sends in prompts 2 and 3 split the transcript into three runs", () => {
    const a = agentLines("A");
    const lines = [...head(), send("s1", "A", at(101)), sent("s1", at(102), resumed()), prompt("three", { timestamp: at(200) }), send("s2", "A", at(201)), sent("s2", at(202), resumed())];
    const agent = [...run0(a), cont(a, 101.5), ...a.edit("b1", 103, 104, `${dir}b.js`), ...a.check("c1", 105, 106), cont(a, 201.5), ...a.edit("c2", 203, 204, `${dir}c.js`)];
    const ps = analyse(lines, agent);
    expect(ps.map((p) => p.status)).toEqual(["checked", "checked", "unchecked"]);
    expect(ps.map((p) => p.files.map((f) => f.path))).toEqual([[`${dir}a.js`], [`${dir}b.js`], [`${dir}c.js`]]);
  });

  test("(d) a send to a team member or an unknown id changes nothing", () => {
    const a = agentLines("A");
    const base = [...head()];
    const agent = run0(a);
    const plain = analyse(base, agent);
    const lines = [...base, send("s1", "team-lead", at(101)), sent("s1", at(102), { success: true, message: "queued", pin: false }), send("s2", "zzz", at(103)), sent("s2", at(104), undefined)];
    const ps = analyse(lines, agent);
    expect(JSON.stringify(ps.map((p) => [p.status, p.files, p.partial]))).toBe(JSON.stringify(plain.map((p) => [p.status, p.files, p.partial])));
    expect(ps.map((p) => p.partial)).toEqual([false, false]);
  });

  test("(e) without resumedAgentId the input target decides; revivedAgentId counts too", () => {
    const a = agentLines("A");
    const agent = [...run0(a), cont(a, 101.5), ...a.edit("b1", 103, 104, `${dir}b.js`)];
    for (const tur of [{ success: true, message: "m", pin: false }, undefined, { success: true, message: "m", pin: false, revivedAgentId: "A" }]) {
      const ps = analyse([...head(), send("s1", "A", at(101)), sent("s1", at(102), tur)], agent);
      expect(ps.map((p) => p.status)).toEqual(["checked", "unchecked"]);
      expect(ps[1]!.files.map((f) => f.path)).toEqual([`${dir}b.js`]);
    }
    // the result's id wins over the input target
    const ps = analyse([...head(), send("s1", "someone", at(101)), sent("s1", at(102), resumed("A"))], agent);
    expect(ps[1]!.files).toHaveLength(1);
  });

  test("a send to an agent whose transcript is missing is partial only when the result says it was continued", () => {
    const withIds = analyzeSession([...head(), send("s1", "Q", at(101)), sent("s1", at(102), resumed("Q"))]).prompts;
    expect(withIds.map((p) => p.partial)).toEqual([true, true]); // prompt 1 has the missing Agent call as well
    const only = (tur: Record<string, unknown> | undefined) =>
      analyzeSession(
        [prompt("one", { timestamp: at(0) }), prompt("two", { timestamp: at(100) }), send("s1", "Q", at(101)), sent("s1", at(102), tur)],
        { subagents: new Map<string, SubagentTranscript>([["x", tr("Z", [])]]) },
      ).prompts[1]!;
    expect(only(resumed("Q")).partial).toBe(true);
    expect(only({ success: true, message: "m", pin: false }).partial).toBe(false);
  });

  test("the continued run's own sidechain message record is not a prompt", () => {
    const a = agentLines("A");
    const ps = analyse([...head(), send("s1", "A", at(101)), sent("s1", at(102), resumed())], [...run0(a), cont(a, 101.5), ...a.edit("b1", 103, 104, `${dir}b.js`)]);
    expect(ps).toHaveLength(2);
  });

  test("a send positioned before the Agent call that started the agent is ignored", () => {
    const a = agentLines("A");
    const lines = [prompt("one", { timestamp: at(0) }), send("s0", "A", at(0.5)), agentCall("ag", at(1))];
    const ps = analyse(lines, run0(a));
    expect(ps[0]).toMatchObject({ status: "checked" });
  });
});
