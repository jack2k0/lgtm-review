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

const session = (id: string, title: string, attentionCount: number): SessionSummary => summary({ id, title, attentionCount });
const three = (): SessionSummary[] => [session("s-zero", "Zero session", 0), session("s-one", "One session", 1), session("s-four", "Four session", 4)];

describe("SessionList attention filter", () => {
  test("L1 header line counts sessions that need attention", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: three() }} />);
    expect(html).toContain("3 sessions for /repo · 2 sessions need attention");
  });

  test("L2 markers only on sessions whose prompts need attention", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: three() }} />);
    expect(html).toContain("1 prompt needs attention");
    expect(html).toContain("4 prompts need attention");
    expect((html.match(/class="marker"/g) ?? []).length).toBe(2);
  });

  test("L3 filter links and the active one", () => {
    const data = { dir: "/repo", sessions: three() };
    const all = renderToStaticMarkup(<SessionList data={data} />);
    const nav = all.slice(all.indexOf('<nav class="filters"'), all.indexOf("</nav>"));
    expect(nav).toContain('<a href="#/" aria-current="page">All (3)</a>');
    expect(nav).toContain('<a href="#/?show=attention">Needs attention (2)</a>');

    const filtered = renderToStaticMarkup(<SessionList data={data} show="attention" />);
    const filteredNav = filtered.slice(filtered.indexOf('<nav class="filters"'), filtered.indexOf("</nav>"));
    expect(filteredNav).toContain('<a href="#/">All (3)</a>');
    expect(filteredNav).toContain('<a href="#/?show=attention" aria-current="page">Needs attention (2)</a>');
  });

  test("L4 show=attention renders only the sessions that need attention", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: three() }} show="attention" />);
    expect(html).toContain("Showing 2 of 3 sessions.");
    expect(html).not.toContain("Zero session");
    expect(html).toContain("One session");
    expect(html).toContain("Four session");
  });

  test("L5 nothing needs attention says so instead of rendering a table", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: [session("s-zero", "Zero session", 0)] }} show="attention" />);
    expect(html).toContain("No sessions need attention.");
    expect(html).not.toContain("<table>");
  });

  test("L6 falls back to unchecked + failing without attentionCount", () => {
    const legacy = summary({ id: "s-legacy", title: "Legacy session", statusCounts: { checked: 2, unchecked: 1, failing: 1, "no-changes": 0 } });
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: [legacy] }} />);
    expect(html).toContain("2 prompts need attention");
  });
});
