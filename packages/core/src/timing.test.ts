import { beforeEach, describe, expect, test } from "vitest";
import { analyzeSession } from "./analyze.js";
import { PromptAnalysis } from "./schema.js";
import { makeHeadline, unionMs } from "./timing.js";
import { listFixtures, readFixtureLines } from "./testing/fixtures.js";
import { F, at, patchResult, prompt, resetIds, toolResult, toolUse } from "./testing/records.js";

beforeEach(resetIds);

type Ts = string | null;
const read = (id: string, use: Ts, res: Ts, name = "Read"): string[] => [
  toolUse(id, name, { file_path: F }, use),
  toolResult(id, "ok", { ts: res }),
];
const edit = (id: string, use: Ts, res: Ts, isError = false): string[] => [
  toolUse(id, "Edit", { file_path: F, old_string: "a", new_string: "b" }, use),
  isError
    ? toolResult(id, "Error: nope", { isError: true, ts: res })
    : toolResult(id, "File updated.", { toolUseResult: patchResult(["b"], ["a"]), ts: res }),
];
const sh = (id: string, command: string, use: Ts, res: Ts, exit = 0): string[] => [
  toolUse(id, "Bash", { command }, use),
  exit === 0
    ? toolResult(id, "ok", { ts: res })
    : toolResult(id, `Exit code ${exit}\nfailed`, { isError: true, ts: res }),
];

const run = (lines: string[]) => analyzeSession(lines).prompts[0]!;
const split = (p: { timeSplit: unknown }) => p.timeSplit;

