// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import type { GitCrosscheckResponse } from "@lgtm/core";
import { App } from "./App";
import { GitView } from "./GitView";
import { PromptTable } from "./PromptTable";
import { SessionList } from "./SessionList";
import { click, mount, press } from "./testing/dom";
import { makePrompt, makeSession, makeSummary } from "./testing/fixtures";

const TOKEN = "t".repeat(32);

async function mountAt(hash: string): Promise<HTMLElement> {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
  window.location.hash = hash;
  return mount(<App token={TOKEN} />);
}

describe("escape one level up", () => {
  test("Escape on Steps goes to the session page; an input and Ctrl do not", async () => {
    try {
      const hash = "#/session/s1/prompt/2";
      await mountAt(hash);
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      await press("Escape", {}, input);
      expect(window.location.hash).toBe(hash);
      input.remove();
      await press("Escape", { ctrlKey: true }, document.body);
      expect(window.location.hash).toBe(hash);
      await press("Escape", {}, document.body);
      expect(window.location.hash).toBe("#/session/s1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("Escape on the session map goes to the session page", async () => {
    try {
      await mountAt("#/session/s1/map");
      await press("Escape", {}, document.body);
      expect(window.location.hash).toBe("#/session/s1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("Escape on a prompt map goes to the session page", async () => {
    try {
      await mountAt("#/session/s1/prompt/2/map");
      await press("Escape", {}, document.body);
      expect(window.location.hash).toBe("#/session/s1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("Escape on Git goes to the session page", async () => {
    try {
      await mountAt("#/session/s1/git");
      await press("Escape", {}, document.body);
      expect(window.location.hash).toBe("#/session/s1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("Escape on Diff goes to Steps, and not while typing", async () => {
    try {
      const hash = "#/session/s1/prompt/4/diff?path=src%2Fa.ts";
      await mountAt(hash);
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      await press("Escape", {}, input);
      expect(window.location.hash).toBe(hash);
      input.remove();
      await press("Escape", {}, document.body);
      expect(window.location.hash).toBe("#/session/s1/prompt/4");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("Play does not take the one-level-up handler", async () => {
    try {
      const hash = "#/session/s1/prompt/2/play";
      await mountAt(hash);
      await press("Escape", {}, document.body);
      expect(window.location.hash).toBe(hash);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("table scroll", () => {
  test("prompt table, session list and git view put every table inside .table-scroll", async () => {
    const prompt = await mount(
      <PromptTable session={makeSession([makePrompt(0), makePrompt(1, { inheritedFrom: "abcdef01", text: "from earlier" })])} />,
    );
    await click(prompt.querySelector("button.inherited-toggle")!);
    const promptTables = prompt.querySelectorAll("table");
    expect(promptTables.length).toBe(2);
    for (const table of promptTables) expect(table.closest(".table-scroll")).not.toBeNull();

    const list = await mount(<SessionList data={{ dir: "/repo", sessions: [makeSummary()] }} />);
    const listTables = list.querySelectorAll("table");
    expect(listTables.length).toBe(1);
    for (const table of listTables) expect(table.closest(".table-scroll")).not.toBeNull();

    const gitData: GitCrosscheckResponse = {
      sessionId: "s",
      available: true,
      ref: "main",
      since: null,
      until: null,
      commitCount: 0,
      uncommitted: [{ path: "src/a.ts", status: "M", inLog: false }],
      committed: [],
      notInGit: [],
      outsideRepo: 0,
      truncated: false,
      notes: [],
    };
    const git = await mount(<GitView data={gitData} />);
    const gitTables = git.querySelectorAll("table");
    expect(gitTables.length).toBe(1);
    for (const table of gitTables) expect(table.closest(".table-scroll")).not.toBeNull();
  });
});
