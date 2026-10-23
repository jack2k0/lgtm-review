import { createAnalyzer, type Analyzer, type AnalyzeOptions } from "../analyze.js";
import type { SessionAnalysis } from "../schema.js";
import { readSessionLines } from "./lines.js";
import { loadSubagents, noteAgentCalls } from "./subagents.js";

export { readSessionLines } from "./lines.js";

/**
 * Streams a session file into `analyzer`, then, only if the file holds `Agent` calls, reads the session's
 * subagent transcripts (`<sessionId>/subagents/agent-*.jsonl`) into it. Returns the finished analysis.
 */
async function run(file: string, analyzer: Analyzer, opts: AnalyzeOptions): Promise<SessionAnalysis> {
  const agentIds = new Set<string>();
  let sawAgent = false;
  for await (const line of readSessionLines(file)) {
    analyzer.push(line);
    if (noteAgentCalls(line, agentIds)) sawAgent = true;
  }
  const warnings: string[] = [];
  if (sawAgent) {
    const loaded = await loadSubagents(file, agentIds, { detail: opts.detail === true });
    for (const [toolUseId, transcript] of loaded.transcripts) analyzer.addSubagent(toolUseId, transcript);
    warnings.push(...loaded.warnings);
  }
  const analysis = analyzer.finish();
  for (const reason of warnings) analysis.warnings.push(opts.file !== undefined ? { file: opts.file, line: 0, reason } : { line: 0, reason });
  return analysis;
}

/** Streams a session file (and its subagent transcripts) into the push-based analyzer. Dedupe by uuid is per file. */
export async function analyzeFile(file: string, opts: AnalyzeOptions = {}): Promise<SessionAnalysis> {
  const { subagents: _ignored, ...rest } = opts;
  return run(file, createAnalyzer(rest), rest);
}

/**
 * Like `analyzeFile` but with `detail: true`: returns the finished analyzer, so the caller can ask for
 * `details()` and `diffFor()` without a second pass over the file.
 */
export async function analyzeFileDetail(file: string, opts: Omit<AnalyzeOptions, "detail"> = {}): Promise<{ analysis: SessionAnalysis; analyzer: Analyzer }> {
  const { subagents: _ignored, ...rest } = opts;
  const o = { ...rest, detail: true };
  const analyzer = createAnalyzer(o);
  return { analysis: await run(file, analyzer, o), analyzer };
}
