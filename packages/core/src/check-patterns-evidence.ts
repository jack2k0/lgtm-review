import { splitSegments, stripHeredocs, type Segment } from "./check-patterns-segments.js";
import { matchSegment, normalizeFirstToken, stripPrefixes, tokens, type RepoScripts } from "./check-patterns-classify.js";

/**
 * Whether the result of a check command can be observed at all (S-38). A check whose outcome is hidden does not
 * count, like one that never completed: a trailing shell `&`, output discarded while the exit code is masked, and a
 * count-only pipe (`| wc -l`, `| grep -c ...`) that masks the exit code.
 */

/** Both stdout and stderr go to /dev/null: `&>/dev/null`, `>/dev/null 2>&1`, `>/dev/null 2>/dev/null`, `2>/dev/null >/dev/null`. */
const DISCARD_ALL = [
  /(?:^|\s)&>>?\s*\/dev\/null\b/,
  /(?:^|\s)>&\s*\/dev\/null\b/,
  /(?:^|\s)1?>>?\s*\/dev\/null\s+2>&1(?:\s|$)/,
  /(?:^|\s)1?>>?\s*\/dev\/null\s+2>>?\s*\/dev\/null\b/,
  /(?:^|\s)2>>?\s*\/dev\/null\s+1?>>?\s*\/dev\/null\b/,
];

function discardsAll(seg: string): boolean {
  return DISCARD_ALL.some((re) => re.test(seg));
}

/** `wc`, `wc -l`, `grep -c ...`, `grep --count ...`: the pipe's output is a number, not the check's output. */
function isCountOnly(seg: string): boolean {
  const toks = tokens(normalizeFirstToken(stripPrefixes(seg)));
  const head = toks[0];
  if (head === "wc") return true;
  if (head === "grep" || head === "egrep" || head === "fgrep" || head === "rg") {
    return toks.some((t) => t === "--count" || (/^-[A-Za-z]+$/.test(t) && t.includes("c")));
  }
  return false;
}

/** A shell operator that lets the check's own exit code through to the command's exit code, or not. */
function exitMasked(segs: readonly Segment[], i: number): boolean {
  const op = (segs[i] as Segment).op;
  return i < segs.length - 1 && (op === "|" || op === "||" || op === ";" || op === "\n");
}

/** True when a check segment of `command` runs in the background with `&`, discards its output behind a masked exit, or feeds a count-only pipe. */
export function resultUnobserved(command: string, repo?: RepoScripts): boolean {
  try {
    if (typeof command !== "string" || command === "") return false;
    const text = stripHeredocs(command);
    const segs = splitSegments(text);
    const pipefail = /\bpipefail\b/.test(text);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i] as Segment;
      if (!matchSegment(seg.text, repo)) continue;
      if (seg.op === "&") return true;
      if (!exitMasked(segs, i)) continue;
      if (discardsAll(seg.text)) return true;
      if (seg.op === "|" && !pipefail) {
        for (let j = i + 1; j < segs.length; j++) {
          if (isCountOnly((segs[j] as Segment).text)) return true;
          if ((segs[j] as Segment).op !== "|") break;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}
