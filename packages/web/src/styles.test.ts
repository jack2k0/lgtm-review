import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}
const lightBlock = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
const darkBlock = /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)![1]!;
const light = vars(lightBlock);
const dark = { ...light, ...vars(darkBlock) };

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// [foreground, background, minimum ratio]: 4.5 for text, 3 for non-text indicators (WCAG 1.4.3 / 1.4.11).
const pairs: [string, string, number][] = [
  ["text", "bg", 4.5], ["text", "surface", 4.5],
  ["muted", "bg", 4.5], ["muted", "surface", 4.5],
  ["link", "bg", 4.5], ["link", "surface", 4.5],
  ["error", "bg", 4.5], ["focus", "bg", 3],
  ["marker-text", "marker-bg", 4.5],
  ["dot-checked", "bg", 3], ["dot-unchecked", "bg", 3], ["dot-failing", "bg", 3], ["dot-no-changes", "bg", 3],
  ["pass", "bg", 4.5], ["pass", "surface", 4.5], ["error", "surface", 4.5],
  ["badge-read", "bg", 4.5], ["badge-write", "bg", 4.5], ["badge-check", "bg", 4.5], ["badge-fix", "bg", 4.5],
  ["badge-read", "surface", 4.5], ["badge-write", "surface", 4.5], ["badge-check", "surface", 4.5], ["badge-fix", "surface", 4.5],
  ["seg-read", "surface", 3], ["seg-write", "surface", 3], ["seg-check", "surface", 3], ["seg-fix", "surface", 3],
];

describe.each([["light", light], ["dark", dark]] as const)("%s theme contrast", (_name, theme) => {
  test.each(pairs)("%s on %s >= %f", (fg, bg, min) => {
    expect(theme[fg], fg).toBeDefined();
    expect(theme[bg], bg).toBeDefined();
    expect(contrast(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(min);
  });
});

test("dark theme overrides every light color token", () => {
  for (const k of Object.keys(vars(darkBlock))) expect(light[k]).toBeDefined();
  expect(Object.keys(vars(darkBlock)).sort()).toEqual(Object.keys(light).sort());
});
