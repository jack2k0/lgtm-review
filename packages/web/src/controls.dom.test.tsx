// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { LiveIndicator } from "./LiveView";
import { PlayView } from "./PlayView";
import { PromptTable } from "./PromptTable";
import { StepsView } from "./StepsView";
import { click, mount, press } from "./testing/dom";
import { makeDetail, makeMap, makePlay, makePrompt, makeSession } from "./testing/fixtures";

describe("existing controls in a DOM", () => {
  test("C1 prompt row expands and collapses", async () => {
    const c = await mount(<PromptTable session={makeSession([makePrompt(0)])} />);
    const btn = c.querySelector("button.rowbtn")!;
    expect(c.querySelector("tr.detail")).toBeNull();
    await click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(c.querySelector("tr.detail")?.textContent).toContain("Reason:");
    await click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector("tr.detail")).toBeNull();
  });

  test("C2 inherited group opens", async () => {
    const inh = { inheritedFrom: "abcdef0123456789" };
    const session = makeSession([makePrompt(0), makePrompt(1, { text: "inherited alpha", ...inh }), makePrompt(2, { text: "inherited beta", ...inh })]);
    const c = await mount(<PromptTable session={session} />);
    const toggle = c.querySelector("button.inherited-toggle")!;
    expect(c.textContent).not.toContain("inherited alpha");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(c.textContent).toContain("inherited alpha");
    expect(c.textContent).toContain("inherited beta");
  });

  test("C3 step actions open and file chip reports the path", async () => {
    const detail = makeDetail({
      steps: [
        {
          n: 1,
          phase: "fix",
          title: "Edit",
          startedAt: null,
          durationMs: 1000,
          quotes: [],
          actions: [
            { tool: "Edit", summary: "a", ok: true, ts: null },
            { tool: "Read", summary: "b", ok: true, ts: null },
          ],
          files: ["src/a.ts"],
        },
      ],
    });
    const onOpenFile = vi.fn();
    const c = await mount(<StepsView sessionId="s" detail={detail} onOpenFile={onOpenFile} />);
    expect(c.querySelector("ol.actions")).toBeNull();
    await click(c.querySelector("button.disclosure")!);
    expect(c.querySelectorAll("ol.actions li")).toHaveLength(2);
    await click(c.querySelector("button.chip")!);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts");
  });

  test("C4 play keys", async () => {
    const c = await mount(<PlayView sessionId="s" map={makeMap()} play={makePlay([{}, {}, {}])} initialPlaying={false} />);
    const counter = () => c.querySelector(".play-counter")?.textContent;
    expect(counter()).toBe("1 / 3");
    await press("ArrowRight", {}, document.body);
    expect(counter()).toBe("2 / 3");
    await press("ArrowLeft", {}, document.body);
    expect(counter()).toBe("1 / 3");
    await press(" ", {}, document.body);
    expect(c.querySelector(".play-btn[aria-label='Pause']")).not.toBeNull();
    await press("Escape", {}, document.body);
    expect(window.location.hash).toBe("#/session/s/prompt/0/map");
  });

  test("C5 live pause button", async () => {
    const onToggle = vi.fn();
    const c = await mount(<LiveIndicator paused={false} status={{ updatedAt: null, lost: null }} onToggle={onToggle} />);
    await click(c.querySelector("button.live-btn")!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
