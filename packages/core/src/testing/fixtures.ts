// Test-only helpers. Never import from src/index.ts (it must stay free of node: imports).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/sessions");

export const Labels = z.object({
  fixture: z.string(),
  source: z.literal("synthetic"),
  prompts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      expectedStatus: z.enum(["checked", "unchecked", "failing", "no-changes"]),
      note: z.string(),
      /** Hand-derived recommendation (optional; checked by the golden test when present). */
      expectedRecommendation: z.enum(["skim", "read-flagged", "read-all"]).optional(),
      /** Hand-derived hints as `rule:path` (path relative to the project dir), sorted; checked when present. */
      expectedHints: z.array(z.string()).optional(),
    }),
  ),
});
export type Labels = z.infer<typeof Labels>;

export function listFixtures(): string[] {
  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

export function listLabelFiles(): string[] {
  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".labels.json"))
    .map((f) => f.slice(0, -".labels.json".length))
    .sort();
}

export function readFixtureLines(name: string): string[] {
  return readFileSync(join(sessionsDir, `${name}.jsonl`), "utf8").split("\n").filter((l) => l !== "");
}

export function readLabels(name: string): Labels {
  return Labels.parse(JSON.parse(readFileSync(join(sessionsDir, `${name}.labels.json`), "utf8")));
}
