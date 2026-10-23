import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CONNECTION_LOST, LiveIndicator, lostNote } from "./Live";
import { ApiError } from "./api";

const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
const render = (paused: boolean, updatedAt: number | null, lost: string | null = null) =>
  renderToStaticMarkup(<LiveIndicator paused={paused} status={{ updatedAt, lost }} onToggle={() => {}} />);

describe("LiveIndicator", () => {
  test("live: text, polite live region, pause button", () => {
    const html = render(false, at);
    expect(html).toContain("Live · updated 03:04:05");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Pause live updates"');
    expect(html).toMatch(/<button[^>]*>Pause<\/button>/);
    expect(html).not.toContain("Paused");
  });
  test("before the first load there is no time", () => {
    const html = render(false, null);
    expect(html).toContain("Live");
    expect(html).not.toContain("updated");
  });
  test("paused: label flips to Resume and keeps the last time", () => {
    const html = render(true, at);
    expect(html).toContain("Paused · updated 03:04:05");
    expect(html).toContain('aria-label="Resume live updates"');
    expect(html).toMatch(/<button[^>]*>Resume<\/button>/);
  });
  test("connection note appears inside the live region", () => {
    const html = render(false, at, CONNECTION_LOST);
    expect(html).toContain("Connection lost, retrying");
    expect(html.indexOf("Connection lost")).toBeGreaterThan(html.indexOf('aria-live="polite"'));
    expect(html.indexOf("Connection lost")).toBeLessThan(html.indexOf("<button"));
  });
  test("note text is rendered as text", () => {
    const html = render(false, at, "<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
  test("lostNote: connection problems vs. other errors", () => {
    expect(lostNote(new ApiError("network", "x"))).toBe(CONNECTION_LOST);
    expect(lostNote(new ApiError("server", "500"))).toBe(CONNECTION_LOST);
    expect(lostNote(new ApiError("not-found", "404"))).toContain("Not found");
    expect(lostNote(new Error("boom"))).toContain("retrying");
  });
});
