/**
 * Detection of "check" commands (tests, linters, type checks, builds) in Bash command strings.
 * Pure string logic, best effort, never throws. The pattern list is a constant on purpose
 * (no config file in this slice).
 */

export interface RepoScripts {
  /** Names of root package.json scripts that count as checks (the loader filters them). */
  packageScripts: string[];
  /** Root Makefile targets that count as checks. */
  makeTargets: string[];
  /** Repo-relative script paths that count as checks, e.g. "scripts/check.sh". */
  scriptFiles: string[];
}

export interface CommandClass {
  isCheck: boolean;
  /** Normalized text of the check segment(s), at most ~120 characters. Empty when not a check. */
  label: string;
  /** The exit code of the whole command may not reflect the check (pipe, `|| true`, `; more`). */
  unreliable: boolean;
  /**
   * A command after the check segment may have reverted the edits under test
   * (`...; git checkout|restore|stash ...`), so a pass proves little about the edited tree.
   */
  mutationProbe: boolean;
}

const NOT_CHECK: CommandClass = { isCheck: false, label: "", unreliable: false, mutationProbe: false };

const CHECK_SCRIPT_NAMES = new Set(["test", "t", "lint", "typecheck", "check", "build", "tsc"]);
const MAKE_TARGETS = new Set(["test", "check", "lint", "build"]);
/** Script names that count as checks by name alone (no repo listing needed; sessions often start outside the repo). */
const SCRIPT_FILE_RE = /(^|\/)(check|test|lint|ci|verify|validate|gate|mutation|smoke)[^/\s]*\.sh$/;
const LABEL_MAX = 80;
const LABEL_TOTAL_MAX = 120;

