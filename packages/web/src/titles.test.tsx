// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LiveContext } from "./LiveView";
import { PromptTable, Row } from "./PromptTable";
import { click } from "./testing/dom";
import { makePrompt, makeSession } from "./testing/fixtures";
import { TITLES_POLL_MS, shouldPollTitles, titleForPrompt } from "./titles";
import { resolveToken, sessionStore } from "./token";
import type { SessionAnalysis } from "@lgtm/core";
import { renderToStaticMarkup } from "react-dom/server";

const TOKEN = "t".repeat(32);

interface TitlesBody {
  enabled: boolean;
  titles: Record<string, string>;
  pending: number;
  error: string | null;
}

const roots: { root: Root; el: HTMLElement }[] = [];

async function render(node: ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  roots.push({ root, el });
  await act(async () => {
    root.render(node);
  });
  return {
    el,
    async rerender(next: ReactNode) {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      el.remove();
      const at = roots.findIndex((r) => r.root === root);
      if (at >= 0) roots.splice(at, 1);
    },
  };
}

function Harness({ paused, session, token, show = "all" }: { paused: boolean; session: SessionAnalysis; token?: string | null; show?: "all" | "attention" }) {
  return (
    <LiveContext.Provider value={{ paused, report: () => {} }}>
      <PromptTable session={session} token={token} show={show} />
    </LiveContext.Provider>
  );
}

function install(handler: (n: number) => TitlesBody) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(handler(calls.length)), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  for (const r of roots.splice(0)) {
    await act(async () => r.root.unmount());
    r.el.remove();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  Reflect.deleteProperty(document, "hidden");
});

describe("title helpers", () => {
  test("own prompts only, and polling only while work remains without an error", () => {
    expect(TITLES_POLL_MS).toBe(3_000);
    expect(titleForPrompt(undefined, makePrompt(0))).toBeNull();
    expect(titleForPrompt({ "0": "" }, makePrompt(0))).toBeNull();
    expect(titleForPrompt({ "0": "Added a parser" }, makePrompt(0))).toBe("Added a parser");
    expect(titleForPrompt({ "1": "Nope" }, makePrompt(1, { inheritedFrom: "abcdef0123456789" }))).toBeNull();
    expect(shouldPollTitles(null)).toBe(false);
    expect(shouldPollTitles({ enabled: false, pending: 3, error: null })).toBe(false);
    expect(shouldPollTitles({ enabled: true, pending: 0, error: null })).toBe(false);
    expect(shouldPollTitles({ enabled: true, pending: 2, error: "model server not reachable" })).toBe(false);
    expect(shouldPollTitles({ enabled: true, pending: 2, error: null })).toBe(true);
  });

  test("a row refuses a title for an inherited prompt", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <Row sessionId="s" p={makePrompt(1, { inheritedFrom: "abcdef0123456789", text: "from earlier" })} open={false} onToggle={() => {}} generated="Should stay hidden" />
        </tbody>
      </table>,
    );
    expect(html).toContain("from earlier");
    expect(html).not.toContain("Should stay hidden");
    expect(html).not.toContain("gen-label");
  });
});

