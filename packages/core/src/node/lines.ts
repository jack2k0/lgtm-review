import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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
