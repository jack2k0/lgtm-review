import { describe, expect, test } from "vitest";
import type { SessionAnalysis } from "@lgtm/core";
import { formatText } from "./format.js";

function session(id: string, startedAt: string | null, extra: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return {
    sessionId: id,
    title: "A title",
    branch: "main",
    startedAt,
    prompts: [
      {
        index: 0,
        uuid: "u",
        text: "fix the bug",
        status: "failing",
        reason: "pnpm test failed: boom",
        files: [{ path: "src/a.ts", kind: "M", added: 3, removed: 1, maybeIncomplete: false }],
        partial: false,
        timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
        activeMs: 0,
        headline: "No timing data",
        hints: [],
        recommendation: "read-flagged",
      },
    ],
    warnings: [],
    ...extra,
  };
}

describe("formatText", () => {
  test("shows status, reason, files, counts", () => {
    const t = formatText([session("abcdef123456", "2026-01-01T00:00:00Z")], { color: false, dir: "/x" });
    expect(t).toContain("abcdef12");
    expect(t).toContain("1 prompt(s): 1 failing");
    expect(t).toContain("failing    fix the bug");
    expect(t).toContain("pnpm test failed: boom");
    expect(t).toContain("M src/a.ts +3 -1");
    expect(t).not.toContain("\u001b[");
  });

  test("colors only when asked", () => {
    expect(formatText([session("a", null)], { color: true, dir: "/x" })).toContain("\u001b[31m");
  });

  test("newest session first", () => {
    const t = formatText([session("old11111", "2026-01-01T00:00:00Z"), session("new22222", "2026-02-01T00:00:00Z")], {
      color: false,
      dir: "/x",
    });
    expect(t.indexOf("new22222")).toBeLessThan(t.indexOf("old11111"));
  });

  test("inherited prompts are marked and left out of the counts", () => {
    const base = session("abcdef123456", "2026-01-01T00:00:00Z").prompts[0]!;
    const s = session("abcdef123456", "2026-01-01T00:00:00Z", { prompts: [{ ...base, inheritedFrom: "01234567-aaaa" }, { ...base, index: 1, uuid: "v", status: "checked" }] });
    const t = formatText([s], { color: false, dir: "/x" });
    expect(t).toContain("1 prompt(s): 1 checked (+1 inherited from 01234567)");
    expect(t).toContain("fix the bug (inherited from 01234567)");
    expect(t.match(/inherited from/g)).toHaveLength(2);
  });

  test("shows [worktree <label>] in the header except for . or unset", () => {
    const f = (extra: Partial<SessionAnalysis>) => formatText([session("wt111111", "2026-01-01T00:00:00Z", extra)], { color: false, dir: "/x" });
    expect(f({ worktree: "../wt" })).toContain("2026-01-01T00:00:00Z [worktree ../wt]");
    expect(f({ worktree: "." })).not.toContain("[worktree");
    expect(f({})).not.toContain("[worktree");
  });

  test("appends (archived) to the session header when archived: true", () => {
    const t = formatText([session("arch11111", "2026-01-01T00:00:00Z", { archived: true })], { color: false, dir: "/x" });
    expect(t).toContain("arch1111  A title  [main]  2026-01-01T00:00:00Z (archived)");
  });

  test("warnings capped at 20", () => {
    const warnings = Array.from({ length: 25 }, (_, i) => ({ file: "f.jsonl", line: i + 1, reason: "bad" }));
    const t = formatText([session("a", null, { warnings })], { color: false, dir: "/x" });
    expect(t).toContain("Warnings (25)");
    expect(t).toContain("… and 5 more");
    expect(t.match(/f\.jsonl:/g)).toHaveLength(20);
  });
});
