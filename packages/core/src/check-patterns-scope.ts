import { splitSegments, stripHeredocs } from "./check-patterns-segments.js";
import {
  matchSegment,
  parseArgs,
  valsOf,
  type ParsedArgs,
  normalizeFirstToken,
  stripPrefixes,
  tokens,
  unquote,
  NX_VALUE_OPTS,
  PM_CHECK_BINS,
  PM_VALUE_OPTS,
  SIMPLE_RES,
  TURBO_VALUE_OPTS,
  type RepoScripts,
} from "./check-patterns-classify.js";

// --- Check scope ------------------------------------------------------------------------------

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

/** A check binary run through a package manager (`pnpm vitest …`, `bun -C dir tsc`). */
function pmBinary(head: string, toks: string[]): { toks: string[]; idx: number } | null {
  if (head === "npm") return null;
  const valueOpts = new Set([...PM_SCOPE_VALUE_OPTS, ...(PM_VALUE_OPTS[head] ?? [])]);
  let i = 1;
  while (i < toks.length && (toks[i] as string).startsWith("-")) i += valueOpts.has(toks[i] as string) ? 2 : 1;
  const word = toks[i];
  if (word === undefined || !PM_CHECK_BINS.has(word)) return null;
  return { toks: toks.slice(i), idx: i };
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
    const pmBin = pmBinary(head, toks);
    if (pmBin !== null) {
      const pmBase = pmRoots(head, toks.slice(0, pmBin.idx));
      const inner = segmentRoots(pmBin.toks, pmBin.toks.join(" "));
      if (pmBase === null || inner === null) return null;
      if (pmBase.length === 1 && pmBase[0] === ".") return inner;
      if (inner.length === 1 && inner[0] === ".") return pmBase;
      return null; // `-C dir` plus paths: the tool's paths are relative to `dir`
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
  if (head === "just") {
    const o = parseArgs(toks, 1, new Set(["-d", "-f", "--working-directory", "--justfile"]));
    return orDot(valsOf(o, "-d", "--working-directory"));
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
    case "pylint":
    case "black":
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

const REDIRECT_RE = /^(?:\d+|&)?(?:>>?\|?)(?:\S*)$|^(?:\d+|&)?<(?:\S*)$/;

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
    if (/^(?:\d+|&)?(?:>>?\|?)$/.test(t) || /^(?:\d+|&)?<$/.test(t)) i++;
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

