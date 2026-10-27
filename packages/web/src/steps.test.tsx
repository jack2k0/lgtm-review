import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { PromptDetail } from "@lgtm/core";
import { StepCard } from "./StepCard";
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
  hints: [],
  recommendation: "skim",
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
  test("subagent actions get a marker; the title prefix is shown; log content stays escaped", () => {
    const d = detail();
    d.steps[0] = { ...d.steps[0]!, title: `Subagent: ${evil}`, actions: [{ tool: evil, summary: evil, ok: true, ts: null, via: "subagent" }, { tool: "Read", summary: "x", ok: true, ts: null }] };
    const html = renderToStaticMarkup(<StepsView sessionId="s" detail={d} />);
    expect(html).toContain("Subagent: &lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    // Actions are collapsed by default: open the card to render them.
    const open = renderToStaticMarkup(<StepCard step={d.steps[0]!} open={true} onToggle={() => {}} />);
    expect(open.match(/title="Made by a subagent">subagent<\/span>/g)).toHaveLength(1);
    expect(open).not.toContain("<img");
    expect(open).not.toContain("<script");
  });
  test("a background check gets a text marker, a foreground one does not", () => {
    const d = detail();
    const check = { command: "npm test", exitCode: 0, passed: true, excerpt: "" };
    const bg = renderToStaticMarkup(<StepCard step={{ ...d.steps[0]!, check: { ...check, background: true } }} open={false} onToggle={() => {}} />);
    expect(bg).toContain("passed</span> (background)");
    const fg = renderToStaticMarkup(<StepCard step={{ ...d.steps[0]!, check }} open={false} onToggle={() => {}} />);
    expect(fg).not.toContain("(background)");
  });
  test("a stopped background check renders as stopped", () => {
    const d = detail();
    const html = renderToStaticMarkup(<StepCard step={{ ...d.steps[0]!, check: { command: "npm test", exitCode: null, passed: null, excerpt: "", background: true, stopped: true } }} open={false} onToggle={() => {}} />);
    expect(html).toContain("stopped</span> (background)");
    expect(html).not.toContain("did not run");
  });
  test("empty steps show an empty state", () => {
    expect(renderToStaticMarkup(<StepsView sessionId="s" detail={detail({ steps: [] })} />)).toContain("No steps were recorded");
  });
  test("file chips are disabled until a diff handler exists", () => {
    expect(renderToStaticMarkup(<StepsView sessionId="s" detail={detail()} />)).toContain("disabled");
    expect(renderToStaticMarkup(<StepsView sessionId="s" detail={detail()} onOpenFile={() => {}} />)).not.toContain("disabled");
  });
  test("SHELL_EDIT_FILE file chip is disabled in StepCard even when onOpenFile is provided", () => {
    const s = {
      n: 1,
      phase: "write" as const,
      title: "edit",
      startedAt: null,
      durationMs: 100,
      quotes: [],
      actions: [],
      files: ["(shell edit)", "src/a.ts"],
    };
    const html = renderToStaticMarkup(<StepCard step={s} open={false} onToggle={() => {}} onOpenFile={() => {}} />);
    expect(html).toContain('disabled="" title="Diff not available for shell edits">(shell edit)</button>');
  });
});
