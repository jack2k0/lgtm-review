// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { GitCrosscheckResponse } from "@lgtm/core";
import { GitView } from "./GitView";
import { click, mount } from "./testing/dom";

function makeGit(over: Partial<GitCrosscheckResponse> = {}): GitCrosscheckResponse {
  return {
    sessionId: "sess-1",
    available: true,
    ref: "main",
    since: "2026-01-01T09:50:00.000Z",
    until: "2026-01-01T11:10:00.000Z",
    commitCount: 1,
    uncommitted: [],
    committed: [],
    notInGit: [],
    outsideRepo: 0,
    truncated: false,
    notes: [],
    ...over,
  };
}

describe("GitView", () => {
  test("unavailable shows only note text and no table", () => {
    const data = makeGit({
      available: false,
      notes: ["Not a git repository, or git is not available."],
    });
    const html = renderToStaticMarkup(<GitView data={data} />);
    expect(html).toContain("Not a git repository, or git is not available.");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Changed in git but not in the log");
  });

  test("two not-in-log entries render heading count and where text", () => {
    const data = makeGit({
      uncommitted: [{ path: "uncommitted.txt", status: "M", inLog: false }],
      committed: [{ path: "committed.txt", status: "A", inLog: false }],
    });
    const html = renderToStaticMarkup(<GitView data={data} />);
    expect(html).toContain("Changed in git but not in the log (2)");
    expect(html).toContain("uncommitted.txt");
    expect(html).toContain("committed.txt");
    expect(html).toContain("uncommitted");
    expect(html).toContain("committed in the window");
  });

  test("in-log entries are not in table and are counted in appear in both", () => {
    const data = makeGit({
      uncommitted: [{ path: "a.txt", status: "M", inLog: true }],
      committed: [
        { path: "a.txt", status: "A", inLog: true },
        { path: "b.txt", status: "M", inLog: true },
      ],
    });
    const html = renderToStaticMarkup(<GitView data={data} />);
    expect(html).toContain("Nothing: every file git shows was edited by this session.");
    expect(html).toContain("2 files appear in both.");
    expect(html).not.toContain("<td>a.txt</td>");
  });

  test("notInGit list and its heading count; empty lists show Nothing texts", () => {
    const empty = makeGit({ uncommitted: [], committed: [], notInGit: [] });
    const emptyHtml = renderToStaticMarkup(<GitView data={empty} />);
    expect(emptyHtml).toContain("Nothing: every file git shows was edited by this session.");
    expect(emptyHtml).toContain("Nothing.");
    expect(emptyHtml).toContain("Edited in the log but not changed in git (0)");

    const filled = makeGit({ notInGit: ["x.txt", "y.txt"] });
    const filledHtml = renderToStaticMarkup(<GitView data={filled} />);
    expect(filledHtml).toContain("Edited in the log but not changed in git (2)");
    expect(filledHtml).toContain("x.txt");
    expect(filledHtml).toContain("y.txt");
  });

  test("outsideRepo: 2 and truncated: true lines appear; ref: null shows Commits were not read.", () => {
    const data = makeGit({
      outsideRepo: 2,
      truncated: true,
      ref: null,
    });
    const html = renderToStaticMarkup(<GitView data={data} />);
    expect(html).toContain("2 edited files outside the repository were not compared.");
    expect(html).toContain("Lists were cut at 2000 files or 500 commits.");
    expect(html).toContain("Commits were not read.");
  });

  test("log-derived text with html is escaped as plain text", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const data = makeGit({
      notInGit: [evil],
      notes: [evil],
      uncommitted: [{ path: evil, status: "M", inLog: false }],
    });
    const html = renderToStaticMarkup(<GitView data={data} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("clicking Refresh invokes onRefresh", async () => {
    let clicked = false;
    const container = await mount(
      <GitView data={makeGit()} onRefresh={() => { clicked = true; }} />,
    );
    const btn = container.querySelector("button.more");
    expect(btn).not.toBeNull();
    await click(btn!);
    expect(clicked).toBe(true);
  });

  test("table headers have scope=col for accessibility", () => {
    const data = makeGit({
      uncommitted: [{ path: "uncommitted.txt", status: "M", inLog: false }],
    });
    const html = renderToStaticMarkup(<GitView data={data} />);
    expect(html).toContain('<th scope="col">Path</th>');
    expect(html).toContain('<th scope="col">Where</th>');
    expect(html).toContain('<th scope="col">Status</th>');
  });
});
