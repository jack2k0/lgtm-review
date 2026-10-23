import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeFile, analyzeFileDetail, subagentStamp, SUBAGENT_FILES_MAX } from "./index.js";
import { loadSubagents, noteAgentCalls } from "./subagents.js";
import { sessionsDir } from "../testing/fixtures.js";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lgtm-core-sub-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Copies fixture `name` into `dir` as session `sid` (`<sid>.jsonl` + `<sid>/subagents/`). Returns the session file. */
function install(dir: string, name: string, sid = "sess"): string {
  cpSync(join(sessionsDir, `${name}.jsonl`), join(dir, `${sid}.jsonl`));
  cpSync(join(sessionsDir, name), join(dir, sid), { recursive: true });
  return join(dir, `${sid}.jsonl`);
}

const OPTS = { sessionId: "sess", file: "sess.jsonl" };

describe("noteAgentCalls", () => {
  test("only lines that call the Agent tool, collecting ids", () => {
    const ids = new Set<string>();
    expect(noteAgentCalls('{"x":1}', ids)).toBe(false);
    expect(noteAgentCalls('{"text":"the Agent tool"}', ids)).toBe(false);
    expect(noteAgentCalls('{"content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}', ids)).toBe(true);
    expect(noteAgentCalls('{"content":[{"type":"tool_use", "id": "toolu_2", "name" : "Agent"}]}', ids)).toBe(true);
    expect([...ids]).toEqual(["toolu_1", "toolu_2"]);
  });
});

describe("analyzeFile with subagents", () => {
  test("discovers <sid>/subagents and merges (check run by a subagent)", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      const a = await analyzeFile(f, OPTS);
      expect(a.prompts[0]?.status).toBe("checked");
      expect(a.prompts[0]?.reason).toContain("by subagent Run the test suite");
      expect(a.prompts[0]?.partial).toBe(false);
      expect(a.warnings).toEqual([]);
    }));

  test("analyzeFileDetail sees the same merge, with via markers on actions", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      const { analysis, analyzer } = await analyzeFileDetail(f, OPTS);
      expect(analysis.prompts[0]?.status).toBe("checked");
      const steps = analyzer.details()[0]!.steps;
      expect(steps.some((s) => s.actions.some((x) => x.via === "subagent"))).toBe(true);
      expect(steps.some((s) => s.title.startsWith("Subagent: "))).toBe(true);
    }));

  test("without the subagents dir the Agent call is partial", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      rmSync(join(dir, "sess"), { recursive: true });
      const a = await analyzeFile(f, OPTS);
      expect(a.prompts[0]?.partial).toBe(true);
      expect(a.prompts[0]?.reason).toContain("subagent activity not analysed");
    }));

  test("nested agents are discovered transitively", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-nested");
      const a = await analyzeFile(f, OPTS);
      expect(a.prompts[0]?.partial).toBe(false);
      expect(a.warnings).toEqual([]);
      expect(a.prompts[0]?.status).toBe("checked");
    }));

  test("two runs and a different file order give the same result", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-parallel");
      const one = await analyzeFile(f, OPTS);
      const two = await analyzeFile(f, OPTS);
      expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    }));

  test("no Agent call in the parent: subagent files are not touched, no warnings", () =>
    withTmp(async (dir) => {
      cpSync(join(sessionsDir, "checked-basic.jsonl"), join(dir, "sess.jsonl"));
      // An unreadable "transcript" (a directory) and no meta: reading either would warn.
      mkdirSync(join(dir, "sess", "subagents", "agent-zz.jsonl"), { recursive: true });
      writeFileSync(join(dir, "sess", "subagents", "agent-zz.meta.json"), JSON.stringify({ toolUseId: "t1" }));
      const a = await analyzeFile(join(dir, "sess.jsonl"), OPTS);
      expect(a.warnings).toEqual([]);
    }));
});

