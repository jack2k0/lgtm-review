import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { SessionSummary } from "@lgtm/core";
import { SessionList } from "./SessionList";

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "sess12345678",
  title: "My session title",
  branch: "feature/test",
  startedAt: "2026-01-01T12:00:00Z",
  promptCount: 4,
  statusCounts: { checked: 3, unchecked: 1, failing: 0, "no-changes": 0 },
  warningCount: 0,
  inheritedCount: 0,
  ...over,
});

describe("SessionList", () => {
  test("empty list renders empty message", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: [] }} />);
    expect(html).toContain("No sessions found for /repo");
  });

  test("live session does not show archived badge", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: [summary()] }} />);
    expect(html).toContain("My session title");
    expect(html).not.toContain("archived");
  });

  test("archived session renders the archived badge with tooltip", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: [summary({ archived: true })] }} />);
    expect(html).toContain("My session title");
    expect(html).toContain('class="badge muted"');
    expect(html).toContain('title="Original log deleted by Claude Code; read from the lgtm-review archive"');
    expect(html).toContain(">archived<");
  });
});
