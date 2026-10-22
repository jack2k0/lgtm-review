import type { SpawnOptions } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { openBrowser, openCommand } from "./open.js";

function fakeSpawn() {
  const calls: [string, string[], SpawnOptions][] = [];
  const fn = vi.fn((cmd: string, args: string[], options: SpawnOptions) => {
    calls.push([cmd, args, options]);
    return { on: () => undefined, unref: () => undefined };
  });
  return { fn, calls };
}
const URL_ = "http://127.0.0.1:1234/#k=abc";

describe("openBrowser", () => {
  test("argv per platform, URL as a single argument", () => {
    expect(openCommand(URL_, "linux")).toEqual(["xdg-open", [URL_]]);
    expect(openCommand(URL_, "darwin")).toEqual(["open", [URL_]]);
    expect(openCommand(URL_, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", URL_]]);
  });
  test("spawns without a shell, detached, output ignored", () => {
    const s = fakeSpawn();
    expect(openBrowser(URL_, { platform: "linux", env: {}, spawnFn: s.fn })).toBe(true);
    expect(s.calls).toEqual([["xdg-open", [URL_], { stdio: "ignore", detached: true, shell: false }]]);
  });
  test.each(["1", "true", "yes"])("skipped when CI=%s", (ci) => {
    const s = fakeSpawn();
    expect(openBrowser(URL_, { env: { CI: ci }, spawnFn: s.fn })).toBe(false);
    expect(s.fn).not.toHaveBeenCalled();
  });
  test.each(["", "0", "false"])("CI=%j does not count as CI", (ci) => {
    const s = fakeSpawn();
    expect(openBrowser(URL_, { platform: "linux", env: { CI: ci }, spawnFn: s.fn })).toBe(true);
  });
  test("a throwing spawn is swallowed", () => {
    expect(
      openBrowser(URL_, {
        env: {},
        spawnFn: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBe(false);
  });
});
