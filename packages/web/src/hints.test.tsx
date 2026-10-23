import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Hint, PromptAnalysis, PromptDetail } from "@lgtm/core";
import { Row } from "./PromptTable";
import { StepsView } from "./StepsView";
import { RecBadge } from "./Hints";
import { recommendationLabel, recommendationMarker, topHints } from "./viewmodel";

const evil = `<img src=x onerror=alert(1)> & "quoted" <script>boom()</script>`;

const hint = (over: Partial<Hint> = {}): Hint => ({ rule: "test-skipped", severity: "high", path: "/repo/src/a.test.ts", reason: "added 1 skip marker", ...over });

const prompt = (over: Partial<PromptAnalysis> = {}): PromptAnalysis => ({
  index: 0,
  uuid: "u",
  text: "Do it",
  status: "checked",
  reason: "pnpm test passed after last edit",
  files: [{ path: "/repo/src/a.test.ts", kind: "M", added: 1, removed: 0, maybeIncomplete: false }],
  partial: false,
  timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
  activeMs: 0,
  headline: "No timing data",
  hints: [hint()],
  recommendation: "read-flagged",
  ...over,
});

const detail = (over: Partial<PromptDetail> = {}): PromptDetail => ({
  index: 0,
  text: "Do it",
  status: "checked",
  reason: "ok",
  headline: "h",
  startedAt: null,
  activeMs: 0,
  truncated: false,
  hints: [],
  recommendation: "skim",
  steps: [],
  ...over,
});

const row = (p: PromptAnalysis, open = false): string => renderToStaticMarkup(<table><tbody><Row sessionId="s" p={p} open={open} onToggle={() => {}} /></tbody></table>);

describe("recommendation labels", () => {
  test("text and glyph differ per level, so color is not the only cue", () => {
    expect(["skim", "read-flagged", "read-all"].map((r) => recommendationLabel(r as never))).toEqual(["Skim", "Read flagged", "Read all"]);
    expect(new Set(["skim", "read-flagged", "read-all"].map((r) => recommendationMarker(r as never))).size).toBe(3);
    const html = renderToStaticMarkup(<RecBadge rec="read-all" />);
    expect(html).toContain("Read all");
    expect(html).toContain('class="rec rec-read-all"');
    expect(html).toContain('aria-hidden="true">●</span>');
    expect(html).toContain('title="Read all: several high-severity kinds of hints"');
  });
});

describe("prompt table row", () => {
  test("collapsed row shows the recommendation and the rule names", () => {
    const html = row(prompt());
    expect(html).toContain("Read flagged");
    expect(html).toContain(">test-skipped</span>");
    expect(html).not.toContain('class="hints"');
  });
  test("a prompt without hints shows only the label", () => {
    const html = row(prompt({ hints: [], recommendation: "skim" }));
    expect(html).toContain("Skim");
    expect(html).not.toContain("hint-marker");
  });
  test("collapsed cell lists at most 3 rules and counts the rest", () => {
    const rules = ["test-skipped", "assertions-removed", "sensitive-path", "large-change", "config-change"] as const;
    const html = row(prompt({ hints: rules.map((rule) => hint({ rule })) }));
    expect(html).toContain("+2");
  });
  test("expanded row lists severity, rule, path and reason with a labelled list", () => {
    const html = row(prompt({ hints: [hint({ severity: "warn", rule: "unchecked-edit", path: "/repo/x.ts", reason: "edited after the last check" }), hint()] }), true);
    expect(html).toContain('aria-label="Review hints (2)"');
    expect(html).toContain('aria-expanded="true"');
    expect(html.indexOf(">High<")).toBeLessThan(html.indexOf(">Warn<"));
    expect(html).toContain(">x.ts<"); // display path is shortened, like the file list
    expect(html).toContain("edited after the last check");
    // file list marks the flagged file with the rule name
    expect(html).toContain('class="marker hint-marker mono">test-skipped</span>');
  });
  test("a prompt-level hint is shown as such", () => {
    expect(row(prompt({ hints: [hint({ path: null, rule: "large-change" })] }), true)).toContain("(whole prompt)");
  });
  test("malicious reason, path and rule text is escaped, never parsed", () => {
    const html = row(prompt({ hints: [hint({ reason: evil, path: evil })], files: [{ path: evil, kind: "M", added: 1, removed: 1, maybeIncomplete: false }] }), true);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  test("the review column has a header cell in the table", () => {
    expect(row(prompt())).toContain('class="review"');
  });
});

describe("Where to look", () => {
  test("is a labelled section above the steps with the recommendation", () => {
    const html = renderToStaticMarkup(<StepsView sessionId="s" detail={detail({ hints: [hint()], recommendation: "read-flagged" })} />);
    expect(html).toContain('aria-labelledby="where-title"');
    expect(html).toContain('id="where-title"');
    expect(html).toContain("Where to look");
    expect(html).toContain("Read flagged");
    expect(html).toContain('aria-label="Top review hints (1 of 1)"');
    expect(html.indexOf("Where to look")).toBeLessThan(html.indexOf("No steps were recorded"));
  });
  test("shows the top 5 by severity then path and counts the rest", () => {
    const hints: Hint[] = [
      hint({ severity: "info", rule: "config-change", path: "/r/a" }),
      hint({ severity: "warn", rule: "unchecked-edit", path: "/r/b" }),
      hint({ severity: "high", rule: "sensitive-path", path: "/r/z" }),
      hint({ severity: "high", rule: "test-skipped", path: "/r/c" }),
      hint({ severity: "warn", rule: "public-surface", path: "/r/a" }),
      hint({ severity: "info", rule: "large-change", path: "/r/b" }),
      hint({ severity: "info", rule: "large-change", path: "/r/c" }),
    ];
    const { shown, hidden } = topHints(hints);
    expect(shown.map((h) => `${h.severity}:${h.path}`)).toEqual(["high:/r/c", "high:/r/z", "warn:/r/a", "warn:/r/b", "info:/r/a"]);
    expect(hidden).toBe(2);
    const html = renderToStaticMarkup(<StepsView sessionId="s" detail={detail({ hints })} />);
    expect(html).toContain("2 more hints in the session table");
    expect(html).toContain('aria-label="Top review hints (5 of 7)"');
  });
  test("no hints: states so, still no markup injection from hints", () => {
    expect(renderToStaticMarkup(<StepsView sessionId="s" detail={detail()} />)).toContain("No review hints for this prompt");
    const html = renderToStaticMarkup(<StepsView sessionId="s" detail={detail({ hints: [hint({ reason: evil, path: evil })] })} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;boom()&lt;/script&gt;");
  });
});
