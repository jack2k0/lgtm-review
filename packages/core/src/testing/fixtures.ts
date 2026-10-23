// Test-only helpers. Never import from src/index.ts (it must stay free of node: imports).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { analyzeSession, type AnalyzeOptions } from "../analyze.js";
import type { SessionAnalysis } from "../schema.js";
import { parseSubagent, type SubagentTranscript } from "../subagents.js";

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

const SubagentMeta = z.object({ description: z.string().optional(), toolUseId: z.string() });

/**
 * Subagent transcripts of a fixture (`<name>/subagents/agent-<id>.jsonl` + `.meta.json`, the layout of a real
 * session dir) by the tool-use id of the parent's `Agent` call. `{}` when the fixture has none.
 */
export function readFixtureSubagents(name: string, opts: { detail?: boolean } = {}): Map<string, SubagentTranscript> {
  const dir = join(sessionsDir, name, "subagents");
  const out = new Map<string, SubagentTranscript>();
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const f of files) {
    const agentId = f.slice("agent-".length, -".jsonl".length);
    const meta = SubagentMeta.parse(JSON.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf8")));
    const lines = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l !== "");
    out.set(meta.toolUseId, parseSubagent(lines, { agentId, description: meta.description ?? "", detail: opts.detail === true }));
  }
  return out;
}

/** `analyzeSession` over a fixture with its subagent transcripts supplied. */
export function analyzeFixture(name: string, opts: AnalyzeOptions = {}): SessionAnalysis {
  return analyzeSession(readFixtureLines(name), { ...opts, subagents: readFixtureSubagents(name, { detail: opts.detail === true }) });
}
