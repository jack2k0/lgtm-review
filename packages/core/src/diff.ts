import type { FileDiff, Hunk } from "./schema.js";

/**
 * Compact retention and lazy materialisation of the diffs recorded in the log.
 * Caps are enforced while parsing: at most DIFF_LINES_MAX lines per diff and DIFF_LINE_CHARS_MAX
 * characters per line; whatever is cut sets `truncated`. Pure; imports nothing from Node.
 */

export const DIFF_LINES_MAX = 2000;
export const DIFF_LINE_CHARS_MAX = 2000;

/** One hunk as recorded in the log; `lines` keep their unified-diff prefix ("+", "-", " "). */
export interface RawHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Compact retained patch of one edit: `cut` is set when lines were dropped or shortened. */
export interface RawPatch {
  hunks: RawHunk[];
  cut: boolean;
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Retains the hunks of a recorded patch (`structuredPatch` or `bashEditDiff.files[].hunks`),
 * keeping at most `maxLines` lines in total. `undefined` when `raw` is not an array.
 */
export function extractPatch(raw: unknown, maxLines: number = DIFF_LINES_MAX): RawPatch | undefined {
  if (!Array.isArray(raw)) return undefined;
  const hunks: RawHunk[] = [];
  let cut = false;
  let left = maxLines;
  for (const h of raw) {
    if (!isObj(h) || !Array.isArray(h.lines)) continue;
    const lines: string[] = [];
    let old = 0;
    let neu = 0;
    for (const l of h.lines) {
      if (typeof l !== "string") continue;
      const c = l.charCodeAt(0);
      if (c === 43) neu++;
      else if (c === 45) old++;
      else if (c !== 92) {
        old++;
        neu++;
      }
      if (lines.length < left) {
        // The stored line keeps its one-character prefix, so the text itself is cut at DIFF_LINE_CHARS_MAX.
        if (l.length > DIFF_LINE_CHARS_MAX + 1) {
          lines.push(l.slice(0, DIFF_LINE_CHARS_MAX + 1));
          cut = true;
        } else lines.push(l);
      } else cut = true;
    }
    left -= lines.length;
    if (lines.length === 0 && h.lines.length > 0) continue;
    hunks.push({
      oldStart: int(h.oldStart) ?? 1,
      oldLines: int(h.oldLines) ?? old,
      newStart: int(h.newStart) ?? 1,
      newLines: int(h.newLines) ?? neu,
      lines,
    });
  }
  return { hunks, cut };
}

/** All-`+` hunk for a created file: the first `maxLines` lines of `content`; `total` is the full line count. */
export function createPatch(content: string, maxLines: number = DIFF_LINES_MAX): RawPatch {
  const lines: string[] = [];
  let total = 0;
  let cut = false;
  let start = 0;
  const n = content.length;
  while (start < n) {
    let end = content.indexOf("\n", start);
    const last = end === -1;
    if (last) end = n;
    total++;
    if (lines.length < maxLines) {
      const l = content.slice(start, Math.min(end, start + DIFF_LINE_CHARS_MAX));
      if (end - start > DIFF_LINE_CHARS_MAX) cut = true;
      lines.push(`+${l}`);
    } else cut = true;
    if (last) break;
    start = end + 1;
  }
  if (total === 0) return { hunks: [], cut: false };
  return { hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: total, lines }], cut };
}

/** Number of lines of a patch. */
export function patchLines(p: RawPatch): number {
  let n = 0;
  for (const h of p.hunks) n += h.lines.length;
  return n;
}

/** Rough size in characters (for the retention budget). */
export function patchChars(p: RawPatch): number {
  let n = 0;
  for (const h of p.hunks) for (const l of h.lines) n += l.length + 4;
  return n + p.hunks.length * 40;
}

/** Copy of `p` keeping at most `maxLines` lines; marks the copy `cut` when something was dropped. */
export function capPatch(p: RawPatch, maxLines: number): RawPatch {
  if (patchLines(p) <= maxLines) return p;
  const hunks: RawHunk[] = [];
  let left = Math.max(0, maxLines);
  for (const h of p.hunks) {
    if (left <= 0) break;
    hunks.push(h.lines.length <= left ? h : { ...h, lines: h.lines.slice(0, left) });
    left -= Math.min(left, h.lines.length);
  }
  return { hunks, cut: true };
}

export function hunkHeader(h: Pick<RawHunk, "oldStart" | "oldLines" | "newStart" | "newLines">): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

function toHunk(h: RawHunk, limit: number): Hunk {
  const lines: Hunk["lines"] = [];
  for (let i = 0; i < h.lines.length && i < limit; i++) {
    const l = h.lines[i] ?? "";
    const c = l.charAt(0);
    if (c === "+" || c === "-" || c === " ") lines.push({ t: c, s: l.slice(1, 1 + DIFF_LINE_CHARS_MAX) });
    else lines.push({ t: " ", s: l.slice(0, DIFF_LINE_CHARS_MAX) });
  }
  return { header: hunkHeader(h), lines };
}

/**
 * Materialises the diff of one file from the retained patches of its edits (in order).
 * `patches` has one entry per edit; `undefined` means no patch was recorded for that edit.
 */
export function buildFileDiff(
  path: string,
  kind: FileDiff["kind"],
  maybeIncomplete: boolean,
  patches: readonly (RawPatch | undefined)[],
): FileDiff {
  const hunks: Hunk[] = [];
  let truncated = false;
  let incomplete = maybeIncomplete;
  let left = DIFF_LINES_MAX;
  for (const p of patches) {
    if (p === undefined) {
      incomplete = true;
      continue;
    }
    if (p.cut) truncated = true;
    for (const h of p.hunks) {
      if (h.lines.length === 0) continue;
      if (left <= 0) {
        if (h.lines.length > 0) truncated = true;
        continue;
      }
      if (h.lines.length > left) truncated = true;
      const hunk = toHunk(h, left);
      left -= hunk.lines.length;
      hunks.push(hunk);
    }
  }
  if (kind === "D" && hunks.length === 0) incomplete = true;
  return { path, kind, truncated, maybeIncomplete: incomplete, hunks };
}
