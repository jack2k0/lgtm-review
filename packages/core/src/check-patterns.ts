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

export interface Segment {
  text: string;
  /** Operator that follows this segment: "&&", "||", "|", ";", "&", "\n" or "" at the end. */
  op: string;
  /** Unquoted "(" in the raw segment: a subshell starts before its command. */
  opens: number;
  /** Unquoted ")" in the raw segment: a subshell closes after its command. */
  closes: number;
}

export function stripHeredocs(cmd: string): string {
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
export function splitSegments(cmd: string): Segment[] {
  const segs: Segment[] = [];
  let cur = "";
  let quote: string | null = null;
  let opens = 0;
  let closes = 0;
  const end = (op: string): void => {
    const text = cur.trim().replace(/\s*[)}]+$/, "");
    const segOpens = opens;
    const segCloses = closes;
    cur = "";
    opens = 0;
    closes = 0;
    if (text === "") {
      // An operator after an empty segment (e.g. "a;\n") keeps the earlier operator.
      // A segment that held only closing parens still closes the preceding subshell.
      if (segCloses > 0 && segs.length > 0) (segs[segs.length - 1] as Segment).closes += segCloses;
      return;
    }
    segs.push({ text, op, opens: segOpens, closes: segCloses });
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
    } else if (c === "(") {
      opens++;
      cur += c;
    } else if (c === ")") {
      closes++;
      cur += c;
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

export function stripPrefixes(seg: string): string {
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
export function normalizeFirstToken(s: string): string {
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

/** Options of the task runners that take a value (needed to find tasks and their scopes). */
const TURBO_VALUE_OPTS = new Set([
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
const NX_VALUE_OPTS = new Set([
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
  if (word === "exec" || word === "dlx") return matchSegment(toks.slice(i + 1).join(" "), repo);
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

// --- Check scope ------------------------------------------------------------------------------

interface ParsedArgs {
  pos: string[];
  vals: Map<string, string[]>;
  flags: Set<string>;
}

function unquote(t: string): string {
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
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

function parseArgs(toks: readonly string[], start: number, valueOpts: ReadonlySet<string>, stopAtPositional = false): ParsedArgs {
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

function valsOf(a: ParsedArgs, ...names: string[]): string[] {
  return names.flatMap((n) => a.vals.get(n) ?? []);
}

function cleanPart(p: string): string {
  let s = p;
  while (s.startsWith("./")) s = s.slice(2);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function joinPrefix(prefix: string | null, part: string): string {
  const c = cleanPart(part);
  if (c.startsWith("/")) return c;
  if (c === "" || c === ".") return prefix ?? ".";
  return prefix === null ? c : `${prefix}/${c}`;
}

function dirOfFileRoot(p: string, exts: readonly string[]): string {
  if (!exts.some((e) => p.endsWith(e))) return p;
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : i === 0 ? "/" : p.slice(0, i);
}

/** A glob keeps its part before the first `*?[{` up to the last `/`. */
function globRoot(p: string): string {
  const g = p.search(/[*?[{]/);
  if (g < 0) return p;
  const head = p.slice(0, g);
  const i = head.lastIndexOf("/");
  return i < 0 ? "." : i === 0 ? "/" : head.slice(0, i);
}

function orDot(roots: string[]): string[] {
  return roots.length > 0 ? roots : ["."];
}

/** pnpm/bun filter: only path-style filters can be placed without the file system. */
function pathFilter(raw: string): string | null {
  // A glob or a comma list selects several projects; `{dir}` alone is pnpm's directory selector.
  if (/[*?[]/.test(raw) || /\{[^}]*,/.test(raw)) return null;
  const braced = /^(?:\.\.\.|\^)*\{[^{}]+\}(?:\.\.\.)?$/.test(raw);
  if (!braced && /[{}]/.test(raw)) return null;
  const f = raw.replace(/[{}]/g, "").replace(/^(?:\.\.\.|\^)+/, "").replace(/(?:\.\.\.)+$/, "");
  return braced || f.startsWith("./") || f.startsWith("../") ? f : null;
}

const PM_SCOPE_VALUE_OPTS = new Set(["-C", "--dir", "--filter", "-F", "--prefix", "-w", "--workspace", "--cwd"]);

function pmRoots(head: string, toks: string[]): string[] | null {
  // npm accepts its scope options after the script name (`npm test --prefix dir`), so scan every token.
  const opts = parseArgs(toks, 1, new Set([...PM_SCOPE_VALUE_OPTS, ...(PM_VALUE_OPTS[head] ?? [])]), head !== "npm");
  const roots: string[] = [];
  if (head === "pnpm" || head === "bun") {
    if (head === "pnpm" && (opts.flags.has("-r") || opts.flags.has("--recursive") || opts.vals.has("--recursive"))) return null;
    roots.push(...valsOf(opts, head === "pnpm" ? "-C" : "--cwd", "--dir"));
    for (const f of valsOf(opts, "--filter", "-F")) {
      const p = pathFilter(f);
      if (p === null) return null;
      roots.push(p);
    }
  } else if (head === "npm") {
    roots.push(...valsOf(opts, "--prefix"));
    for (const x of valsOf(opts, "-w", "--workspace")) {
      if (!x.includes("/") || x.startsWith("@")) return null;
      roots.push(x);
    }
  } else {
    if (opts.pos[0] === "workspace") return null;
    roots.push(...valsOf(opts, "--cwd"));
  }
  return orDot(roots);
}

/** A task runner run directly through a package manager (`pnpm turbo …`, `yarn nx …`). */
function pmTaskRunner(head: string, toks: string[]): { head: string; toks: string[]; idx: number } | null {
  const valueOpts = new Set([...PM_SCOPE_VALUE_OPTS, ...(PM_VALUE_OPTS[head] ?? [])]);
  let i = 1;
  while (i < toks.length && (toks[i] as string).startsWith("-")) i += valueOpts.has(toks[i] as string) ? 2 : 1;
  const word = toks[i];
  if (word !== "turbo" && word !== "nx") return null;
  return { head: word, toks: toks.slice(i), idx: i };
}

const VITEST_OPTS = new Set(
  "-c --config -r --root --dir --project -t --testNamePattern --reporter --environment --pool --shard --outputFile --mode --bail --maxWorkers --minWorkers --testTimeout --hookTimeout --teardownTimeout --retry --repeats --exclude --include --workspace --setupFiles --env --maxConcurrency".split(
    " ",
  ),
);
const JEST_OPTS = new Set(
  "-c --config -t --testNamePattern --selectProjects --shard --reporters --outputFile --rootDir -w --maxWorkers --testPathPattern --testPathPatterns --bail --minWorkers --testTimeout --retry --retryTimes --maxConcurrency --cacheDirectory --coverageDirectory --env --globals --globalSetup --globalTeardown --haste --moduleNameMapper --prettierPath --resolver --runner --setupFiles --setupFilesAfterEnv --snapshotResolver --testEnvironmentOptions --testResultsProcessor --testRunner --testSequencer --transform --workerIdleMemoryLimit --displayName --seed".split(
    " ",
  ),
);
const PYTEST_OPTS = new Set("-k -m -c -p -n -o --rootdir --maxfail --tb --junitxml --cov --ignore --deselect --durations".split(" "));
const GO_OPTS = new Set("-run -bench -count -timeout -tags -coverprofile -cpu -parallel -p -benchtime -o -exec -covermode -coverpkg -ldflags -gcflags".split(" "));
const TSC_OPTS = new Set("-p --project --outDir --target --module --lib --rootDir --declarationDir --jsx --moduleResolution".split(" "));
const LINT_OPTS = new Set(
  "-c --config --ext -f --format --max-warnings -o --output-file --rule --parser --ignore-path --cache-location --select --ignore --extend-select --target-version --line-length --output-format --config-file --python-version --cache-dir".split(" "),
);
const DOTNET_OPTS = new Set("-c --configuration -f --framework --filter -v --verbosity -r --runtime --logger -o --output -p -a --arch --os".split(" "));
const MAKE_OPTS = new Set(["-C", "-f", "-j", "--directory", "--file", "--jobs"]);

function goRoot(arg: string): string | null {
  if (!arg.startsWith(".")) return null;
  if (arg === "..." || arg === "./...") return ".";
  const a = arg.endsWith("/...") ? arg.slice(0, -4) : arg;
  return a === "" ? "." : a;
}

/** Roots of a turbo/nx invocation as written; `null` when they cannot be placed. */
function taskRunnerRoots(head: string, toks: string[]): string[] | null {
  if (head === "turbo") {
    const o = parseArgs(toks, 1, TURBO_VALUE_OPTS);
    // `--affected` selects projects from git, so the set is unknown without the file system.
    if (o.flags.has("--affected") || o.vals.has("--affected")) return null;
    const roots: string[] = [];
    for (const f of valsOf(o, "--filter", "-F").map(unquote)) {
      const p = pathFilter(f);
      if (p === null) return null;
      roots.push(p);
    }
    return orDot(roots);
  }
  const o = parseArgs(toks, 1, NX_VALUE_OPTS);
  const command = o.pos[0];
  // run-many/affected default to every project; named projects cannot be placed.
  if (command !== "run-many" && command !== "affected") return null;
  return valsOf(o, "-p", "--projects").length === 0 ? ["."] : null;
}

/** Roots of one (prefix-stripped) check segment as written; `null` when they cannot be placed. */
function segmentRoots(toks: string[], s: string): string[] | null {
  const head = toks[0] as string;
  if (head === "pnpm" || head === "npm" || head === "yarn" || head === "bun") {
    const pmTask = pmTaskRunner(head, toks);
    if (pmTask !== null) {
      const pmBase = pmRoots(head, toks.slice(0, pmTask.idx));
      const task = taskRunnerRoots(pmTask.head, pmTask.toks);
      if (pmBase === null || task === null) return null;
      if (pmBase.length === 1 && pmBase[0] === ".") return task;
      if (task.length === 1 && task[0] === ".") return pmBase;
      return null; // `-C dir` plus a filter: the task runner's root is relative to the repo, not to `dir`
    }
    return pmRoots(head, toks);
  }
  if (head === "turbo" || head === "nx") return taskRunnerRoots(head, toks);
  if (head === "make") {
    const o = parseArgs(toks, 1, MAKE_OPTS);
    const roots = valsOf(o, "-C", "--directory");
    // GNU make also accepts the attached form (`-Cpackages/web`).
    for (const t of toks) if (t.startsWith("-C") && t.length > 2) roots.push(t.slice(2));
    return orDot(roots);
  }
  if (head === "gh") return null;
  if (!SIMPLE_RES.some((re) => re.test(s))) return null; // a script file: the script decides
  let tool = head;
  let args = toks.slice(1);
  if (/^python3?(?:\.\d+)?$/.test(head)) {
    const m = toks.indexOf("-m");
    if (m < 0) return ["."]; // manage.py test
    tool = toks[m + 1] ?? "";
    args = toks.slice(m + 2);
  } else if (/manage\.py$/.test(head)) return ["."];
  switch (tool) {
    case "vitest": {
      if (args[0] === "related") return null;
      const o = parseArgs(args, 0, VITEST_OPTS);
      const pos = o.pos[0] === "run" || o.pos[0] === "watch" ? o.pos.slice(1) : o.pos;
      return pos.length > 0 ? pos : orDot(valsOf(o, "--dir", "--root"));
    }
    case "jest": {
      const o = parseArgs(args, 0, JEST_OPTS);
      return orDot([...o.pos, ...valsOf(o, "--testPathPattern", "--testPathPatterns")]);
    }
    case "pytest":
    case "py.test":
      return orDot(parseArgs(args, 0, PYTEST_OPTS).pos.map((p) => p.replace(/::.*$/, "")));
    case "go": {
      const o = parseArgs(args, 1, GO_OPTS);
      const roots: string[] = [];
      for (const p of o.pos) {
        const r = goRoot(p);
        if (r === null) return null;
        roots.push(r);
      }
      return orDot(roots);
    }
    case "tsc": {
      const o = parseArgs(args, 0, TSC_OPTS);
      const proj = valsOf(o, "--project", "-p");
      if (proj.length > 0) return proj.map((p) => dirOfFileRoot(p, [".json"]));
      if (o.flags.has("-b") || o.flags.has("--build")) {
        if (o.pos.length > 0) return o.pos.map((p) => dirOfFileRoot(p, [".json"]));
        return ["."];
      }
      return orDot(o.pos);
    }
    case "dotnet": {
      const p = parseArgs(args, 1, DOTNET_OPTS).pos[0];
      return p === undefined ? ["."] : [dirOfFileRoot(p, [".sln", ".csproj", ".fsproj"])];
    }
    case "cargo":
      return args.some((t) => /^(?:-p|--package|--manifest-path|--workspace)(?:=|$)/.test(t)) ? null : ["."];
    case "mvn":
    case "mvnw":
    case "gradle":
    case "gradlew":
      return args.some((t) => /^(?:-pl|-f|-p)(?:=|$)/.test(t)) ? null : ["."];
    case "mypy":
      if (args.some((t) => /^(?:-p|-m|--package|--module)(?:=|$)/.test(t))) return null;
    // falls through
    case "eslint":
    case "ruff":
    case "pyright":
    case "flake8":
    case "biome":
    case "shellcheck":
    case "hadolint":
    case "bats":
    case "node": {
      const o = parseArgs(args, 0, LINT_OPTS);
      const pos = tool === "ruff" || tool === "biome" ? o.pos.slice(1) : o.pos;
      return orDot(pos.map(globRoot));
    }
    default:
      return ["."];
  }
}

const REDIRECT_RE = /^(?:\d+|&)?>>?(?:\S*)$|^(?:\d+|&)?<(?:\S*)$/;

/** Drops shell redirections (`> out`, `2>&1`, `< in`) from a segment's tokens; they are not arguments. */
function stripRedirects(toks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as string;
    if (!REDIRECT_RE.test(t)) {
      out.push(t);
      continue;
    }
    // A bare operator (`>`, `2>`, `<`) carries its target in the next token.
    if (/^(?:\d+|&)?>>?$/.test(t) || /^(?:\d+|&)?<$/.test(t)) i++;
  }
  return out;
}

/**
 * Where a check command ran, as written: the roots (relative to the working directory unless absolute) of
 * every check segment, with `cd` prefixes applied. `null` when a root cannot be placed (named package
 * filters, `cd` to an unknown directory, scripts, CI) or when the command is not a check.
 */
export function checkScope(command: string, repo?: RepoScripts): string[] | null {
  try {
    if (typeof command !== "string" || command.trim() === "") return null;
    let prefix: string | null = null;
    const outerPrefixes: (string | null)[] = [];
    const roots: string[] = [];
    for (const seg of splitSegments(stripHeredocs(command))) {
      for (let i = 0; i < seg.opens; i++) outerPrefixes.push(prefix);
      const s = normalizeFirstToken(stripPrefixes(seg.text));
      const toks = stripRedirects(tokens(s).map(unquote));
      const head = toks[0];
      if (head === "cd" || head === "pushd") {
        const arg = toks[1];
        if (arg === undefined || arg === "-" || /^[~$]/.test(arg) || arg.includes("`") || arg.includes("$(")) return null;
        const next = joinPrefix(prefix, arg);
        prefix = next === "." ? null : next;
      } else if (matchSegment(seg.text, repo)) {
        const r = segmentRoots(toks, s);
        if (r === null) return null;
        for (const x of r) roots.push(joinPrefix(prefix, x));
      }
      // A `cd` inside `( … )` only affects that subshell: restore the outer prefix when it closes.
      for (let i = 0; i < seg.closes; i++) prefix = outerPrefixes.pop() ?? null;
    }
    return roots.length === 0 ? null : [...new Set(roots)];
  } catch {
    return null;
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
