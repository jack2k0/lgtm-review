import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createAnalyzer, type AnalyzeOptions } from "../analyze.js";
import type { SessionAnalysis } from "../schema.js";

/** Streams a file line by line (never reads it whole). */
export async function* readSessionLines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Streams a session file into the push-based analyzer. Dedupe by uuid is per file (inside the parser). */
export async function analyzeFile(file: string, opts: AnalyzeOptions = {}): Promise<SessionAnalysis> {
  const analyzer = createAnalyzer(opts);
  for await (const line of readSessionLines(file)) analyzer.push(line);
  return analyzer.finish();
}