describe("time split", () => {
  test("sequential read, write, check: think time goes to the next action", () => {
    const p = run([prompt("q", { timestamp: at(0) }), ...read("r", at(2), at(5)), ...edit("e", at(6), at(8)), ...sh("c", "pnpm test", at(8), at(18))]);
    // read: [0,2]+[2,5]=5 s, write: [5,6]+[6,8]=3 s, check: [8,8]+[8,18]=10 s
    expect(split(p)).toEqual({ readMs: 5000, writeMs: 3000, checkMs: 10000, fixMs: 0 });
    expect(p.activeMs).toBe(18000);
    expect(p.headline).toBe("Mostly checking (56%), 1 check");
    expect(PromptAnalysis.safeParse(p).success).toBe(true);
  });

  test("no timestamps at all => zeros and 'No timing data'", () => {
    const p = run([prompt("q", { timestamp: null }), ...read("r", null, null), ...edit("e", null, null)]);
    expect(split(p)).toEqual({ readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 });
    expect(p.activeMs).toBe(0);
    expect(p.headline).toBe("No timing data");
  });

  test("prompt without tool calls => no timing data", () => {
    const p = run([prompt("q", { timestamp: at(0) })]);
    expect(p).toMatchObject({ activeMs: 0, headline: "No timing data" });
  });

  test("missing timestamps inherit the previous known one", () => {
    // read use inherits 0 (think 0), result at 3 => exec 3 s; edit result inherits 4 => exec 0, think [3,4]=1 s
    const p = run([prompt("q", { timestamp: at(0) }), ...read("r", null, at(3)), ...edit("e", at(4), null)]);
    expect(split(p)).toEqual({ readMs: 3000, writeMs: 1000, checkMs: 0, fixMs: 0 });
    expect(p.activeMs).toBe(4000);
  });

  test("think gap of exactly 5 min counts, longer is excluded entirely", () => {
    const within = run([prompt("q", { timestamp: at(0) }), ...read("r", at(300), at(302))]);
    expect(within.timeSplit.readMs).toBe(302000);
    const over = run([prompt("q", { timestamp: at(0) }), ...read("r", at(301), at(303))]);
    // only the 2 s exec time remains; the 301 s wait is not counted (not even capped)
    expect(over.timeSplit.readMs).toBe(2000);
    expect(over.activeMs).toBe(2000);
  });

  test("exec time of exactly 10 min counts, longer is excluded", () => {
    const within = run([prompt("q", { timestamp: at(0) }), ...sh("c", "pnpm build", at(10), at(610))]);
    expect(within.timeSplit.checkMs).toBe(610000);
    const over = run([prompt("q", { timestamp: at(0) }), ...sh("c", "pnpm build", at(10), at(611))]);
    expect(over.timeSplit.checkMs).toBe(10000);
  });

  test("parallel calls are merged, not double counted", () => {
    // a: [0,1]+[1,4], b: think [1,1] empty + exec [1,6] => union [0,6]
    const p = run([
      prompt("q", { timestamp: at(0) }),
      toolUse("a", "Read", { file_path: F }, at(1)),
      toolUse("b", "Grep", { pattern: "x" }, at(1)),
      toolResult("a", "ok", { ts: at(4) }),
      toolResult("b", "ok", { ts: at(6) }),
    ]);
    expect(p.timeSplit.readMs).toBe(6000);
    expect(p.activeMs).toBe(6000);
  });

  test("overlapping phases: activeMs is the union, phase values may sum to more", () => {
    const p = run([
      prompt("q", { timestamp: at(0) }),
      toolUse("r", "Read", { file_path: F }, at(1)),
      toolUse("w", "Edit", { file_path: F, old_string: "a", new_string: "b" }, at(1)),
      toolResult("w", "File updated.", { toolUseResult: patchResult(["b"], ["a"]), ts: at(2) }),
      toolResult("r", "ok", { ts: at(4) }),
    ]);
    // read: [0,1]+[1,4]=4 s; write: think [1,1] empty (the read call is the previous event) + exec [1,2]=1 s
    expect(split(p)).toEqual({ readMs: 4000, writeMs: 1000, checkMs: 0, fixMs: 0 });
    expect(p.activeMs).toBe(4000);
    expect(p.headline).toBe("Mostly reading (80%), 0 checks");
  });

  test("non-monotonic timestamps: negative deltas count as 0, overlaps are merged", () => {
    // read1: [0,2]+exec(2->1)=0 ; next read: think [1,4]=3, exec [4,5]=1 ; union [0,2] u [1,5] = 5 s
    const p = run([prompt("q", { timestamp: at(0) }), ...read("r1", at(2), at(1)), ...read("r2", at(4), at(5))]);
    expect(p.timeSplit.readMs).toBe(5000);
    expect(p.activeMs).toBe(5000);
    // use earlier than the previous event: no think time
    const q = run([prompt("q", { timestamp: at(10) }), ...read("r", at(8), at(12))]);
    expect(q.timeSplit.readMs).toBe(4000);
  });

  test("a result without matching call or a call without result adds nothing", () => {
    const p = run([prompt("q", { timestamp: at(0) }), toolUse("a", "Read", { file_path: F }, at(1)), toolResult("zzz", "ok", { ts: at(3) })]);
    expect(p).toMatchObject({ activeMs: 0, headline: "No timing data" });
  });

  test("tool classification: bash read, bash edit, check, unclassified tools", () => {
    const bashEdit = [
      toolUse("be", "Bash", { command: "sed -i s/a/b/ f" }, at(7)),
      toolResult("be", "ok", {
        ts: at(9),
        toolUseResult: { bashEditDiff: { files: [{ filePath: F, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] }] } },
      }),
    ];
    const p = run([
      prompt("q", { timestamp: at(0) }),
      ...sh("ls", "ls -la", at(1), at(2)), // read: [0,2]
      ...read("g", at(3), at(4), "Glob"), // read: [2,4]
      ...read("wf", at(4), at(5), "WebFetch"), // read: [4,5]
      ...read("todo", at(5), at(6), "TodoWrite"), // unclassified: nothing
      ...bashEdit, // write: think [6,7] + exec [7,9]
      ...sh("c", "pnpm lint", at(9), at(10)), // check: [9,10]
      ...read("ag", at(11), at(20), "Agent"), // unclassified: nothing
    ]);
    expect(split(p)).toEqual({ readMs: 5000, writeMs: 3000, checkMs: 1000, fixMs: 0 });
    expect(p.activeMs).toBe(9000);
    expect(p.headline).toBe("Mostly reading (56%), 1 check");
  });

  test("a failed edit tool call still counts as Write time", () => {
    const p = run([prompt("q", { timestamp: at(0) }), ...edit("e", at(1), at(3), true)]);
    expect(split(p)).toEqual({ readMs: 0, writeMs: 3000, checkMs: 0, fixMs: 0 });
  });

  test("work after a failed check is Fix until the next passing check", () => {
    const p = run([
      prompt("q", { timestamp: at(0) }),
      ...edit("e1", at(1), at(2)), // write [0,2] = 2
      ...sh("c1", "pnpm test", at(2), at(4), 1), // check [2,4] = 2 (fails)
      ...read("r", at(5), at(6)), // fix [4,6] = 2
      ...edit("e2", at(6), at(8)), // fix [6,8] = 2
      ...sh("c2", "pnpm test", at(8), at(9)), // check [8,9] = 1 (passes, stays Check)
      ...read("r2", at(10), at(11)), // read [9,11] = 2
    ]);
    expect(split(p)).toEqual({ readMs: 2000, writeMs: 2000, checkMs: 3000, fixMs: 4000 });
    expect(p.activeMs).toBe(11000);
    expect(p.headline).toBe("Mostly fixing (36%), 2 checks");
  });

  test("a second failing check re-enters Fix; a failing state does not leak into the next prompt", () => {
    const p = analyzeSession([
      prompt("one", { timestamp: at(0) }),
      ...edit("e1", at(1), at(2)),
      ...sh("c1", "pnpm test", at(2), at(3), 1),
      ...sh("c2", "pnpm test", at(3), at(4)), // pass
      ...read("r1", at(5), at(6)), // read
      ...sh("c3", "pnpm test", at(6), at(7), 2), // fail again
      ...read("r2", at(8), at(9)), // fix
      prompt("two", { timestamp: at(100) }),
      ...read("r3", at(101), at(102)), // new prompt: read, not fix
    ]);
    expect(p.prompts[0]!.timeSplit).toEqual({ readMs: 2000, writeMs: 2000, checkMs: 3000, fixMs: 2000 });
    expect(p.prompts[1]!.timeSplit).toEqual({ readMs: 2000, writeMs: 0, checkMs: 0, fixMs: 0 });
  });

  test("the status rule is unaffected by timestamps", () => {
    const lines = [prompt("q", { timestamp: at(0) }), ...edit("e", at(1), at(2)), ...sh("c", "pnpm test", at(3), at(4))];
    const noTs = [prompt("q", { timestamp: null }), ...edit("e", null, null), ...sh("c", "pnpm test", null, null)];
    expect(run(lines).status).toBe("checked");
    expect(run(noTs).status).toBe("checked");
  });
});

