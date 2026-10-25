import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { PromptAnalysis, SessionAnalysis, SessionSummary } from "@lgtm/core";
import { PromptTable } from "./PromptTable";
import { SessionList } from "./SessionList";
import { hasWorktrees, worktreeLabels, worktreeName } from "./worktree";

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "sess12345678",
  title: "Session",
  branch: "feature/test",
  startedAt: "2026-01-01T12:00:00Z",
  promptCount: 4,
  statusCounts: { checked: 3, unchecked: 1, failing: 0, "no-changes": 0 },
  warningCount: 0,
  inheritedCount: 0,
  ...over,
});

describe("worktree helpers", () => {
  test("labels: '.' first, then sorted; sessions without a label count as '.'", () => {
    expect(worktreeLabels([{ worktree: "../wt" }, {}, { worktree: ".claude/worktrees/x" }, { worktree: "." }])).toEqual([".", "../wt", ".claude/worktrees/x"]);
    expect(worktreeLabels([{ worktree: "../b" }, { worktree: "../a" }])).toEqual(["../a", "../b"]);
    expect(worktreeLabels([])).toEqual([]);
  });

  test("hasWorktrees needs two distinct labels", () => {
    expect(hasWorktrees([])).toBe(false);
    expect(hasWorktrees([{}, { worktree: "." }])).toBe(false);
    expect(hasWorktrees([{ worktree: "../wt" }, { worktree: "../wt" }])).toBe(false);
    expect(hasWorktrees([{}, { worktree: "../wt" }])).toBe(true);
  });

  test("worktreeName", () => {
    expect(worktreeName(".")).toBe("main checkout");
    expect(worktreeName("../wt")).toBe("../wt");
  });
});

const two = (): SessionSummary[] => [
  summary({ id: "s-main", title: "Main session", worktree: "." }),
  summary({ id: "s-wt", title: "Worktree session", worktree: "../wt", statusCounts: { checked: 0, unchecked: 0, failing: 2, "no-changes": 0 }, attentionCount: 2 }),
];

describe("SessionList with worktrees", () => {
  test("one worktree renders the S-17 markup (no column, no worktree filter)", () => {
    const sessions = [summary({ worktree: "." }), summary({ id: "other", worktree: "." })];
    const withLabel = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions }} worktree="." />);
    const without = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: [summary(), summary({ id: "other" })] }} />);
    expect(withLabel).toBe(without);
    expect(withLabel).not.toContain("Worktree");
    expect(withLabel).not.toContain("Filter by worktree");
    expect(withLabel).not.toContain("Showing");
  });

  test("two worktrees: column, labels and worktree links", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: two() }} />);
    expect(html).toContain('<th scope="col">Worktree</th>');
    expect(html).toContain(">main checkout<");
    expect(html).toContain(">../wt<");
    const nav = html.slice(html.indexOf('<nav class="filters" aria-label="Filter by worktree"'), html.indexOf("</nav>"));
    expect(nav).toContain('<a href="#/" aria-current="page">All worktrees</a>');
    expect(nav).toContain('<a href="#/?worktree=.">main checkout</a>');
    expect(nav).toContain('<a href="#/?worktree=..%2Fwt">../wt</a>');
  });

  test("worktree filter shows only that worktree and counts it", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: two() }} worktree="../wt" />);
    expect(html).toContain("Worktree session");
    expect(html).not.toContain("Main session");
    expect(html).toContain("Showing 1 of 2 sessions.");
    expect(html).toContain("1 session for /repo");
    const nav = html.slice(html.indexOf('<nav class="filters" aria-label="Filter by worktree"'), html.indexOf("</nav>"));
    expect(nav).toContain('<a href="#/">All worktrees</a>');
    expect(nav).toContain('<a href="#/?worktree=..%2Fwt" aria-current="page">../wt</a>');
  });

  test("attention links keep the worktree; worktree links keep show=attention", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: two() }} worktree="../wt" />);
    expect(html).toContain('<a href="#/?worktree=..%2Fwt" aria-current="page">All (1)</a>');
    expect(html).toContain('<a href="#/?show=attention&amp;worktree=..%2Fwt">Needs attention (1)</a>');

    const att = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: two() }} show="attention" />);
    expect(att).toContain('<a href="#/?show=attention" aria-current="page">All worktrees</a>');
    expect(att).toContain('<a href="#/?show=attention&amp;worktree=.">main checkout</a>');
    expect(att).toContain('<a href="#/?show=attention&amp;worktree=..%2Fwt">../wt</a>');
    expect(att).toContain("Showing 2 of 2 sessions.");
  });

  test("a worktree with no sessions in the filter says so", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: two() }} worktree="../gone" />);
    expect(html).toContain("No sessions in this worktree.");
    expect(html).not.toContain("<table>");
  });
});

const prompt = (index: number): PromptAnalysis => ({
  index,
  uuid: `u${index}`,
  text: `Prompt ${index}`,
  status: "checked",
  reason: "ok",
  files: [],
  partial: false,
  timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
  activeMs: 0,
  headline: "No timing data",
  hints: [],
  recommendation: "skim",
});

const analysis = (over: Partial<SessionAnalysis> = {}): SessionAnalysis => ({
  sessionId: "sess-1",
  title: "Session",
  branch: "feature/x",
  startedAt: null,
  prompts: [prompt(0)],
  warnings: [],
  ...over,
});

describe("PromptTable session header with worktrees", () => {
  test("names the worktree after the branch", () => {
    const html = renderToStaticMarkup(<PromptTable session={analysis({ worktree: "../wt" })} />);
    expect(html).toContain("· worktree ../wt");
    expect(html.indexOf("feature/x")).toBeLessThan(html.indexOf("· worktree ../wt"));
  });

  test("the main checkout is named as such", () => {
    const html = renderToStaticMarkup(<PromptTable session={analysis({ worktree: "." })} />);
    expect(html).toContain("· main checkout");
    expect(html).not.toContain("· worktree");
  });

  test("nothing is added when the worktree is unset", () => {
    const html = renderToStaticMarkup(<PromptTable session={analysis()} />);
    expect(html).not.toContain("main checkout");
    expect(html).not.toContain("· worktree");
  });
});
