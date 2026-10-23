import type { Hint, HintRule, Recommendation, Severity, Status } from "./schema.js";

/**
 * Review hints ("look here") and the per-prompt recommendation (docs/PROPOSAL.md 9.7).
 * Pure and deterministic; imports nothing from Node. The parser only collects small counters per
 * edit (see `EditStats`), never the lines themselves; every rule below works on those counters
 * and on the edited paths.
 */

/** Lines inspected per edit / created file / tool result; the rest of a huge change is ignored. */
export const EVIDENCE_LINES_MAX = 2000;
/** More changed lines than this in one file within one prompt => `large-change`. */
export const LARGE_CHANGE_LINES = 300;

/** Counters of assertion-like and skip-marker lines of one edit. */
export interface EditStats {
  assertAdded: number;
  assertRemoved: number;
  skipAdded: number;
  skipRemoved: number;
}

export function emptyStats(): EditStats {
  return { assertAdded: 0, assertRemoved: 0, skipAdded: 0, skipRemoved: 0 };
}

// --- line evidence ---------------------------------------------------------------------------

/** `expect(` (not `.expect(`), `assertX(`, `self.assertX(`, `.should`, `require.equal|ok`, python `assert x`. */
const ASSERT_RE = /(?<!\.)\bexpect\s*\(|\bassert[A-Za-z0-9_]*\s*\(|\.\s*should\b|\brequire\.(?:equal|ok)\b|^\s*assert\s/;
const SKIP_RE =
  /\.skip\s*\(|\bxit\s*\(|\bxtest\s*\(|\bxdescribe\s*\(|\bit\.todo\b|\btest\.todo\b|@pytest\.mark\.(?:skip|xfail)|\bt\.Skip(?:f|Now)?\s*\(|@Disabled\b/;
/** Cheap pre-filter: lines without any of these words cannot match the two regexes above. */
const QUICK_RE = /assert|expect|should|require\.|skip|Skip|xit|xtest|xdescribe|todo|xfail|Disabled/;

function scanBody(body: string, added: boolean, s: EditStats): void {
  if (ASSERT_RE.test(body)) {
    if (added) s.assertAdded++;
    else s.assertRemoved++;
  }
  if (SKIP_RE.test(body)) {
    if (added) s.skipAdded++;
    else s.skipRemoved++;
  }
}

/** Counts evidence in unified-diff lines (`+`/`-` prefixed; context lines are ignored). `budget.left` is shared across calls. */
export function scanDiffLines(lines: readonly unknown[], s: EditStats, budget: { left: number }): void {
  for (const l of lines) {
    if (budget.left <= 0) return;
    if (typeof l !== "string") continue;
    const c = l.charCodeAt(0);
    if (c !== 43 && c !== 45) continue;
    budget.left--;
    if (!QUICK_RE.test(l)) continue;
    scanBody(l.slice(1), c === 43, s);
  }
}

/** Counts evidence in the first lines of a whole text that was written to a file (all lines count as added). */
export function scanContent(content: string, s: EditStats, max: number = EVIDENCE_LINES_MAX): void {
  let pos = 0;
  for (let n = 0; n < max && pos <= content.length; n++) {
    let end = content.indexOf("\n", pos);
    if (end === -1) end = content.length;
    if (end > pos) {
      const line = content.slice(pos, end);
      if (QUICK_RE.test(line)) scanBody(line, true, s);
    }
    pos = end + 1;
  }
}

// --- path classifiers ------------------------------------------------------------------------

/** Path as seen by the classifiers: forward slashes, relative to `cwd` when inside it. */
export function relativePath(path: string, cwd: string | null): string {
  const p = path.replace(/\\/g, "/");
  if (cwd === null || cwd === "") return p;
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return base !== "" && p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
}

function split(rel: string): { dirs: string[]; name: string } {
  const segs = rel.split("/").filter((s) => s !== "");
  const name = segs.pop() ?? "";
  return { dirs: segs, name };
}

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec"]);

/** Test file: a `test`/`tests`/`__tests__`/`spec` directory, `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `tests.py`, `conftest.py` or `*_test.go`. */
export function isTestPath(rel: string): boolean {
  const { dirs, name } = split(rel);
  if (dirs.some((d) => TEST_DIRS.has(d.toLowerCase()))) return true;
  const n = name.toLowerCase();
  return /\.(?:test|spec)\.[^./]+$/.test(n) || /^(?:test_.*|.*_test|tests?|conftest)\.py$/i.test(n) || /_test\.go$/.test(n);
}

const SENSITIVE_WORDS = new Set([
  "auth",
  "authentication",
  "authorization",
  "login",
  "password",
  "passwords",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "token",
  "tokens",
  "migrations",
  "migrate",
  "permissions",
  "security",
]);
const SENSITIVE_EXCLUDED = /^(?:author(?!iz|is)|design[-_]?tokens|tokenizer)/i;
const STYLE_EXT = /\.(?:css|scss|sass|less)$/i;

/** Words of a path segment: split on `-`, `_`, `.` and camelCase humps, lower-cased. */
function words(seg: string): string[] {
  return seg
    .split(/[-_.]|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase());
}

/**
 * Sensitive path (auth, secrets, credentials, tokens, migrations, CI, Dockerfile, .env ...):
 * whole path segments or file-name words, never substrings (`author.ts`, `tokenizer.ts`,
 * `design-tokens.ts` and style sheets do not match). Returns what matched, or null.
 */
export function sensitiveMatch(rel: string): string | null {
  const segs = rel.split("/").filter((s) => s !== "");
  if (segs.length === 0) return null;
  const name = segs[segs.length - 1]!;
  if (STYLE_EXT.test(name)) return null;
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === ".github" && segs[i + 1] === "workflows") return ".github/workflows";
  }
  const lower = name.toLowerCase();
  if (lower.startsWith(".env")) return ".env";
  if (lower.startsWith("dockerfile")) return "Dockerfile";
  for (const seg of segs) {
    if (SENSITIVE_EXCLUDED.test(seg)) continue;
    for (const w of words(seg)) if (SENSITIVE_WORDS.has(w)) return w;
  }
  return null;
}

const MANIFEST_RE =
  /^(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|pipfile(?:\.lock)?|setup\.(?:py|cfg)|go\.mod|go\.sum|cargo\.toml|cargo\.lock|pom\.xml|build\.gradle[^/]*)$/;

/** Dependency manifest or lockfile (path-based; the dependencies section is not parsed). */
export function isManifestPath(rel: string): boolean {
  return MANIFEST_RE.test(split(rel).name.toLowerCase());
}

const ENTRY_RE = /^index\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** Public surface kind of a path (package entry point, route/API directory, schema/OpenAPI file), or null. */
export function publicSurfaceKind(rel: string): string | null {
  const { dirs, name } = split(rel);
  const lowDirs = dirs.map((d) => d.toLowerCase());
  const lowName = name.toLowerCase();
  if (ENTRY_RE.test(lowName) && (lowDirs.length === 0 || lowDirs[lowDirs.length - 1] === "src" || lowDirs[lowDirs.length - 1] === "lib")) {
    return "package entry point";
  }
  if (
    lowDirs.includes("routes") ||
    lowDirs.includes("api") ||
    lowName === "urls.py" ||
    lowName === "views.py" ||
    lowName === "serializers.py" ||
    lowName === "api.py" ||
    (lowName.endsWith(".py") && (lowDirs.includes("views") || lowDirs.includes("urls")))
  ) {
    return "routes or API";
  }
  if ([...lowDirs, lowName].some((s) => s.includes("openapi") || s.includes("schema"))) return "schema or OpenAPI";
  return null;
}

const CONFIG_NAME_RE =
  /^(?:tsconfig(?:\..+)?\.json|\.?eslintrc(?:\..+)?|eslint\.config\.[a-z]+|biome\.jsonc?|\.prettierrc(?:\..+)?|prettier\.config\.[a-z]+|(?:vite|vitest|webpack|rollup|tsup)\.config\.[a-z.]+|\.gitlab-ci\.ya?ml|\.travis\.ya?ml|azure-pipelines\.ya?ml|jenkinsfile|tox\.ini|pytest\.ini|mypy\.ini|\.flake8|\.?ruff\.toml|\.pre-commit-config\.ya?ml|noxfile\.py)$/;

/** Build, lint, formatter, TypeScript, Python or CI configuration. */
export function isConfigPath(rel: string): boolean {
  const { dirs, name } = split(rel);
  const lowName = name.toLowerCase();
  if (CONFIG_NAME_RE.test(lowName)) return true;
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i] === ".circleci") return true;
    if (dirs[i] === ".github" && dirs[i + 1] === "workflows") return true;
  }
  if (lowName === "settings.py" || lowName === "wsgi.py" || lowName === "asgi.py") return true;
  if (lowName.endsWith(".py") && dirs.some((d) => d.toLowerCase() === "settings")) return true;
  return false;
}

// --- rules -----------------------------------------------------------------------------------

/** One successful file edit with the counters collected while parsing. */
export interface EditEvidence {
  /** Position of the edit in the event stream (same clock as the check sequence numbers). */
  seq: number;
  path: string;
  /** The edit was made while the last completed check had failed (Fix phase). */
  inFix: boolean;
  /** Added + removed lines of this edit. */
  changed: number;
  stats: EditStats;
}

export interface HintInput {
  edits: readonly EditEvidence[];
  /** Sequence number at which the last completed check finished; null when none did. */
  lastCheckSeq: number | null;
  /** Working directory of the session; paths inside it are classified relative to it. */
  cwd: string | null;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, warn: 1, info: 2 };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic order: severity (high, warn, info), then rule, then path. */
export function compareHints(a: Hint, b: Hint): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || cmp(a.rule, b.rule) || cmp(a.path ?? "", b.path ?? "");
}

interface FileAgg {
  path: string;
  rel: string;
  isTest: boolean;
  fixEdits: number;
  changed: number;
  lastSeq: number;
  stats: EditStats;
}

/** All hints of one prompt, one per (rule, path), sorted. */
export function computeHints(input: HintInput): Hint[] {
  const files = new Map<string, FileAgg>();
  for (const e of input.edits) {
    let f = files.get(e.path);
    if (!f) {
      const rel = relativePath(e.path, input.cwd);
      f = { path: e.path, rel, isTest: isTestPath(rel), fixEdits: 0, changed: 0, lastSeq: -1, stats: emptyStats() };
      files.set(e.path, f);
    }
    if (e.inFix) f.fixEdits++;
    f.changed += e.changed;
    if (e.seq > f.lastSeq) f.lastSeq = e.seq;
    f.stats.assertAdded += e.stats.assertAdded;
    f.stats.assertRemoved += e.stats.assertRemoved;
    f.stats.skipAdded += e.stats.skipAdded;
    f.stats.skipRemoved += e.stats.skipRemoved;
  }

  const out: Hint[] = [];
  const add = (rule: HintRule, severity: Severity, path: string, reason: string): void => {
    out.push({ rule, severity, path, reason });
  };

  for (const f of files.values()) {
    if (f.isTest) {
      if (f.fixEdits > 0) {
        add("test-modified-during-fix", "high", f.path, `test file edited ${plural(f.fixEdits, "time")} while fixing a failing check`);
      }
      if (f.stats.assertRemoved > f.stats.assertAdded) {
        add("assertions-removed", "high", f.path, `${plural(f.stats.assertRemoved, "assertion line")} removed, ${f.stats.assertAdded} added`);
      }
      if (f.stats.skipAdded > f.stats.skipRemoved) {
        add("test-skipped", "high", f.path, `${plural(f.stats.skipAdded - f.stats.skipRemoved, "skip marker")} added`);
      }
    }
    const sensitive = sensitiveMatch(f.rel);
    if (sensitive !== null) {
      add(
        "sensitive-path",
        f.isTest ? "warn" : "high",
        f.path,
        `path matches sensitive pattern "${sensitive}"${f.isTest ? " (test file)" : ""}`,
      );
    }
    if (input.lastCheckSeq === null || f.lastSeq > input.lastCheckSeq) {
      add("unchecked-edit", "warn", f.path, input.lastCheckSeq === null ? "edited and no check completed in this prompt" : "edited after the last completed check");
    }
    if (isManifestPath(f.rel)) add("dependency-change", "warn", f.path, "dependency manifest or lockfile edited");
    if (!f.isTest) {
      const surface = publicSurfaceKind(f.rel);
      if (surface !== null) add("public-surface", "warn", f.path, `public surface edited (${surface})`);
    }
    if (isConfigPath(f.rel)) add("config-change", "info", f.path, "build, lint, TypeScript or CI configuration edited");
    if (f.changed > LARGE_CHANGE_LINES) add("large-change", "info", f.path, `${f.changed} changed lines (limit ${LARGE_CHANGE_LINES})`);
  }
  return out.sort(compareHints);
}

/**
 * Recommendation of a prompt:
 * `no-changes` => skim; >= 3 distinct high rules, or a failing prompt with any high hint => read-all;
 * any high hint, or a failing/unchecked prompt => read-flagged; otherwise skim.
 */
export function recommend(hints: readonly Hint[], status: Status): Recommendation {
  if (status === "no-changes") return "skim";
  const highRules = new Set<HintRule>();
  for (const h of hints) if (h.severity === "high") highRules.add(h.rule);
  if (highRules.size >= 3) return "read-all";
  if (highRules.size > 0) return status === "failing" ? "read-all" : "read-flagged";
  if (status === "failing" || status === "unchecked") return "read-flagged";
  return "skim";
}
