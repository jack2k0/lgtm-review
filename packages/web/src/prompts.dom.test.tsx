// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { PromptTable } from "./PromptTable";
import { click, mount, press } from "./testing/dom";
import { makePrompt, makeSession } from "./testing/fixtures";

const inh = { inheritedFrom: "abcdef0123456789", status: "unchecked" as const };
const warn = { rule: "config-change" as const, severity: "warn" as const, path: null, reason: "config" };

const session = () =>
  makeSession([
    makePrompt(0),
    makePrompt(1, { status: "unchecked" }),
    makePrompt(2, { hints: [warn] }),
    makePrompt(3, { status: "failing" }),
    makePrompt(4, { status: "no-changes" }),
    makePrompt(5, inh),
    makePrompt(6, inh),
  ]);

const rowButtons = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("button.rowbtn"));
const focusIdx = (c: HTMLElement, i: number) => c.querySelector<HTMLElement>(`button.rowbtn[data-index="${i}"]`)!.focus();
const activeIdx = () => (document.activeElement as HTMLElement).dataset.index;

describe("prompt table triage", () => {
  test("P1 header counts", async () => {
    const c = await mount(<PromptTable session={session()} />);
    expect(c.querySelector(".session-head")?.textContent).toContain("5 prompts + 2 inherited · 3 prompts need attention");
  });

  test("P2 filter links", async () => {
    const c = await mount(<PromptTable session={session()} />);
    const [all, att] = Array.from(c.querySelectorAll<HTMLAnchorElement>("nav.filters a"));
    expect(all.getAttribute("href")).toBe("#/session/sess-own");
    expect(att.getAttribute("href")).toBe("#/session/sess-own?show=attention");
    expect(all.textContent).toBe("All (5)");
    expect(att.textContent).toBe("Needs attention (3)");
    expect(all.getAttribute("aria-current")).toBe("page");
    expect(att.getAttribute("aria-current")).toBeNull();
  });

  test("P3 attention filter", async () => {
    const c = await mount(<PromptTable session={session()} show="attention" />);
    expect(rowButtons(c).map((b) => b.dataset.index)).toEqual(["1", "2", "3"]);
    expect(c.textContent).toContain("Showing 3 of 5 prompts.");
    const att = c.querySelectorAll("nav.filters a")[1];
    expect(att.getAttribute("aria-current")).toBe("page");
    expect(c.querySelector("button.inherited-toggle")).not.toBeNull();
  });

  const clean = () => makeSession([makePrompt(0), makePrompt(1, { status: "no-changes" })]);

  test("P4 nothing needs attention", async () => {
    const c = await mount(<PromptTable session={clean()} show="attention" />);
    expect(c.textContent).toContain("No prompts need attention.");
    expect(rowButtons(c)).toHaveLength(0);
  });

  test("P5 arrows", async () => {
    const c = await mount(<PromptTable session={session()} />);
    focusIdx(c, 0);
    const ev = await press("ArrowDown");
    expect(ev.defaultPrevented).toBe(true);
    expect(activeIdx()).toBe("1");
    await press("ArrowUp");
    expect(activeIdx()).toBe("0");
    await press("ArrowUp");
    expect(activeIdx()).toBe("0");
    focusIdx(c, 4);
    await press("ArrowDown");
    expect(activeIdx()).toBe("4");
    await click(c.querySelector("button.inherited-toggle")!);
    focusIdx(c, 4);
    await press("ArrowDown");
    expect(activeIdx()).toBe("5");
  });

  test("P6 s and m keys", async () => {
    const c = await mount(<PromptTable session={session()} />);
    focusIdx(c, 2);
    await press("s", { shiftKey: true });
    await press("s", { ctrlKey: true });
    await press("x");
    expect(window.location.hash).toBe("");
    await press("s");
    expect(window.location.hash).toBe("#/session/sess-own/prompt/2");
    await press("m");
    expect(window.location.hash).toBe("#/session/sess-own/prompt/2/map");
  });

  test("P7 escape", async () => {
    await mount(<PromptTable session={session()} />);
    window.location.hash = "#/session/sess-own";
    await press("Escape", { ctrlKey: true }, document.body);
    expect(window.location.hash).toBe("#/session/sess-own");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await press("Escape", {}, input);
    expect(window.location.hash).toBe("#/session/sess-own");
    input.remove();
    await press("Escape", {}, document.body);
    expect(window.location.hash).toBe("#/");
  });

  test("P8 key legend", async () => {
    const c = await mount(<PromptTable session={session()} />);
    expect(c.querySelector(".keys")?.textContent).toContain("Esc back to sessions");
    const d = await mount(<PromptTable session={clean()} show="attention" />);
    expect(d.querySelector(".keys")).toBeNull();
  });
});
