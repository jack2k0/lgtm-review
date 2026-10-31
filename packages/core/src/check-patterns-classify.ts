import { checkArithmeticOpener, splitSegments, stripHeredocs, type Segment } from "./check-patterns-segments.js";

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
const JUST_RECIPES = new Set(["test", "check", "lint"]);
/** Check tools that package managers run directly (`pnpm vitest`, `yarn eslint`, `bun tsc`). */
export const PM_CHECK_BINS = new Set(["tsc", "vitest", "jest", "eslint", "pytest", "py.test", "mypy", "ruff", "flake8", "golangci-lint", "biome", "bats", "shellcheck", "hadolint"]);
/** Script names that count as checks by name alone (no repo listing needed; sessions often start outside the repo). */
const SCRIPT_FILE_RE = /(^|\/)(check|test|lint|ci|verify|validate|gate|mutation|smoke)[^/\s]*\.sh$/;
const LABEL_MAX = 80;
const LABEL_TOTAL_MAX = 120;

// Options that take a value, per package manager (needed to find the subcommand).
export const PM_VALUE_OPTS: Record<string, Set<string>> = {
  pnpm: new Set(["-C", "--dir", "--filter", "-F", "--workspace-dir"]),
  npm: new Set(["--prefix", "--workspace", "-w", "--cwd"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd", "--filter"]),
};

/** Options of the task runners that take a value (needed to find tasks and their scopes). */
export const TURBO_VALUE_OPTS = new Set([
  "--filter",
  "-F",
  "--concurrency",
  "--cache-dir",
  "--cache-workers",
  "--log-order",
  "--output-logs",
  "--pkg-inference-root",
  "--env-mode",
  "--framework-inference",
  "--global-deps",
  "--remote-cache-timeout",
  "--token",
  "--team",
  "--api",
]);


export interface ParsedArgs {
  pos: string[];
  vals: Map<string, string[]>;
  flags: Set<string>;
}

const SECRET_VALUE_OPTS = new Set([
  "--password",
  "--passwd",
  "--token",
  "--secret",
  "--api-key",
  "--apikey",
  "--auth",
  "--credentials",
  "--private-key",
]);

export function parseArgs(toks: readonly string[], start: number, valueOpts: ReadonlySet<string>, stopAtPositional = false): ParsedArgs {
  const out: ParsedArgs = { pos: [], vals: new Map(), flags: new Set() };
  const put = (k: string, v: string): void => {
    const a = out.vals.get(k);
    if (a) a.push(v);
    else out.vals.set(k, [v]);
  };
  for (let i = start; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t === "--") {
      out.pos.push(...toks.slice(i + 1));
      break;
    }
    if (t.startsWith("-") && t !== "-") {
      const eq = t.indexOf("=");
      if (t.startsWith("--") && eq > 0) put(t.slice(0, eq), t.slice(eq + 1));
      else if (valueOpts.has(t) || SECRET_VALUE_OPTS.has(t.toLowerCase())) {
        const v = toks[i + 1];
        if (v !== undefined) put(t, v);
        i++;
      } else out.flags.add(t);
    } else {
      out.pos.push(t);
      if (stopAtPositional) break;
    }
  }
  return out;
}

export function valsOf(a: ParsedArgs, ...names: string[]): string[] {
  return names.flatMap((n) => a.vals.get(n) ?? []);
}

export function unquote(t: string): string {
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}

const ENV_ASSIGN = /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
const PREFIXES: RegExp[] = [
  /^[({!]\s*/,
  /^(?:do|then|else)\s+/,
  ENV_ASSIGN,
  /^(?:time|nohup|command|exec|corepack)\s+/,
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

const WORD_RE = /^(?:"[^"]*"|'[^']*'|\S+)/;

/** Reads the next shell word (quotes kept) and the rest of the string, or null at the end. */
function nextWord(s: string): { word: string; rest: string } | null {
  const m = WORD_RE.exec(s);
  if (!m) return null;
  return { word: m[0], rest: s.slice(m[0].length).trimStart() };
}

/** Options that take a separate value, per wrapper (an attached value such as `-w10` or `--wait=10` is one word). */
const WRAPPER_VALUE_OPTS: Record<string, ReadonlySet<string>> = {
  flock: new Set(["-w", "-E", "--wait", "--timeout", "--conflict-exit-code"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]),
  setsid: new Set(),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
};

/**
 * Strips `flock [opts] <lock> <cmd>` / `flock <lock> -c "<cmd>"`, `ionice`, `setsid` and `stdbuf`, word by word.
 * Returns the wrapped command, or null when `s` does not start with one of them.
 */
function stripWrapper(s: string): string | null {
  const head = /^(flock|ionice|setsid|stdbuf)\s+/.exec(s);
  if (!head) return null;
  const name = head[1] as string;
  const valueOpts = WRAPPER_VALUE_OPTS[name] as ReadonlySet<string>;
  let rest = s.slice(head[0].length).trimStart();
  let lockSeen = name !== "flock";
  for (let guard = 0; guard < 50; guard++) {
    const w = nextWord(rest);
    if (w === null) return null;
    if (w.word.startsWith("-") && w.word.length > 1) {
      if (name === "flock" && lockSeen && (w.word === "-c" || w.word === "--command")) {
        const cmd = nextWord(w.rest);
        return cmd === null ? null : unquote(cmd.word) + (cmd.rest === "" ? "" : " " + cmd.rest);
      }
      rest = w.rest;
      if (valueOpts.has(w.word)) {
        const v = nextWord(rest);
        if (v === null) return null;
        rest = v.rest;
      }
      continue;
    }
    if (!lockSeen) {
      lockSeen = true;
      rest = w.rest;
      continue;
    }
    return rest;
  }
  return null;
}

export function stripPrefixes(seg: string): string {
  let s = seg.trim();
  for (let guard = 0; guard < 20; guard++) {
    let changed = false;
    const wrapped = stripWrapper(s);
    if (wrapped !== null && wrapped !== s) {
      s = wrapped.trimStart();
      changed = true;
    }
    // A closed `((...))` arithmetic command is not a `(` subshell prefix (also after `!` was stripped).
    const arithmetic = (): boolean => s.startsWith("((") && checkArithmeticOpener(s, 0, true) !== null;
    if (arithmetic()) break;
    for (const re of PREFIXES) {
      if (arithmetic()) break;
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
export function normalizeFirstToken(s: string): string {
  const m = /^(\S+)/.exec(s);
  if (!m || m[1] === undefined) return s;
  let tok = m[1];
  const bin = /^(?:\.{0,2}\/)?(?:[\w.~-]+\/)*\.?bin\/([\w.-]+)$/.exec(tok);
  if (bin && bin[1] !== undefined) tok = bin[1];
  else if (tok.startsWith("./")) tok = tok.slice(2);
  return tok + s.slice(m[1].length);
}

export function tokens(s: string): string[] {
  return s.split(/\s+/).filter((t) => t !== "");
}

function hasHelpFlag(toks: string[]): boolean {
  // `-v` is the version flag of tsc and vitest only (pytest -v is verbose).
  const lowerV = toks[0] === "tsc" || toks[0] === "vitest";
  return toks.some((t) => t === "--help" || t === "-h" || t === "--version" || t === "-V" || (lowerV && t === "-v"));
}

/** `--dry-run` (and `make -n`) prints what would run instead of running it. */
function isDryRun(toks: string[]): boolean {
  return toks.some((t) => t === "--dry-run" || t === "--dryrun" || t === "--just-print") || (toks[0] === "make" && toks.includes("-n"));
}

const SCRIPT_RUNNERS = new Set(["pnpm", "npm", "yarn", "bun", "turbo"]);
const SCRIPT_FIX_NAMES = new Set(["lint:fix", "lint-fix", "fix:lint"]);

function findTurboScript(toks: readonly string[]): string | null {
  const opts = parseArgs(toks, 1, TURBO_VALUE_OPTS);
  const tasks = opts.pos[0] === "run" ? opts.pos.slice(1) : opts.pos;
  return tasks[0] ?? null;
}

function findPackageManagerScript(pm: string, toks: readonly string[]): { script: string; scriptIndex: number } | null {
  const valueOpts = PM_VALUE_OPTS[pm] ?? new Set<string>();
  let i = 1;
  const skipOptions = (): void => {
    while (i < toks.length) {
      const t = toks[i]!;
      if (t === "--") {
        i++;
        break;
      }
      if (t.startsWith("-") && t !== "-") {
        const eq = t.indexOf("=");
        if (t.startsWith("--") && eq > 0) {
          i++;
        } else if (valueOpts.has(t)) {
          i += 2;
        } else {
          i++;
        }
      } else {
        break;
      }
    }
  };
  skipOptions();
  const word = toks[i];
  if (word === undefined) return null;
  if (word === "run" || word === "run-script") {
    i++;
    skipOptions();
    const script = toks[i];
    return script !== undefined ? { script, scriptIndex: i } : null;
  }
  return { script: word, scriptIndex: i };
}

function getRunnerScript(toks: readonly string[]): string | null {
  const head = toks[0] as string;
  if (head === "turbo") return findTurboScript(toks);
  if (head === "pnpm" || head === "npm" || head === "yarn" || head === "bun") {
    const res = findPackageManagerScript(head, toks);
    if (!res) return null;
    if (res.script === "turbo") return findTurboScript(toks.slice(res.scriptIndex));
    return res.script;
  }
  return null;
}

function isFixerFlag(t: string): boolean {
  if (t === "--fix-dry-run" || t.startsWith("--fix-dry-run=")) return false;
  return (
    t === "--fix" ||
    t.startsWith("--fix=") ||
    t.startsWith("--fix-type") ||
    t === "--fix-only" ||
    t.startsWith("--fix-only=") ||
    t === "--write" ||
    t.startsWith("--write=") ||
    t === "--apply" ||
    t.startsWith("--apply=") ||
    t === "--apply-unsafe" ||
    t.startsWith("--apply-unsafe=") ||
    t === "--unsafe" ||
    t.startsWith("--unsafe=")
  );
}

function isScriptAutofix(toks: readonly string[]): boolean {
  if (toks.length < 2) return false;
  const head = toks[0] as string;
  if (!SCRIPT_RUNNERS.has(head)) return false;
  if (toks.some((t) => t === "--fix-dry-run" || t.startsWith("--fix-dry-run="))) return false;

  const script = getRunnerScript(toks);
  if (script === null) return false;

  if (SCRIPT_FIX_NAMES.has(script)) return true;

  if (script === "lint" || script.startsWith("lint:") || script === "check") {
    return toks.some(isFixerFlag);
  }

  return false;
}

/** `gh run watch` only fails the command with `--exit-status`; `ruff check --fix` edits files instead of checking. */
function isExcludedForm(s: string, toks: string[]): boolean {
  if (isScriptAutofix(toks)) return true;
  const eslintIdx = toks.indexOf("eslint");
  if (eslintIdx !== -1 && (eslintIdx === 0 || /^(?:pnpm|npm|yarn|bun|npx|bunx)$/.test(toks[0]!))) {
    if (toks.some((t) => t === "--fix" || t.startsWith("--fix=") || t.startsWith("--fix-type"))) return true;
  }
  const biomeIdx = toks.indexOf("biome");
  if (biomeIdx !== -1 && (biomeIdx === 0 || /^(?:pnpm|npm|yarn|bun|npx|bunx)$/.test(toks[0]!))) {
    const BIOME_FIX = new Set(["--write", "--fix", "--apply", "--apply-unsafe", "--unsafe"]);
    if (toks.some((t) => BIOME_FIX.has(t) || BIOME_FIX.has(t.split("=")[0]!))) return true;
  }
  if (/^(?:python3?(?:\.\d+)?\s+(?:-\S+\s+)*-m\s+)?ruff\s+check\b/.test(s)) return toks.some((t) => t === "--fix" || t.startsWith("--fix-only") || t.startsWith("--fix="));
  if (/^deno\s+lint\b/.test(s)) return toks.includes("--fix");
  // Listing and collecting commands do not run any test.
  if (/^(?:pytest|py\.test)(?:\s|$)/.test(s) || /^python3?(?:\.\d+)?\s+(?:-\S+\s+)*-m\s+pytest\b/.test(s)) return toks.some((t) => t === "--collect-only" || t === "--co");
  if (/^jest(?:\s|$)/.test(s)) return toks.includes("--listTests");
  if (/^vitest(?:\s|$)/.test(s)) return toks.slice(1).find((t) => !t.startsWith("-")) === "list";
  if (/^cargo\s/.test(s)) return toks.includes("--no-run");
  if (/^dotnet\s+test\b/.test(s)) return toks.includes("--list-tests");
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

export const NX_VALUE_OPTS = new Set([
  "-t",
  "--targets",
  "-p",
  "--projects",
  "-c",
  "--configuration",
  "--parallel",
  "--max-parallel",
  "--output-style",
  "--runner",
  "--base",
  "--head",
  "--exclude",
  "--files",
  "--port",
  "--host",
  "--project",
  "--target",
]);

/** Comma-separated task names from one or more option values, e.g. `-t lint,test`. */
function taskNames(values: readonly string[]): string[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function matchTurbo(toks: string[], repo: RepoScripts | undefined): boolean {
  // `--dry` and `--graph` only print the task graph; `--dry=json`/`--dry-run=json` do too.
  if (toks.some((t) => t === "--dry" || t.startsWith("--dry=") || t === "--dry-run" || t.startsWith("--dry-run=") || t === "--graph" || t.startsWith("--graph="))) return false;
  const opts = parseArgs(toks, 1, TURBO_VALUE_OPTS);
  const tasks = opts.pos[0] === "run" ? opts.pos.slice(1) : opts.pos;
  return tasks.some((t) => isCheckScriptName(t, repo));
}

function nxTarget(spec: string): string | null {
  // `nx run <project>:<target>[:<configuration>]`.
  const colon = spec.indexOf(":");
  return colon < 0 ? null : spec.slice(colon + 1);
}

function matchNx(toks: string[], repo: RepoScripts | undefined): boolean {
  // `nx --graph` writes the project graph instead of running tasks.
  if (toks.some((t) => t === "--graph" || t.startsWith("--graph="))) return false;
  const opts = parseArgs(toks, 1, NX_VALUE_OPTS);
  const command = opts.pos[0];
  if (command === "run-many" || command === "affected") {
    return taskNames(valsOf(opts, "-t", "--targets")).some((t) => isCheckScriptName(t, repo));
  }
  if (command === "run") {
    const target = opts.pos[1] === undefined ? null : nxTarget(opts.pos[1] as string);
    return target !== null && isCheckScriptName(target, repo);
  }
  if (command === undefined) return false;
  return isCheckScriptName(command, repo);
}

function matchTaskRunner(head: string, toks: string[], repo: RepoScripts | undefined): boolean {
  return head === "turbo" ? matchTurbo(toks, repo) : matchNx(toks, repo);
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
  if (word === "exec" || word === "dlx") {
    i++;
    if (toks[i] === "--") i++;
    return matchSegment(toks.slice(i).join(" "), repo);
  }
  if (pm !== "npm" && PM_CHECK_BINS.has(word) && !repo?.packageScripts.includes(word)) return matchSegment(toks.slice(i).join(" "), repo);
  if (word === "turbo" || word === "nx") return matchTaskRunner(word, toks.slice(i), repo);
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

function matchJust(toks: string[]): boolean {
  const valueOpts = new Set(["-d", "-f", "--working-directory", "--justfile", "--chooser", "--color", "--shell"]);
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t.startsWith("-")) {
      if (valueOpts.has(t)) i++;
      continue;
    }
    if (t.includes("=")) continue; // variable override (`just x=1 test`)
    return JUST_RECIPES.has(t); // the first recipe decides; later words are its arguments
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

export const SIMPLE_RES: RegExp[] = [
  /^(?:tsc|vitest|jest|eslint|pytest|py\.test|mypy|flake8|golangci-lint)(?:\s|$)/,
  /^biome\s+(?:check|lint|ci)\b/,
  /^node\s+(?:\S+\s+)*--test\b/,
  /^python3?(?:\.\d+)?\s+(?:-\S+\s+)*-m\s+(?:(?:pytest|unittest|mypy|flake8|pylint)\b|ruff\s+(?:check\b|format\s+(?:\S+\s+)*--check\b)|black\s+(?:\S+\s+)*--check\b)/,
  /^deno\s+(?:test|lint|check)\b/,
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
export function matchSegment(raw: string, repo: RepoScripts | undefined): boolean {
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
  if (head === "turbo" || head === "nx") return matchTaskRunner(head, toks, repo);
  if (head === "make") return matchMake(toks, repo);
  if (head === "just") return matchJust(toks);
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

