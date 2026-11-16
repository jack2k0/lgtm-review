import type { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { listFiles } from "./map.js";

describe("listFiles", () => {
  it("passes --no-optional-locks as the first git argument", async () => {
    let seen: readonly string[] = [];
    const exec = ((_cmd: string, args: readonly string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
      seen = args;
      cb(null, "a.ts\0");
    }) as unknown as typeof execFile;
    expect(await listFiles("/x", { exec })).toEqual(["a.ts"]);
    expect(seen[0]).toBe("--no-optional-locks");
  });
});
