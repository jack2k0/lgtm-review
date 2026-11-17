/**
 * Detection of "check" commands (tests, linters, type checks, builds) in Bash command strings.
 * Pure string logic, best effort, never throws. The pattern list is a constant on purpose
 * (no config file in this slice).
 *
 * Entry point aggregating segmentation, command classification, scope resolution,
 * and masked exit code detection.
 */

/**
 * Re-exported shell lexical analysis, subshell boundary tracking,
 * arithmetic command parsing and heredoc segmentation.
 */
export {
  scanParenPairEnd,
  scanBracketPairEnd,
  isArithmeticCommandStart,
  checkArithmeticOpener,
  parseHeredocStarts,
  heredocEnds,
  stripHeredocs,
  isGroupingSubshellOpen,
  splitSegments,
  type Segment,
  type HeredocStart,
} from "./check-patterns-segments.js";

/**
 * Re-exported command classification, prefix stripping, token normalization,
 * and check command pattern matching.
 */
export {
  stripPrefixes,
  normalizeFirstToken,
  matchSegment,
  classifyCommand,
  type RepoScripts,
  type CommandClass,
} from "./check-patterns-classify.js";

/**
 * Re-exported check scope and target resolution.
 */
export {
  checkScope,
  placeCheckScope,
  type PlacedScope,
} from "./check-patterns-scope.js";

/**
 * Re-exported tree-state operations (`git stash`, `git checkout -- .`, `git restore`, `git stash pop`).
 */
export { treeOps, type TreeOp } from "./check-patterns-tree.js";

/**
 * Re-exported check families (test, typecheck, lint, build, other) and the "result not observed" detection.
 */
export { checkFamilies, CHECK_FAMILIES, type CheckFamily, type CheckFamilies } from "./check-patterns-family.js";
export { resultUnobserved, unobservedSegments } from "./check-patterns-evidence.js";

// --- Masked exit codes ------------------------------------------------------------------------

/** How much of a result's tail is inspected for failure signals. */
export const MASKED_TAIL_MAX = 4096;
const TRACEBACK_LINES = 12;

const ESC = String.fromCharCode(27);
/** Start of a line: blanks and ANSI colour codes may precede the text. */
const LINE_START = `^\\s*(?:${ESC}\\[[0-9;]*m)*\\s*`;
const EXIT_NUM = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d?)";
const FAILURE_SIGNALS: RegExp[] = [
  /^\s*FAIL(?:[\s:]|$)/, // jest/vitest `FAIL src/x.test.ts`, go `FAIL\tpkg` and a bare `FAIL`
  /^\s*--- FAIL:/,
  /^(?:Killed|Terminated)(?:[\s:]|$)/,
  /\b[1-9]\d* (?:failed|failures?|errors?)\b/,
  new RegExp(`(?:^|\\s)(?:EXIT|exit|rc)[=:]\\s*${EXIT_NUM}\\b`),
  new RegExp(`\\b[Ee]xit code[=:]?\\s*${EXIT_NUM}\\b`),
  /(?:^|\s)status[=:]\s*[1-9]\d?\b/,
  /BUILD FAILURE/,
  /Tests run:.*(?:Failures|Errors): [1-9]/,
  /\bFAILED\b/,
  /\bnot ok\b/,
  /\bFailed!/,
  /\bFailed:\s+[1-9]/,
  // The signals below name tool output at the start of a line (after blanks and colour codes); a test title or log text
  // that merely mentions them does not count under a masked exit.
  new RegExp(`${LINE_START}(?:\\S+(?:\\(\\d+,\\d+\\)|:\\d+:\\d+)\\s*[:-]\\s*)?error TS\\d+\\b`), // tsc `src/a.ts(1,1): error TS2304: ...`
  new RegExp(`${LINE_START}error\\[E\\d+\\]`), // rustc `error[E0425]: ...`
  new RegExp(`${LINE_START}npm ERR!`),
  /^make(?:\[\d+\])?: \*\*\*/, // `make: *** [test] Error 1`
  new RegExp(`${LINE_START}(?:[\\w./-]+: )(?:line \\d+: )?(?:[\\w./+-]+: )?command not found\\b`), // `bash: vitest: command not found`, `zsh: command not found: pytest`
  new RegExp(`${LINE_START}ERR_PNPM_\\w+`), // `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`
  // pytest's `FAILED tests/x.py::t - ...` summary line is already matched by `\bFAILED\b` above.
];
const TRACEBACK = /Traceback \(most recent call last\)/;
/** Explicitly negative phrases ("0 failed", "no errors", "errors: 0", "All tests passed"). */
const NEGATIVE = /\b0 (?:failed|failures?|errors?)\b|\bno errors\b|\berrors?: 0\b|\bAll tests passed\b/i;

/**
 * Looks for failure signals in the last ~4 KB of a check's output, for checks whose exit code does not
 * reflect the check (pipe, `|| true`, `; echo`). Returns the first line with a signal, or null.
 * A failure signal wins over a negative phrase anywhere in the tail; only the negative phrase of a final
 * summary line (`0 failed`, `no errors`, `All tests passed`, `Ran N tests ... OK`) is blanked out before
 * matching. A traceback counts only near the end.
 */
export function findMaskedFailure(output: string): string | null {
  try {
    if (typeof output !== "string" || output === "") return null;
    let tail = output;
    if (output.length > MASKED_TAIL_MAX) {
      // A tail that starts mid-token would keep a secret's suffix, which no longer redacts: drop the partial token only,
      // so a failure signal later on the same line still counts.
      const start = output.length - MASKED_TAIL_MAX;
      tail = output.slice(start);
      if (!/\s/.test(output[start - 1] ?? "\n")) {
        const ws = tail.search(/\s/);
        tail = ws === -1 ? "" : tail.slice(ws);
      }
    }
    const lines = tail.split("\n");
    let last = lines.length - 1;
    while (last >= 0 && (lines[last] as string).trim() === "") last--;
    if (last < 0) return null;
    const finalLine = lines[last] as string;
    const isFinalSummary =
      NEGATIVE.test(finalLine) ||
      (finalLine.trim() === "OK" && lines.slice(Math.max(0, last - 4), last).some((l) => /^Ran \d+ tests?\b/.test(l.trim())));
    const tracebackFrom = Math.max(0, lines.length - TRACEBACK_LINES);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i] as string;
      // On the final summary line the negative phrase itself is not a signal ("0 FAILED"); the rest still is.
      if (isFinalSummary && i === last) line = line.replace(new RegExp(NEGATIVE.source, "gi"), " ");
      if (FAILURE_SIGNALS.some((re) => re.test(line)) || (i >= tracebackFrom && TRACEBACK.test(line))) return line.trim();
    }
    return null;
  } catch {
    return null;
  }
}

