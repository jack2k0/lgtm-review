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

/** `wc`, `wc -l`, `grep -c|-q|-l|-L ...`, `grep --count|--quiet|--silent ...`: the pipe's output is a number or nothing, not the check's output. */
function isCountOnly(seg: string): boolean {
  const toks = tokens(normalizeFirstToken(stripPrefixes(seg)));
  const head = toks[0];
  if (head === "wc") return true;
  if (head === "grep" || head === "egrep" || head === "fgrep" || head === "rg") {
    return toks.some(
      (t) =>
        t === "--count" ||
        t === "--quiet" ||
        t === "--silent" ||
        t === "--files-with-matches" ||
        t === "--files-without-match" ||
        (/^-[A-Za-z]+$/.test(t) && /[cqlL]/.test(t)),
    );
  }
  return false;
}

/** A shell operator that lets the check's own exit code through to the command's exit code, or not. */
function exitMasked(segs: readonly Segment[], i: number): boolean {
  const op = (segs[i] as Segment).op;
  return i < segs.length - 1 && (op === "|" || op === "||" || op === ";" || op === "\n");
}

/** A later segment is `wait`: a backgrounded check is waited for, and `wait` shows its exit code. */
function waitedFor(segs: readonly Segment[], i: number): boolean {
  return segs.slice(i + 1).some((s) => /^wait(?:\s|$)/.test(s.text.trim()));
}

/**
 * Indices (into `splitSegments`) of the check segments whose result cannot be observed: a check that a trailing `&`
 * backgrounds (with the rest of its `&&`/`||`/`|` list) and no later `wait`, one that discards all its output behind
 * a masked exit, and one that feeds a count-only pipe. Other segments of the command stay observed.
 */
export function unobservedSegments(command: string, repo?: RepoScripts): Set<number> {
  const out = new Set<number>();
  try {
    if (typeof command !== "string" || command === "") return out;
    const text = stripHeredocs(command);
    const segs = splitSegments(text);
    const pipefail = /\bpipefail\b/.test(text);
    const isCheck = segs.map((s) => matchSegment(s.text, repo));
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i] as Segment;
      if (!isCheck[i]) continue;
      if (exitMasked(segs, i) && discardsAll(seg.text)) out.add(i);
      if (seg.op === "|" && !pipefail && exitMasked(segs, i)) {
        for (let j = i + 1; j < segs.length; j++) {
          if (isCountOnly((segs[j] as Segment).text)) {
            out.add(i);
            break;
          }
          if ((segs[j] as Segment).op !== "|") break;
        }
      }
      if (seg.op === "&" && !waitedFor(segs, i)) {
        // `a && b &` backgrounds the whole list.
        for (let k = i; k >= 0; k--) {
          if (isCheck[k]) out.add(k);
          const prev = segs[k - 1];
          if (prev === undefined || !(prev.op === "&&" || prev.op === "||" || prev.op === "|")) break;
        }
      }
    }
  } catch {
    out.clear();
  }
  return out;
}

/** True when no check segment of `command` has an observable result (see `unobservedSegments`). */
export function resultUnobserved(command: string, repo?: RepoScripts): boolean {
  try {
    if (typeof command !== "string" || command === "") return false;
    const hidden = unobservedSegments(command, repo);
    if (hidden.size === 0) return false;
    return splitSegments(stripHeredocs(command)).every((seg, i) => !matchSegment(seg.text, repo) || hidden.has(i));
  } catch {
    return false;
  }
}
