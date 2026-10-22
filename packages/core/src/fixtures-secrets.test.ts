import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

const patterns: [string, RegExp][] = [
  ["sk-ant-", /sk-ant-/],
  ["sk- key", /sk-[A-Za-z0-9]{20,}/],
  ["github token", /ghp_|github_pat_/],
  ["aws key id", /AKIA[0-9A-Z]{16}/],
  ["private key", /-----BEGIN .*PRIVATE KEY-----/],
  ["credential assignment", /(token|secret|password)\s*[=:]\s*\S{8,}/i],
  ["macOS home path", /\/Users\//],
  ["real home path", /\/home\/(?!user\/)/],
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

test("fixtures contain no secrets or real home paths", () => {
  const hits: string[] = [];
  for (const file of walk(fixturesRoot)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const [label, re] of patterns) {
          if (re.test(line)) hits.push(`${relative(fixturesRoot, file)}:${i + 1}: ${label}`);
        }
      });
  }
  expect(hits, `secret-like content found:\n${hits.join("\n")}`).toEqual([]);
});
