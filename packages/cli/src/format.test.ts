import { describe, expect, test } from "vitest";
import { Analysis } from "@lgtm/core";
import type { SessionAnalysis } from "@lgtm/core";
import { formatText, redactAnalysis } from "./format.js";

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

  test("redacts prompt text, title, reason, files, warnings by default", () => {
    const s = session("abcdef123456", "2026-01-01T00:00:00Z", {
      title: "Fix password=hunter2secret",
      prompts: [
        {
          index: 0,
          uuid: "u",
          text: "fix with password=hunter2secret",
          status: "failing",
          reason: "check failed with token=ghp_123456789012345678901234567890",
          files: [{ path: "src/secret-pass.ts", kind: "M", added: 1, removed: 0, maybeIncomplete: false }],
          partial: false,
          timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
          activeMs: 0,
          headline: "No timing data",
          hints: [],
          recommendation: "read-flagged",
        },
      ],
      warnings: [{ file: "f.jsonl", line: 1, reason: "warning with password=hunter2secret" }],
    });
    const def = formatText([s], { color: false, dir: "/x" });
    expect(def).not.toContain("hunter2secret");
    expect(def).not.toContain("ghp_");
    expect(def).toContain("[redacted:secret]");

    const raw = formatText([s], { color: false, dir: "/x", raw: true });
    expect(raw).toContain("hunter2secret");
    expect(raw).toContain("ghp_123456789012345678901234567890");
  });

  test("redactAnalysis redacts string fields and preserves exempt fields", () => {
    const a = {
      dir: "/home/user/project",
      sessions: [
        session("abcdef123456", "2026-01-01T00:00:00Z", {
          title: "Fix password=hunter2secret",
          prompts: [
            {
              index: 0,
              uuid: "u-1234",
              text: "fix with password=hunter2secret",
              status: "failing",
              reason: "pnpm test failed with password=hunter2secret",
              files: [{ path: "src/a.ts", kind: "M", added: 1, removed: 0, maybeIncomplete: false }],
              partial: false,
              timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
              activeMs: 0,
              headline: "headline",
              hints: [{ rule: "check-scope", severity: "warn", path: "src/a.ts", reason: "password=hunter2secret" }],
              recommendation: "read-flagged",
            },
          ],
        }),
      ],
    };
    const redacted = redactAnalysis(a, { usernames: ["user"], repoDir: "/home/user/project" });
    expect(redacted.dir).toBe("/home/user/project");
    expect(redacted.sessions[0]?.sessionId).toBe("abcdef123456");
    expect(redacted.sessions[0]?.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(redacted.sessions[0]?.prompts[0]?.status).toBe("failing");
    expect(redacted.sessions[0]?.prompts[0]?.uuid).toBe("u-1234");
    expect(redacted.sessions[0]?.prompts[0]?.hints[0]?.rule).toBe("check-scope");
    expect(redacted.sessions[0]?.prompts[0]?.hints[0]?.severity).toBe("warn");
    expect(redacted.sessions[0]?.prompts[0]?.recommendation).toBe("read-flagged");
    expect(JSON.stringify(redacted)).not.toContain("hunter2secret");
    expect(JSON.stringify(redacted)).toContain("[redacted:secret]");
    expect(() => Analysis.parse(redacted)).not.toThrow();
  });
});

describe("redacted branch name", () => {
  test("a secret in the branch name does not reach --list output", () => {
    const secret = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const session = { sessionId: "s1", title: "t", branch: secret, startedAt: null, prompts: [], warnings: [] } as unknown as SessionAnalysis;
    expect(formatText([session], { color: false, dir: "/r" })).not.toContain(secret);
  });
});

describe("log-supplied metadata", () => {
  const secret = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const session = { sessionId: "s1", title: "t", branch: "main", startedAt: secret, prompts: [{ index: 0, uuid: secret, text: "x", reason: "r", status: "no-changes", files: [] }], warnings: [] } as unknown as SessionAnalysis;

  test("a secret in the timestamp does not reach --list output", () => {
    expect(formatText([session], { color: false, dir: "/r" })).not.toContain(secret);
  });

  test("a secret in startedAt or uuid does not reach --json output", () => {
    expect(JSON.stringify(redactAnalysis({ dir: "/r", sessions: [session] }))).not.toContain(secret);
  });

  test("a normal timestamp and uuid stay readable", () => {
    const ts = "2026-10-01T10:00:00.000Z";
    const uuid = "00000000-0000-4000-8000-000000000001";
    const ok = { ...session, startedAt: ts, prompts: [{ ...session.prompts[0], uuid }] } as unknown as SessionAnalysis;
    const out = JSON.stringify(redactAnalysis({ dir: "/r", sessions: [ok] }));
    expect(out).toContain(ts);
    expect(out).toContain(uuid);
  });
});
