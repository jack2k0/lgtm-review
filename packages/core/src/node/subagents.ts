import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createSubagentCollector, DESCRIPTION_MAX, type SubagentTranscript } from "../subagents.js";
import { readSessionLines } from "./lines.js";

/** Most subagent transcripts read for one session; the rest are ignored with a warning. */
export const SUBAGENT_FILES_MAX = 100;

const AGENT_CALL_RE = /"name"\s*:\s*"Agent"/;
const ID_RE = /"id"\s*:\s*"([^"\\]{1,200})"/g;

/** `<projectDir>/<sessionId>/subagents` of a session file `<projectDir>/<sessionId>.jsonl`. */
export function subagentsDirFor(sessionFile: string): string {
  const base = basename(sessionFile);
  const id = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  return join(dirname(sessionFile), id, "subagents");
}

/**
 * Adds the tool-use ids of the `Agent` calls on `line` to `ids` (cheap substring test first; ids are taken
 * as every `"id"` string on a line that names the `Agent` tool, which is a superset and harmless).
 * Returns whether the line holds an `Agent` call.
 */
export function noteAgentCalls(line: string, ids: Set<string>): boolean {
  if (!line.includes('"Agent"') || !AGENT_CALL_RE.test(line)) return false;
  for (const m of line.matchAll(ID_RE)) ids.add(m[1] as string);
  return true;
}

interface AgentFiles {
  /** `agent-<id>`, sorted, at most `SUBAGENT_FILES_MAX`. */
  stems: string[];
  /** How many `agent-*.jsonl` there were. */
  total: number;
}

async function listAgentFiles(dir: string): Promise<AgentFiles | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const stems = names
    .filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"))
    .map((n) => n.slice(0, -".jsonl".length))
    .sort();
  return { stems: stems.slice(0, SUBAGENT_FILES_MAX), total: stems.length };
}

/**
 * Cache key part of a session: `(name, mtime, size)` of its subagent transcripts and metas, `""` when it has
 * none. One `readdir` (ENOENT for most sessions) plus a `stat` per file; nothing is read.
 */
export async function subagentStamp(sessionFile: string): Promise<string> {
  const dir = subagentsDirFor(sessionFile);
  const found = await listAgentFiles(dir);
  if (found === null || found.stems.length === 0) return "";
  const parts = await Promise.all(
    found.stems.flatMap((stem) => [`${stem}.jsonl`, `${stem}.meta.json`]).map(async (name) => {
      try {
        const st = await stat(join(dir, name));
        return `${name}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${name}:-`;
      }
    }),
  );
  return `${found.total}|${parts.join("|")}`;
}

export interface LoadedSubagents {
  transcripts: Map<string, SubagentTranscript>;
  warnings: string[];
}

interface Meta {
  toolUseId: string;
  description: string;
}

async function readMeta(path: string): Promise<Meta | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.toolUseId !== "string" || r.toolUseId === "") return null;
    const description = typeof r.description === "string" ? r.description.slice(0, DESCRIPTION_MAX) : "";
    return { toolUseId: r.toolUseId, description };
  } catch {
    return null;
  }
}

/**
 * Reads the subagent transcripts of a session whose parent made `Agent` calls with the tool-use ids `parentIds`.
 * Only transcripts that an `Agent` call (of the parent, or of an already read transcript: nested agents) refers
 * to are streamed; others are reported as unmatched without being read. Metas that are missing or unreadable skip
 * the transcript with a warning. Deterministic: files are visited in name order.
 */
export async function loadSubagents(sessionFile: string, parentIds: ReadonlySet<string>, opts: { detail?: boolean } = {}): Promise<LoadedSubagents> {
  const out: LoadedSubagents = { transcripts: new Map(), warnings: [] };
  const dir = subagentsDirFor(sessionFile);
  const found = await listAgentFiles(dir);
  if (found === null) return out;
  if (found.total > found.stems.length) {
    out.warnings.push(`${found.total} subagent files, only the first ${SUBAGENT_FILES_MAX} are read`);
  }

  const pending: { stem: string; agentId: string; meta: Meta }[] = [];
  const seenToolUse = new Set<string>();
  for (const stem of found.stems) {
    const agentId = stem.slice("agent-".length);
    const meta = await readMeta(join(dir, `${stem}.meta.json`));
    if (meta === null) {
      out.warnings.push(`subagent ${agentId}: meta missing or unreadable, transcript skipped`);
      continue;
    }
    if (seenToolUse.has(meta.toolUseId)) {
      out.warnings.push(`subagent ${agentId}: duplicate toolUseId, transcript skipped`);
      continue;
    }
    seenToolUse.add(meta.toolUseId);
    pending.push({ stem, agentId, meta });
  }

  const ids = new Set(parentIds);
  for (;;) {
    const i = pending.findIndex((p) => ids.has(p.meta.toolUseId));
    if (i < 0) break;
    const [p] = pending.splice(i, 1);
    const c = createSubagentCollector({ agentId: p!.agentId, description: p!.meta.description, detail: opts.detail === true });
    try {
      for await (const line of readSessionLines(join(dir, `${p!.stem}.jsonl`))) {
        c.push(line);
        noteAgentCalls(line, ids);
      }
    } catch {
      out.warnings.push(`subagent ${p!.agentId}: transcript unreadable, skipped`);
      continue;
    }
    out.transcripts.set(p!.meta.toolUseId, c.finish());
  }
  for (const p of pending) out.warnings.push(`unmatched subagent ${p.agentId}`);
  return out;
}
