import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { PromptAnalysis, SessionAnalysis, SessionSummary } from "@lgtm/core";
import { PromptTable } from "./PromptTable";
import { SessionList } from "./SessionList";

const prompt = (index: number, over: Partial<PromptAnalysis> = {}): PromptAnalysis => ({
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
  ...over,
});

const session = (): SessionAnalysis => ({
  sessionId: "sess-own",
  title: "Own session",
  branch: "main",
  startedAt: null,
  prompts: [
    prompt(0),
    prompt(1),
    prompt(2, { text: "inherited alpha", inheritedFrom: "abcdef0123456789" }),
    prompt(3, { text: "inherited beta", inheritedFrom: "abcdef0123456789" }),
    prompt(4, { text: "inherited gamma", inheritedFrom: "abcdef0123456789" }),
  ],
  warnings: [],
});

describe("inherited prompts in the prompt table", () => {
  test("header counts own prompts and inherited prompts", () => {
    const html = renderToStaticMarkup(<PromptTable session={session()} />);
    expect(html).toContain("2 prompts + 3 inherited");
  });

  test("toggle is collapsed by default and the inherited rows are not rendered", () => {
    const html = renderToStaticMarkup(<PromptTable session={session()} />);
    expect(html).toMatch(/<button[^>]*class="inherited-toggle"[^>]*aria-expanded="false"/);
    expect(html).toContain("3 inherited prompts from abcdef01");
    expect(html).not.toContain("inherited alpha");
    expect(html).not.toContain("inherited beta");
    expect(html).toContain("Prompt 0");
  });

  test("no inherited prompts: no header suffix and no toggle", () => {
    const s = session();
    s.prompts = s.prompts.slice(0, 2);
    const html = renderToStaticMarkup(<PromptTable session={s} />);
    expect(html).toContain("2 prompts");
    expect(html).not.toContain("inherited");
  });
});

describe("session list inherited count", () => {
  const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
    id: "s1",
    title: "Session one",
    branch: "main",
    startedAt: null,
    promptCount: 2,
    statusCounts: { checked: 2, unchecked: 0, failing: 0, "no-changes": 0 },
    warningCount: 0,
    inheritedCount: 3,
    ...over,
  });

  test("shows the inherited count with spaces around the plus", () => {
    const html = renderToStaticMarkup(<SessionList data={{ dir: "/repo", sessions: [summary()] }} />);
    expect(html).toContain("+ 3 inherited");
  });
});
