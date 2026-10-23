import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { PromptDetail } from "@lgtm/core";
import { StepsView } from "./StepsView";

const evil = `<img src=x onerror=alert(1)> & "quoted" <script>boom()</script>`;

const detail = (over: Partial<PromptDetail> = {}): PromptDetail => ({
  index: 2,
  text: evil,
  status: "failing",
  reason: evil,
  headline: evil,
  startedAt: "2026-01-02T03:04:05Z",
  activeMs: 65_000,
  truncated: false,
  steps: [
    {
      n: 1,
      phase: "fix",
      title: evil,
      startedAt: null,
      durationMs: 1200,
      check: { command: evil, exitCode: 1, passed: false, excerpt: evil },
      quotes: [evil],
      actions: [{ tool: evil, summary: evil, ok: false, ts: "2026-01-02T03:04:06Z" }],
      files: [evil],
    },
  ],
  ...over,
});

describe("StepsView markup", () => {
  test("log content is escaped, never parsed as markup", () => {
    const html = renderToStaticMarkup(<StepsView sessionId="s" detail={detail()} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("exit 1");
    expect(html).toContain("1 action");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Fix");
  });
  test("header, back link and truncated banner", () => {
    const html = renderToStaticMarkup(<StepsView sessionId="a b" detail={detail({ truncated: true, text: "Do it" })} />);
    expect(html).toContain('href="#/session/a%20b"');
    expect(html).toContain("Prompt 3: Do it");
    expect(html).toContain("large");
    expect(renderToStaticMarkup(<StepsView sessionId="s" detail={detail()} />)).not.toContain("large");
  });
  test("empty steps show an empty state", () => {
    expect(renderToStaticMarkup(<StepsView sessionId="s" detail={detail({ steps: [] })} />)).toContain("No steps were recorded");
  });
  test("file chips are disabled until a diff handler exists", () => {
    expect(renderToStaticMarkup(<StepsView sessionId="s" detail={detail()} />)).toContain("disabled");
    expect(renderToStaticMarkup(<StepsView sessionId="s" detail={detail()} onOpenFile={() => {}} />)).not.toContain("disabled");
  });
});
