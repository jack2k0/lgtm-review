import { createParser, type Event, type ParserOptions } from "./parse.js";
import { parseTs } from "./timing.js";

/**
 * Subagent transcripts and their merge into the event sequence of a prompt. Pure and node-free:
 * the caller supplies already-parsed transcripts (see `createSubagentCollector`).
 *
 * Merge rule (deterministic, a pure function of the ordered inputs):
 * - the host sequence (the prompt's events, or a transcript's events for nested agents) keeps its order;
 * - each guest event goes after the last host event whose timestamp is <= its own (ties: host first);
 *   events without a timestamp inherit the previous known one; guest events earlier than the start of the
 *   host attach at the start (right after the prompt event), later than the end at the end;
 * - guest timestamps are made monotone within their transcript, so a transcript keeps its own order;
 * - guests of one slot are ordered by (timestamp, agentId, position);
 * - nested agents (an `Agent` call inside a transcript) are merged recursively up to depth 3;
 * - at most 20,000 non-text guest events per prompt are merged (applied while merging).
 */

export const SUBAGENT_DEPTH_MAX = 3;
/** Cap of normalised (non-text) events of one transcript. */
export const TRANSCRIPT_EVENTS_MAX = 20_000;
/** Cap of retained text characters of one transcript (results, quotes, commands, hints). */
export const TRANSCRIPT_TEXT_MAX = 5_000_000;
/** Cap of merged (non-text) subagent events of one prompt, over all depths. */
export const PROMPT_SUBAGENT_EVENTS_MAX = 20_000;
export const DESCRIPTION_MAX = 200;

export type Truncation = "events" | "text";

export interface SubagentTranscript {
  agentId: string;
  /** From the transcript's meta (<= 200 chars); `""` when unknown. */
  description: string;
  /** Normalised events of the transcript (sidechain parser), tagged with `agentId`. */
  events: Event[];
  /** A per-transcript cap cut the events. */
  truncated: boolean;
  /** Which cap cut them (`events` when absent and `truncated`). */
  truncation?: Truncation;
}

export interface SubagentCollectorOptions {
  agentId?: string;
  description?: string;
  /** Same meaning as for the parent parser: retain hunks, agent text and call hints. */
  detail?: boolean;
  file?: string;
}

export interface SubagentCollector {
  push(line: string): void;
  finish(): SubagentTranscript;
}

export function textWeight(ev: Event): number {
  switch (ev.type) {
    case "text":
      return ev.text.length;
    case "tool_use":
      return (ev.input.command?.length ?? 0) + (ev.input.hint?.length ?? 0) + (ev.input.filePath?.length ?? 0);
    case "tool_result":
      return ev.text.length + (ev.tail?.length ?? 0);
    default:
      return 0;
  }
}

/** Streams the lines of one subagent file into a capped `SubagentTranscript`. */
export function createSubagentCollector(opts: SubagentCollectorOptions = {}): SubagentCollector {
  const parserOpts: ParserOptions = { sidechain: true, detail: opts.detail === true };
  if (opts.agentId !== undefined) parserOpts.agentId = opts.agentId;
  if (opts.file !== undefined) parserOpts.file = opts.file;
  const parser = createParser(parserOpts);
  const events: Event[] = [];
  let count = 0;
  let chars = 0;
  let truncation: Truncation | null = null;
  let agentId = opts.agentId;
  return {
    push(line: string): void {
      for (const ev of parser.push(line)) {
        if ((ev.type === "tool_use" || ev.type === "tool_result" || ev.type === "text") && agentId === undefined && ev.agentId !== undefined) {
          agentId = ev.agentId;
        }
        if (truncation !== null) continue;
        if (ev.type !== "text" && count >= TRANSCRIPT_EVENTS_MAX) {
          truncation = "events";
          continue;
        }
        chars += textWeight(ev);
        if (chars > TRANSCRIPT_TEXT_MAX) {
          truncation = "text";
          continue;
        }
        if (ev.type !== "text") count++;
        events.push(ev);
      }
    },
    finish(): SubagentTranscript {
      parser.finish();
      const t: SubagentTranscript = {
        agentId: agentId ?? "agent",
        description: (opts.description ?? "").slice(0, DESCRIPTION_MAX),
        events,
        truncated: truncation !== null,
      };
      if (truncation !== null) t.truncation = truncation;
      return t;
    },
  };
}

/** Convenience wrapper: the transcript of the lines of one subagent file. */
export function parseSubagent(lines: Iterable<string>, opts: SubagentCollectorOptions = {}): SubagentTranscript {
  const c = createSubagentCollector(opts);
  for (const l of lines) c.push(l);
  return c.finish();
}

export interface MergeFlags {
  /** An `Agent` call without a transcript. */
  missing: boolean;
  /** An `Agent` call whose transcript lies deeper than `SUBAGENT_DEPTH_MAX`. */
  depth: boolean;
  /** A transcript was cut by the event cap (its own or the per-prompt one). */
  eventCap: boolean;
  /** A transcript was cut by the text cap. */
  textCap: boolean;
}

export interface MergeContext {
  subagents: ReadonlyMap<string, SubagentTranscript>;
  /** Tool-use ids of transcripts that were matched to an `Agent` call (filled while merging). */
  used: Set<string>;
  /** agentId -> description of every merged transcript. */
  descriptions: Map<string, string>;
}

