import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { FileDiff, SessionAnalysis } from "@lgtm/core";
import { DiffView } from "./DiffView";
import { FileList } from "./PromptTable";
import { StepsView } from "./StepsView";
import { diffCounts, kindLabel, parseRoute, routeHref, shortPath } from "./viewmodel";

const evil = `<img src=x onerror=alert(1)> & "quoted" <script>boom()</script>`;

const diff = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: `/repo/${evil}.ts`,
  kind: "M",
  truncated: false,
  maybeIncomplete: false,
  hunks: [
    {
      header: `@@ -1,3 +1,3 @@ ${evil}`,
      lines: [
        { t: " ", s: evil },
        { t: "-", s: evil },
        { t: "+", s: evil },
        { t: " ", s: "" },
      ],
    },
    { header: "@@ -10,1 +10,1 @@", lines: [{ t: "+", s: "x".repeat(5000) }] },
  ],
  ...over,
});

describe("DiffView markup", () => {
  test("log content is escaped, never parsed as markup", () => {
    const html = renderToStaticMarkup(<DiffView sessionId="s" index={2} diff={diff()} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<pre");
  });
  test("prefix characters and classes mark added, removed and context lines", () => {
    const html = renderToStaticMarkup(<DiffView sessionId="s" index={0} diff={diff()} />);
    expect(html).toContain('<span class="dl dl-add"><span class="dp">+</span>');
    expect(html).toContain('<span class="dl dl-del"><span class="dp">-</span>');
    expect(html).toContain('<span class="dl dl-ctx"><span class="dp"> </span>');
    expect(html).toContain('class="dl dl-hunk">@@ -10,1 +10,1 @@');
  });
  test("banner always; incomplete and truncated notes only when flagged", () => {
    const plain = renderToStaticMarkup(<DiffView sessionId="s" index={0} diff={diff()} />);
    expect(plain).toContain("agent edits, not final git state");
    expect(plain).not.toContain("may be incomplete");
    expect(plain).not.toContain("truncated");
    const flagged = renderToStaticMarkup(<DiffView sessionId="s" index={0} diff={diff({ maybeIncomplete: true, truncated: true })} />);
    expect(flagged).toContain("may be incomplete (shell edits, removals and moves may be missing)");
    expect(flagged).toContain("truncated");
  });
  test("kind is a text label; counts and back link", () => {
    const html = renderToStaticMarkup(<DiffView sessionId="a b" index={4} diff={diff({ kind: "D" })} />);
    expect(html).toContain("Deleted");
    expect(html).toContain("+2 -1");
    expect(html).toContain("2 hunks");
    expect(html).toContain('href="#/session/a%20b/prompt/4"');
    expect(html).toContain("prompt 5");
  });
  test("no hunks shows an empty state without a pre", () => {
    const html = renderToStaticMarkup(<DiffView sessionId="s" index={0} diff={diff({ kind: "D", maybeIncomplete: true, hunks: [] })} />);
    expect(html).toContain("No changed lines were recorded");
    expect(html).not.toContain("<pre");
    expect(html).toContain("may be incomplete");
  });
});

describe("links into the diff", () => {
  const step = { n: 1, phase: "write" as const, title: "Edit", startedAt: null, durationMs: 0, quotes: [], actions: [], files: ["/repo/src/a b.ts", "/repo/lib/c.ts"] };
  const detail = { index: 0, text: "t", status: "unchecked" as const, reason: "r", headline: "h", startedAt: null, activeMs: 0, truncated: false, steps: [step] };
  test("step chips show the short path and open the exact path", () => {
    const html = renderToStaticMarkup(<StepsView sessionId="s" detail={detail} onOpenFile={() => {}} />);
    expect(html).toContain(">src/a b.ts<");
    expect(html).toContain(">lib/c.ts<");
    expect(html).toContain('title="Open diff of /repo/src/a b.ts"');
  });
  test("prompt row files link to the diff route with the exact path", () => {
    const session = {
      sessionId: "s", title: "T", branch: null, startedAt: null, warnings: [],
      prompts: [{
        index: 3, uuid: "u", text: "p", status: "unchecked", reason: "r", partial: false, activeMs: 0, headline: "h",
        timeSplit: { readMs: 0, writeMs: 0, checkMs: 0, fixMs: 0 },
        files: [{ path: "/repo/src/a b.ts", kind: "M", added: 1, removed: 0, maybeIncomplete: false }],
      }],
    } as unknown as SessionAnalysis;
    const html = renderToStaticMarkup(<FileList sessionId="s" p={session.prompts[0]!} />);
    expect(html).toContain('href="#/session/s/prompt/3/diff?path=%2Frepo%2Fsrc%2Fa%20b.ts"');
    expect(html).toContain(">src/a b.ts<");
    expect(routeHref({ kind: "diff", id: "s", index: 3, path: "/repo/src/a b.ts" })).toBe("#/session/s/prompt/3/diff?path=%2Frepo%2Fsrc%2Fa%20b.ts");
    expect(parseRoute("#/session/s/prompt/3/diff?path=%2Frepo%2Fsrc%2Fa%20b.ts")).toEqual({ kind: "diff", id: "s", index: 3, path: "/repo/src/a b.ts" });
  });
});

describe("view-model helpers", () => {
  test("shortPath strips the common directory of absolute paths only", () => {
    const all = ["/r/src/a.ts", "/r/src/sub/b.ts", "/r/src/c.ts"];
    expect(shortPath("/r/src/sub/b.ts", all)).toBe("sub/b.ts");
    expect(shortPath("/r/src/a.ts", all)).toBe("a.ts");
    expect(shortPath("/r/src/a.ts", ["/r/src/a.ts"])).toBe("src/a.ts");
    expect(shortPath("rel/x.ts", all)).toBe("rel/x.ts");
    expect(shortPath("/a.ts", ["/a.ts"])).toBe("a.ts");
    expect(shortPath("C:\\r\\x\\a.ts", ["C:\\r\\x\\a.ts", "C:\\r\\y\\b.ts"])).toBe("x/a.ts");
  });
  test("kindLabel and diffCounts", () => {
    expect([kindLabel("M"), kindLabel("A"), kindLabel("D")]).toEqual(["Modified", "Added", "Deleted"]);
    expect(diffCounts([{ lines: [{ t: "+" }, { t: "-" }, { t: " " }, { t: "+" }] }])).toEqual({ added: 2, removed: 1 });
  });
});