// Options that take a value, per package manager (needed to find the subcommand).
const PM_VALUE_OPTS: Record<string, Set<string>> = {
  pnpm: new Set(["-C", "--dir", "--filter", "-F", "--workspace-dir"]),
  npm: new Set(["--prefix", "--workspace", "-w", "--cwd"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd", "--filter"]),
};

interface Segment {
  text: string;
  /** Operator that follows this segment: "&&", "||", "|", ";", "&", "\n" or "" at the end. */
  op: string;
}

function stripHeredocs(cmd: string): string {
  if (!cmd.includes("<<")) return cmd;
  const out: string[] = [];
  let delim: string | null = null;
  for (const line of cmd.split("\n")) {
    if (delim !== null) {
      if (line.trim() === delim) delim = null;
      continue;
    }
    out.push(line);
    const m = /(?<!<)<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/.exec(line);
    if (m) delim = m[1] ?? m[2] ?? m[3] ?? null;
  }
  return out.join("\n");
}

/** Quote-aware split on `&&`, `||`, `|`, `;`, `&` and newlines. */
function splitSegments(cmd: string): Segment[] {
  const segs: Segment[] = [];
  let cur = "";
  let quote: string | null = null;
  const end = (op: string): void => {
    const text = cur.trim().replace(/\s*[)}]+$/, "");
    cur = "";
    if (text === "") {
      // An operator after an empty segment (e.g. "a;\n") keeps the earlier operator.
      return;
    }
    segs.push({ text, op });
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    const next = cmd[i + 1];
    if (quote !== null) {
      cur += c;
      if (c === "\\" && quote === '"') {
        cur += next ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "\\") {
      cur += c + (next ?? "");
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
    } else if (c === "&" && next === "&") {
      end("&&");
      i++;
    } else if (c === "|" && next === "|") {
      end("||");
      i++;
    } else if (c === "|") {
      end("|");
      if (next === "&") i++;
    } else if (c === ";") {
      end(";");
    } else if (c === "\n") {
      end("\n");
    } else if (c === "&") {
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") cur += c;
      else end("&");
    } else {
      cur += c;
    }
  }
  end("");
  return segs;
}

const ENV_ASSIGN = /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
const PREFIXES: RegExp[] = [
  /^[({!]\s*/,
  /^(?:do|then|else)\s+/,
  ENV_ASSIGN,
  /^(?:time|nohup|command|exec)\s+/,
  /^nice\s+(?:-n\s*\d+\s+)?/,
  /^timeout\s+(?:(?:-k|-s|--kill-after|--signal)\s+\S+\s+|-{1,2}\S+\s+)*\d+[smhd]?\s+/,
  /^env\s+(?:-\S+\s+)*/,
  /^sudo\s+(?:-\S+\s+)*/,
  /^uv\s+run\s+(?:(?:--with|--project|--directory|--python|-p|--group|--extra)\s+\S+\s+|-{1,2}\S+\s+)*/,
  /^(?:poetry|pipenv)\s+run\s+/,
  /^(?:npx|bunx)\s+(?:-{1,2}[\w-]+\s+)*/,
  /^pnpm\s+(?:exec|dlx)\s+/,
  /^yarn\s+dlx\s+/,
];

function stripPrefixes(seg: string): string {
  let s = seg.trim();
  for (let guard = 0; guard < 20; guard++) {
    let changed = false;
    for (const re of PREFIXES) {
      const m = re.exec(s);
      if (m && m[0].length > 0) {
        s = s.slice(m[0].length).trimStart();
        changed = true;
      }
    }
    if (!changed) break;
  }
  return s;
}

/** Strips "./" and bin directories from the first token ("./node_modules/.bin/vitest" -> "vitest"). */
function normalizeFirstToken(s: string): string {
  const m = /^(\S+)/.exec(s);
  if (!m || m[1] === undefined) return s;
  let tok = m[1];
  const bin = /^(?:\.{0,2}\/)?(?:[\w.~-]+\/)*\.?bin\/([\w.-]+)$/.exec(tok);
  if (bin && bin[1] !== undefined) tok = bin[1];
  else if (tok.startsWith("./")) tok = tok.slice(2);
  return tok + s.slice(m[1].length);
}

function tokens(s: string): string[] {
  return s.split(/\s+/).filter((t) => t !== "");
}

function hasHelpFlag(toks: string[]): boolean {
  return toks.some((t) => t === "--help" || t === "-h" || t === "--version" || t === "-V");
}

/** `--dry-run` (and `make -n`) prints what would run instead of running it. */
function isDryRun(toks: string[]): boolean {
  return toks.some((t) => t === "--dry-run" || t === "--dryrun" || t === "--just-print") || (toks[0] === "make" && toks.includes("-n"));
}

/** `gh run watch` only fails the command with `--exit-status`; `ruff check --fix` edits files instead of checking. */
function isExcludedForm(s: string, toks: string[]): boolean {
  if (/^ruff\s+check\b/.test(s)) return toks.some((t) => t === "--fix" || t.startsWith("--fix-only") || t.startsWith("--fix="));
  return false;
}

function isGhWatch(s: string, toks: string[]): boolean | null {
  if (!/^gh\s+run\s+watch\b/.test(s)) return null;
  return toks.includes("--exit-status");
}

function isCheckScriptName(name: string, repo: RepoScripts | undefined): boolean {
  if (repo?.packageScripts.includes(name)) return true;
  const base = name.split(":")[0] ?? name;
  return CHECK_SCRIPT_NAMES.has(base);
}

function matchPackageManager(pm: string, toks: string[], repo: RepoScripts | undefined): boolean {
  const valueOpts = PM_VALUE_OPTS[pm] ?? new Set<string>();
  let i = 1;
  const skipOptions = (): void => {
    while (i < toks.length && (toks[i] as string).startsWith("-")) {
      i += valueOpts.has(toks[i] as string) ? 2 : 1;
    }
  };
  skipOptions();
  const word = toks[i];
  if (word === undefined) return false;
  if (word === "exec" || word === "dlx") return matchSegment(toks.slice(i + 1).join(" "), repo);
  if (word === "run" || word === "run-script") {
    i++;
    skipOptions();
    const script = toks[i];
    return script !== undefined && isCheckScriptName(script, repo);
  }
  if (pm === "bun" && word === "test") return true;
  return isCheckScriptName(word, repo);
}

function matchMake(toks: string[], repo: RepoScripts | undefined): boolean {
  const valueOpts = new Set(["-C", "-f", "-j", "--directory", "--file", "--jobs"]);
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t.startsWith("-")) {
      if (valueOpts.has(t)) i++;
      continue;
    }
    if (t.includes("=")) continue;
    if (MAKE_TARGETS.has(t) || repo?.makeTargets.includes(t)) return true;
  }
  return false;
}

function matchScriptFile(toks: string[], repo: RepoScripts | undefined): boolean {
  let i = 0;
  if (/^(?:bash|sh|zsh)$/.test(toks[0] ?? "")) {
    i = 1;
    while (i < toks.length && (toks[i] as string).startsWith("-")) {
      // `bash -n script` only checks the syntax: it runs nothing.
      if (/^-[A-Za-z]*n[A-Za-z]*$/.test(toks[i] as string)) return false;
      i++;
    }
  }
  const path = toks[i];
  if (path === undefined) return false;
  const clean = path.replace(/^\.\//, "");
  if (SCRIPT_FILE_RE.test(clean)) return true;
  return repo?.scriptFiles.some((f) => f.replace(/^\.\//, "") === clean) ?? false;
}

const SIMPLE_RES: RegExp[] = [
  /^(?:tsc|vitest|jest|eslint|pytest|py\.test|mypy|flake8|golangci-lint)(?:\s|$)/,
  /^biome\s+(?:check|lint|ci)\b/,
  /^node\s+(?:\S+\s+)*--test\b/,
  /^python3?(?:\.\d+)?\s+(?:-\S+\s+)*-m\s+(?:pytest|unittest|mypy)\b/,
  /^ruff\s+(?:check\b|format\s+(?:\S+\s+)*--check\b)/,
  /^go\s+(?:test|vet|build)\b/,
  /^cargo\s+(?:\+\S+\s+)?(?:test|check|clippy|build|nextest)\b/,
  /^dotnet\s+(?:test|build)\b/,
  /^(?:python3?(?:\.\d+)?\s+(?:-\S+\s+)*)?(?:\S*\/)?manage\.py\s+test\b/,
  /^(?:bats|shellcheck|hadolint)(?:\s|$)/,
  /^gh\s+pr\s+checks\b/,
  /^mvnw?\s+(?:.*\s)?(?:test|verify|package)(?:\s|$)/,
  /^gradlew?\s+(?:.*\s)?(?:test|check|build)(?:\s|$)/,
];

/** Is this (prefix-stripped) segment a check command? */
function matchSegment(raw: string, repo: RepoScripts | undefined): boolean {
  const s = normalizeFirstToken(stripPrefixes(raw));
  if (s === "") return false;
  const toks = tokens(s);
  if (hasHelpFlag(toks) || isDryRun(toks)) return false;
  const gh = isGhWatch(s, toks);
  if (gh !== null) return gh;
  if (isExcludedForm(s, toks)) return false;
  const head = toks[0] as string;
  if (head === "pnpm" || head === "npm" || head === "yarn" || head === "bun") {
    return matchPackageManager(head, toks, repo);
  }
  if (head === "make") return matchMake(toks, repo);
  if (SIMPLE_RES.some((re) => re.test(s))) return true;
  return matchScriptFile(toks, repo);
}

function labelOf(raw: string): string {
  const s = normalizeFirstToken(stripPrefixes(raw)).replace(/\s+/g, " ");
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + "…" : s;
}

const GIT_PREFIX = /^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*/;

/** `git restore|stash ...` or `git checkout -- file` / `git checkout .` / `git checkout path/file`. */
function isMutationProbe(raw: string): boolean {
  const s = normalizeFirstToken(stripPrefixes(raw));
  const m = GIT_PREFIX.exec(s);
  if (!m) return false;
  const toks = tokens(s.slice(m[0].length));
  const sub = toks[0];
  if (sub === "stash") return !["pop", "apply", "list", "show"].includes(toks[1] ?? "");
  if (sub === "restore") return true;
  if (sub !== "checkout") return false;
  const rest = toks.slice(1);
  if (rest.some((t) => t === "-b" || t === "-B" || t === "--orphan")) return false;
  return rest.some((t) => t === "--" || t === "." || (!t.startsWith("-") && /[./]/.test(t)));
}

/**
 * A chained command is a check when any segment is a check. The exit code belongs to the whole chain,
 * so the result is `unreliable` when a check segment is followed by a pipe, `||`, `;`, a newline plus
 * more commands, or `&`.
 */
export function classifyCommand(command: string, repo?: RepoScripts): CommandClass {
  try {
    if (typeof command !== "string" || command.trim() === "") return NOT_CHECK;
    const segs = splitSegments(stripHeredocs(command));
    const labels: string[] = [];
    let unreliable = false;
    let mutationProbe = false;
    let firstCheck = -1;
    segs.forEach((seg, i) => {
      if (!matchSegment(seg.text, repo)) return;
      if (firstCheck < 0) firstCheck = i;
      labels.push(labelOf(seg.text));
      const hasLater = i < segs.length - 1;
      if (seg.op === "&") unreliable = true;
      else if ((seg.op === "|" || seg.op === "||" || seg.op === ";" || seg.op === "\n") && hasLater) unreliable = true;
    });
    if (labels.length === 0) return NOT_CHECK;
    for (let j = firstCheck + 1; j < segs.length; j++) {
      if (isMutationProbe((segs[j] as Segment).text)) mutationProbe = true;
    }
    if (mutationProbe) unreliable = true;
    let label = labels.join(" + ");
    if (label.length > LABEL_TOTAL_MAX) label = label.slice(0, LABEL_TOTAL_MAX - 1) + "…";
    return { isCheck: true, label, unreliable, mutationProbe };
  } catch {
    return NOT_CHECK;
  }
}

// --- Masked exit codes ------------------------------------------------------------------------

/** How much of a result's tail is inspected for failure signals. */
export const MASKED_TAIL_MAX = 4096;
const TRACEBACK_LINES = 12;

const EXIT_NUM = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d?)";
const FAILURE_SIGNALS: RegExp[] = [
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
    const tail = output.length > MASKED_TAIL_MAX ? output.slice(output.length - MASKED_TAIL_MAX) : output;
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
