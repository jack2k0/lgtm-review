import type { SpawnOptions } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLauncher, openBrowser, openCommand, redirectHtml } from "./open.js";

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

describe("launcher", () => {
  const url = "http://127.0.0.1:1234/#k=abcdef0123";
  test("file 0600 in dir 0700, contains escaped URL, cleanup removes it", () => {
    const base = mkdtempSync(join(tmpdir(), "lgtm-test-"));
    try {
      const l = createLauncher(url, base);
      expect(statSync(l.dir).mode & 0o777).toBe(0o700);
      expect(statSync(l.file).mode & 0o777).toBe(0o600);
      expect(l.fileUrl.startsWith("file://")).toBe(true);
      expect(l.fileUrl).not.toContain("abcdef0123");
      const html = readFileSync(l.file, "utf8");
      expect(html).toContain(`content="0;url=${url}"`);
      expect(html).toContain(`location.replace(${JSON.stringify(url)})`);
      l.cleanup();
      expect(existsSync(l.dir)).toBe(false);
      l.cleanup();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("HTML escapes attribute-breaking characters", () => {
    const html = redirectHtml(`http://x/"><script>&'`);
    expect(html).not.toContain(`"><script>`);
    expect(html).toContain("&quot;&gt;&lt;script&gt;&amp;&#39;");
  });
});