describe("headline", () => {
  const z = { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 };
  test("no data", () => {
    expect(makeHeadline(z, 0, 3)).toBe("No timing data");
  });
  test("largest phase, rounded share, singular and plural checks", () => {
    expect(makeHeadline({ ...z, writeMs: 62, readMs: 38 }, 100, 1)).toBe("Mostly writing (62%), 1 check");
    expect(makeHeadline({ ...z, readMs: 2, checkMs: 1 }, 3, 0)).toBe("Mostly reading (67%), 0 checks");
    expect(makeHeadline({ ...z, fixMs: 5, checkMs: 1 }, 6, 2)).toBe("Mostly fixing (83%), 2 checks");
  });
  test("ties resolve in the order write, read, check, fix", () => {
    expect(makeHeadline({ readMs: 5, writeMs: 5, checkMs: 5, fixMs: 5 }, 20, 0)).toBe("Mostly writing (25%), 0 checks");
    expect(makeHeadline({ ...z, readMs: 5, checkMs: 5 }, 10, 0)).toBe("Mostly reading (50%), 0 checks");
    expect(makeHeadline({ ...z, checkMs: 5, fixMs: 5 }, 10, 1)).toBe("Mostly checking (50%), 1 check");
  });
});

describe("unionMs", () => {
  test("merges overlapping, touching and nested intervals", () => {
    expect(unionMs([])).toBe(0);
    expect(unionMs([[0, 10]])).toBe(10);
    expect(unionMs([[5, 8], [0, 3], [2, 4]])).toBe(7);
    expect(unionMs([[0, 10], [2, 3], [10, 12]])).toBe(12);
    expect(unionMs([[0, 1], [5, 6]])).toBe(2);
  });
});

describe("fixture timing-split (hand-computed)", () => {
  const lines = readFixtureLines("timing-split");
  const a = analyzeSession(lines, { sessionId: "timing-split" });
  const expected = [
    // P0: read [0,5]=5, write [5,8]=3, 400 s wait excluded, check exec 10
    { split: { readMs: 5000, writeMs: 3000, checkMs: 10000, fixMs: 0 }, activeMs: 18000, headline: "Mostly checking (56%), 1 check" },
    // P1: write 1+1, check 3 (fail) + 4 (pass), fix: read 1+1 and edit 0+3
    { split: { readMs: 0, writeMs: 2000, checkMs: 7000, fixMs: 5000 }, activeMs: 14000, headline: "Mostly checking (50%), 2 checks" },
    // P2: two parallel reads union [0,6]=6 (not 9), write 1+2
    { split: { readMs: 6000, writeMs: 3000, checkMs: 0, fixMs: 0 }, activeMs: 9000, headline: "Mostly reading (67%), 0 checks" },
    // P3: read [0,4]=4, write [4,6]=2 (negative exec = 0), read [5,9]=4 overlaps write => active 9 < sum 10
    { split: { readMs: 8000, writeMs: 2000, checkMs: 0, fixMs: 0 }, activeMs: 9000, headline: "Mostly reading (80%), 0 checks" },
    // P4: missing timestamps inherit: read 0+3, write 1+0, check 0+2
    { split: { readMs: 3000, writeMs: 1000, checkMs: 2000, fixMs: 0 }, activeMs: 6000, headline: "Mostly reading (50%), 1 check" },
    // P5: no tool calls
    { split: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 }, activeMs: 0, headline: "No timing data" },
  ];

  test("covers every prompt", () => {
    expect(a.prompts.length).toBe(expected.length);
    expect(listFixtures()).toContain("timing-split");
  });

  test.each(expected.map((e, i) => [i, e] as const))("prompt %i", (i, e) => {
    const p = a.prompts[i]!;
    expect(p.timeSplit).toEqual(e.split);
    expect(p.activeMs).toBe(e.activeMs);
    expect(p.headline).toBe(e.headline);
  });
});