export function emptyFlags(): MergeFlags {
  return { missing: false, depth: false, eventCap: false, textCap: false };
}

function eventTs(ev: Event): string | null | undefined {
  return ev.type === "prompt" || ev.type === "tool_use" || ev.type === "tool_result" ? ev.ts : undefined;
}

/** Timestamp (ms) of each event; events without one inherit the previous known one (`-Infinity` before any). */
function inheritedTimes(events: readonly Event[], first: number): number[] {
  const out: number[] = [];
  let last = first;
  for (const ev of events) {
    const t = parseTs(eventTs(ev));
    if (t !== null) last = t;
    out.push(last);
  }
  return out;
}

/** Index of the last element of the (non-monotonic) `pts` that is <= t, or -1. */
function lastAtOrBefore(sufMin: readonly number[], t: number): number {
  let lo = 0;
  let hi = sufMin.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sufMin[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function tagged(ev: Event, agentId: string): Event {
  if (ev.type === "tool_use" || ev.type === "tool_result" || ev.type === "text") return ev.agentId === undefined ? { ...ev, agentId } : ev;
  return ev;
}

interface Guest {
  ev: Event;
  slot: number;
  ts: number;
  key: string;
  idx: number;
}

/**
 * Merges the transcripts of the `Agent` calls found in `host` into it. `minSlot` is the first index a guest may
 * take (1 for a prompt sequence: nothing goes before the prompt event). Returns the host untouched when it has
 * no `Agent` call.
 */
function mergeLevel(host: readonly Event[], depth: number, minSlot: number, ctx: MergeContext, budget: { left: number }, flags: MergeFlags): Event[] {
  let hasAgent = false;
  for (const ev of host) {
    if (ev.type === "tool_use" && ev.name === "Agent") {
      hasAgent = true;
      break;
    }
  }
  if (!hasAgent) return host as Event[];

  const hostTs = inheritedTimes(host, -Infinity);
  const out: Event[] = host.slice();
  const guests: Guest[] = [];
  let sufMin: number[] | null = null;
  const suffix = (): number[] => {
    if (sufMin === null) {
      const m = new Array<number>(hostTs.length);
      let min = Infinity;
      for (let i = hostTs.length - 1; i >= 0; i--) {
        min = Math.min(min, hostTs[i]!);
        m[i] = min;
      }
      sufMin = m;
    }
    return sufMin;
  };

  for (let i = 0; i < host.length; i++) {
    const ev = host[i]!;
    if (ev.type !== "tool_use" || ev.name !== "Agent") continue;
    const tr = ctx.subagents.get(ev.id);
    if (tr === undefined) {
      flags.missing = true;
      out[i] = { ...ev, subagent: "missing" };
      continue;
    }
    if (depth + 1 > SUBAGENT_DEPTH_MAX) {
      flags.depth = true;
      ctx.used.add(ev.id);
      out[i] = { ...ev, subagent: "depth" };
      continue;
    }
    out[i] = { ...ev, subagent: "found" };
    if (ctx.used.has(ev.id)) continue; // the same call seen twice: merge once
    ctx.used.add(ev.id);
    ctx.descriptions.set(tr.agentId, tr.description);
    if (tr.truncated) {
      if (tr.truncation === "text") flags.textCap = true;
      else flags.eventCap = true;
    }
    // Per-prompt cap, applied while merging: take the prefix of the transcript that still fits.
    let take = tr.events.length;
    let used = 0;
    for (let k = 0; k < tr.events.length; k++) {
      if (tr.events[k]!.type === "text") continue;
      if (used >= budget.left) {
        take = k;
        flags.eventCap = true;
        break;
      }
      used++;
    }
    budget.left -= used;
    let events: Event[] = tr.events.slice(0, take).map((e) => tagged(e, tr.agentId));
    events = mergeLevel(events, depth + 1, 0, ctx, budget, flags);

    // Guest timestamps: inherit, lead with the call's own time, and keep them monotone within the transcript.
    const times = inheritedTimes(events, hostTs[i]!);
    let run = -Infinity;
    for (let k = 0; k < events.length; k++) {
      run = Math.max(run, times[k]!);
      const j = lastAtOrBefore(suffix(), run);
      guests.push({ ev: events[k]!, slot: Math.max(minSlot, j + 1), ts: run, key: tr.agentId, idx: guests.length });
    }
  }
  if (guests.length === 0) return out;

  guests.sort((a, b) => a.slot - b.slot || a.ts - b.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.idx - b.idx);
  const merged: Event[] = [];
  let g = 0;
  for (let s = 0; s <= out.length; s++) {
    while (g < guests.length && guests[g]!.slot === s) merged.push(guests[g++]!.ev);
    if (s < out.length) merged.push(out[s]!);
  }
  return merged;
}

/**
 * Merges the subagent transcripts into the events of one prompt (`events[0]` is the prompt event).
 * Returns the merged sequence and what could not be merged completely.
 */
export function mergeSubagents(events: readonly Event[], ctx: MergeContext): { events: Event[]; flags: MergeFlags } {
  const flags = emptyFlags();
  const merged = mergeLevel(events, 0, 1, ctx, { left: PROMPT_SUBAGENT_EVENTS_MAX }, flags);
  return { events: merged, flags };
}