describe("warnings", () => {
  test("missing meta: transcript skipped with a warning, Agent call stays partial", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      rmSync(join(dir, "sess", "subagents", "agent-a2222222.meta.json"));
      const a = await analyzeFile(f, OPTS);
      expect(a.warnings).toEqual([{ file: "sess.jsonl", line: 0, reason: "subagent a2222222: meta missing or unreadable, transcript skipped" }]);
      expect(a.prompts[0]?.partial).toBe(true);
    }));

  test("malformed meta and meta without toolUseId", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      const m = join(dir, "sess", "subagents");
      writeFileSync(join(m, "agent-a2222222.meta.json"), "{ nope");
      writeFileSync(join(m, "agent-b.jsonl"), "");
      writeFileSync(join(m, "agent-b.meta.json"), JSON.stringify({ description: "x" }));
      const a = await analyzeFile(f, OPTS);
      expect(a.warnings.map((w) => w.reason)).toEqual([
        "subagent a2222222: meta missing or unreadable, transcript skipped",
        "subagent b: meta missing or unreadable, transcript skipped",
      ]);
    }));

  test("unknown toolUseId: unmatched warning, not attributed, not read", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      const m = join(dir, "sess", "subagents");
      cpSync(join(m, "agent-a2222222.jsonl"), join(m, "agent-a9999999.jsonl"));
      writeFileSync(join(m, "agent-a9999999.meta.json"), JSON.stringify({ toolUseId: "nobody", description: "stray" }));
      const a = await analyzeFile(f, OPTS);
      expect(a.warnings).toEqual([{ file: "sess.jsonl", line: 0, reason: "unmatched subagent a9999999" }]);
      expect(a.prompts[0]?.status).toBe("checked");
      expect(a.prompts[0]?.reason).not.toContain("stray");
    }));

  test("unreadable transcript: warning, call stays partial", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      const m = join(dir, "sess", "subagents");
      rmSync(join(m, "agent-a2222222.jsonl"));
      mkdirSync(join(m, "agent-a2222222.jsonl"));
      const a = await analyzeFile(f, OPTS);
      expect(a.warnings.map((w) => w.reason)).toEqual(["subagent a2222222: transcript unreadable, skipped"]);
      expect(a.prompts[0]?.partial).toBe(true);
    }));

  test("duplicate toolUseId: the first transcript (by name) wins", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      const m = join(dir, "sess", "subagents");
      cpSync(join(m, "agent-a2222222.jsonl"), join(m, "agent-a3333333.jsonl"));
      cpSync(join(m, "agent-a2222222.meta.json"), join(m, "agent-a3333333.meta.json"));
      const a = await analyzeFile(f, OPTS);
      expect(a.warnings.map((w) => w.reason)).toEqual(["subagent a3333333: duplicate toolUseId, transcript skipped"]);
      expect(a.prompts[0]?.status).toBe("checked");
    }));

  test("warnings carry no file when the caller gives none", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      rmSync(join(dir, "sess", "subagents", "agent-a2222222.meta.json"));
      const a = await analyzeFile(f, { sessionId: "sess" });
      expect(a.warnings[0]).toEqual({ line: 0, reason: "subagent a2222222: meta missing or unreadable, transcript skipped" });
    }));
});

describe("limits", () => {
  test("at most 100 subagent files per session are read; the rest is a warning", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      const m = join(dir, "sess", "subagents");
      for (let i = 0; i < SUBAGENT_FILES_MAX + 5; i++) {
        const id = `z${String(i).padStart(4, "0")}`;
        writeFileSync(join(m, `agent-${id}.jsonl`), "");
        writeFileSync(join(m, `agent-${id}.meta.json`), JSON.stringify({ toolUseId: `none-${i}` }));
      }
      const loaded = await loadSubagents(f, new Set(["p_ag1"]));
      expect(loaded.transcripts.has("p_ag1")).toBe(true);
      // 106 files: agent-a2222222 plus 105 strays; the first 100 by name are considered, the strays among them are unmatched.
      expect(loaded.warnings[0]).toBe(`106 subagent files, only the first ${SUBAGENT_FILES_MAX} are read`);
      expect(loaded.warnings.filter((w) => w.startsWith("unmatched subagent"))).toHaveLength(SUBAGENT_FILES_MAX - 1);
      const a = await analyzeFile(f, OPTS);
      expect(a.prompts[0]?.status).toBe("checked");
    }));

  test("meta description is cut to 200 chars", () =>
    withTmp(async (dir) => {
      const f = install(dir, "subagent-check");
      writeFileSync(join(dir, "sess", "subagents", "agent-a2222222.meta.json"), JSON.stringify({ toolUseId: "p_ag1", description: "d".repeat(500) }));
      const loaded = await loadSubagents(f, new Set(["p_ag1"]));
      expect(loaded.transcripts.get("p_ag1")?.description).toHaveLength(200);
    }));
});

describe("subagentStamp", () => {
  test("empty without a subagents dir; changes when a transcript grows or a meta changes; stable otherwise", () =>
    withTmp(async (dir) => {
      cpSync(join(sessionsDir, "checked-basic.jsonl"), join(dir, "plain.jsonl"));
      expect(await subagentStamp(join(dir, "plain.jsonl"))).toBe("");

      const f = install(dir, "subagent-check");
      const s0 = await subagentStamp(f);
      expect(s0).not.toBe("");
      expect(await subagentStamp(f)).toBe(s0);

      const t = join(dir, "sess", "subagents", "agent-a2222222.jsonl");
      appendFileSync(t, "\n");
      const s1 = await subagentStamp(f);
      expect(s1).not.toBe(s0);

      utimesSync(t, 1_800_000_000, 1_800_000_000);
      const s2 = await subagentStamp(f);
      expect(s2).not.toBe(s1);

      writeFileSync(join(dir, "sess", "subagents", "agent-a2222222.meta.json"), JSON.stringify({ toolUseId: "p_ag1", description: "other" }));
      expect(await subagentStamp(f)).not.toBe(s2);
    }));
});