describe("prompt table titles", () => {
  test("enabled false renders nothing and schedules no poll", async () => {
    const calls = install(() => ({ enabled: false, titles: { "0": "Secret title" }, pending: 4, error: "model server not reachable" }));
    const view = await render(<Harness paused={false} session={makeSession([makePrompt(0)])} token={TOKEN} />);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("api/sessions/sess-own/titles");
    expect(calls[0]!.init.headers).toEqual({ "X-Lgtm-Token": TOKEN });
    expect(view.el.querySelector(".gen-label")).toBeNull();
    expect(view.el.querySelector(".gen-title")).toBeNull();
    expect(view.el.querySelector(".titles-error")).toBeNull();
    expect(view.el.textContent).not.toContain("Secret title");
    expect(view.el.textContent).not.toContain("generated");
    await advance(10_000);
    expect(calls).toHaveLength(1);
  });

  test("no token renders nothing and does not request titles", async () => {
    const calls = install(() => ({ enabled: true, titles: { "0": "Nope" }, pending: 1, error: null }));
    const view = await render(<Harness paused={false} session={makeSession([makePrompt(0)])} token={null} />);
    expect(calls).toHaveLength(0);
    expect(view.el.querySelector(".gen-label")).toBeNull();
    await advance(10_000);
    expect(calls).toHaveLength(0);
  });

  test("a stored token is sent when the table is not given one", async () => {
    resolveToken(`#k=${TOKEN}`, sessionStore());
    const calls = install(() => ({ enabled: true, titles: { "0": "From storage" }, pending: 0, error: null }));
    const view = await render(<PromptTable session={makeSession([makePrompt(0)])} />);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers).toEqual({ "X-Lgtm-Token": TOKEN });
    expect(view.el.textContent).toContain("From storage");
    expect(view.el.querySelector(".gen-label")?.textContent).toBe("generated");
  });

  test("titles render above the prompt with the generated label", async () => {
    install(() => ({ enabled: true, titles: { "0": "Added a parser" }, pending: 0, error: null }));
    const view = await render(<Harness paused={false} session={makeSession([makePrompt(0, { text: "do the thing" })])} token={TOKEN} />);
    const gen = view.el.querySelector(".gen-title");
    const label = view.el.querySelector(".gen-label");
    const prompt = view.el.querySelector(".text");
    expect(gen?.textContent).toContain("Added a parser");
    expect(label?.textContent).toBe("generated");
    expect(label?.getAttribute("title")).toBe("Generated by the local model; may be wrong");
    expect(prompt?.textContent).toBe("do the thing");
    expect(gen!.compareDocumentPosition(prompt!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await advance(10_000);
  });

  test("a title is plain text", async () => {
    install(() => ({ enabled: true, titles: { "0": "<b>bold</b>" }, pending: 0, error: null }));
    const view = await render(<Harness paused={false} session={makeSession([makePrompt(0)])} token={TOKEN} />);
    const gen = view.el.querySelector(".gen-title");
    expect(gen?.querySelector("b")).toBeNull();
    expect(gen?.textContent).toContain("<b>bold</b>");
  });

  test("pending above zero polls again and zero stops", async () => {
    const calls = install((n): TitlesBody => n === 1
      ? { enabled: true, titles: {}, pending: 1, error: null }
      : { enabled: true, titles: { "0": "Added a parser" }, pending: 0, error: null });
    const view = await render(<Harness paused={false} session={makeSession([makePrompt(0)])} token={TOKEN} />);
    expect(calls).toHaveLength(1);
    await advance(2_999);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
    expect(view.el.textContent).toContain("Added a parser");
    await advance(10_000);
    expect(calls).toHaveLength(2);
  });

  test("an error is one muted line under the table and stops polling", async () => {
    const calls = install(() => ({ enabled: true, titles: {}, pending: 3, error: "<i>model server not reachable</i>" }));
    const view = await render(<Harness paused={false} session={makeSession([makePrompt(0)])} token={TOKEN} />);
    const err = view.el.querySelector(".titles-error");
    const table = view.el.querySelector("table.prompts");
    expect(err?.classList.contains("muted")).toBe(true);
    expect(err?.textContent).toBe("<i>model server not reachable</i>");
    expect(err?.querySelector("i")).toBeNull();
    expect(view.el.querySelectorAll(".titles-error")).toHaveLength(1);
    expect(table!.compareDocumentPosition(err!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await advance(10_000);
    expect(calls).toHaveLength(1);
  });

  test("an inherited prompt never shows a title", async () => {
    install(() => ({ enabled: true, titles: { "0": "Did the thing", "1": "Should stay hidden" }, pending: 0, error: null }));
    const session = makeSession([
      makePrompt(0, { text: "do the thing" }),
      makePrompt(1, { text: "from earlier", inheritedFrom: "abcdef0123456789" }),
    ]);
    const view = await render(<Harness paused={false} session={session} token={TOKEN} />);
    expect(view.el.textContent).toContain("Did the thing");
    expect(view.el.textContent).not.toContain("Should stay hidden");
    await click(view.el.querySelector("button.inherited-toggle")!);
    expect(view.el.textContent).toContain("from earlier");
    expect(view.el.textContent).not.toContain("Should stay hidden");
    expect(view.el.querySelectorAll(".gen-label")).toHaveLength(1);
  });

  test("live pause and a hidden document stop polling and resume at once", async () => {
    const calls = install(() => ({ enabled: true, titles: {}, pending: 2, error: null }));
    const session = makeSession([makePrompt(0)]);
    const view = await render(<Harness paused={false} session={session} token={TOKEN} />);
    expect(calls).toHaveLength(1);
    await advance(3_000);
    expect(calls).toHaveLength(2);
    await view.rerender(<Harness paused session={session} token={TOKEN} />);
    await advance(9_000);
    expect(calls).toHaveLength(2);
    await view.rerender(<Harness paused={false} session={session} token={TOKEN} />);
    expect(calls).toHaveLength(3);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(9_000);
    expect(calls).toHaveLength(3);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(calls).toHaveLength(4);
  });

  test("a hidden document does not request until it is visible, and pause waits for resume", async () => {
    const calls = install(() => ({ enabled: true, titles: { "0": "Later" }, pending: 1, error: null }));
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    const session = makeSession([makePrompt(0)]);
    const view = await render(<Harness paused={false} session={session} token={TOKEN} />);
    expect(calls).toHaveLength(0);
    await advance(5_000);
    expect(calls).toHaveLength(0);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(calls).toHaveLength(1);
    await view.unmount();

    const quiet = install(() => ({ enabled: true, titles: { "0": "After resume" }, pending: 0, error: null }));
    const held = makeSession([makePrompt(0)]);
    const paused = await render(<Harness paused session={held} token={TOKEN} />);
    expect(quiet).toHaveLength(0);
    await advance(5_000);
    expect(quiet).toHaveLength(0);
    expect(paused.el.textContent).not.toContain("After resume");
    await paused.rerender(<Harness paused={false} session={held} token={TOKEN} />);
    expect(quiet).toHaveLength(1);
    expect(paused.el.textContent).toContain("After resume");
  });

  test("a new session payload aborts the in-flight GET and fetches again; unmount aborts", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const s1 = makeSession([makePrompt(0, { text: "one" })]);
    const view = await render(<Harness paused={false} session={s1} token={TOKEN} />);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    await view.rerender(<Harness paused={false} session={makeSession([makePrompt(0, { text: "two" })])} token={TOKEN} />);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(2);
    await view.unmount();
    expect(signals[1]!.aborted).toBe(true);
  });

  test("the same payload does not refetch when the filter changes, and a failed GET does not poll", async () => {
    const calls = install(() => ({ enabled: true, titles: { "0": "Kept" }, pending: 0, error: null }));
    const session = makeSession([makePrompt(0, { status: "unchecked" })]);
    const view = await render(<Harness paused={false} session={session} token={TOKEN} />);
    expect(calls).toHaveLength(1);
    await view.rerender(<Harness paused={false} session={session} token={TOKEN} show="attention" />);
    expect(calls).toHaveLength(1);
    expect(view.el.textContent).toContain("Kept");

    let failed = 0;
    vi.stubGlobal("fetch", async () => {
      failed += 1;
      throw new TypeError("fail");
    });
    await render(<Harness paused={false} session={makeSession([makePrompt(0, { text: "other" })])} token={TOKEN} />);
    expect(failed).toBe(1);
    await advance(10_000);
    expect(failed).toBe(1);
  });
});
