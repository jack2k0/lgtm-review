import { splitSegments, stripHeredocs } from "./check-patterns-segments.js";
import {
  matchSegment,
  normalizeFirstToken,
  parseArgs,
  stripPrefixes,
  tokens,
  valsOf,
  NX_VALUE_OPTS,
  PM_CHECK_BINS,
  PM_VALUE_OPTS,
  TURBO_VALUE_OPTS,
  type RepoScripts,
} from "./check-patterns-classify.js";

/**
 * The family of a check: what its result says something about. The status keeps the newest result per family,
 * so a later lint or build pass does not hide a failing test (S-38).
 */
export type CheckFamily = "test" | "typecheck" | "lint" | "build" | "other";

export const CHECK_FAMILIES: readonly CheckFamily[] = ["test", "typecheck", "lint", "build", "other"];

export interface CheckFamilies {
  /** Families the check's result belongs to, in `CHECK_FAMILIES` order; at least one. */
  families: CheckFamily[];
  /**
   * An aggregate (`pnpm check`, `make ci`, `scripts/verify.sh`) runs every family: a pass counts for all of them.
   * A failure of an aggregate does not say which family failed and is kept under `other` only.
   */
  aggregate: boolean;
}

const AGGREGATE_NAMES = new Set(["check", "ci", "verify", "validate", "all", "gate"]);
const NAME_FAMILY: Record<string, CheckFamily> = {
  test: "test",
  t: "test",
  vitest: "test",
  jest: "test",
  pytest: "test",
  typecheck: "typecheck",
  "type-check": "typecheck",
  tsc: "typecheck",
  lint: "lint",
  eslint: "lint",
  build: "build",
  compile: "build",
};

/** `null` for an aggregate, else the family of a script, make target or just recipe name (`test:unit` -> `test`). */
function nameFamily(name: string): CheckFamily | null {
  const base = (name.split(":")[0] ?? name).toLowerCase();
  if (AGGREGATE_NAMES.has(base)) return null;
  return NAME_FAMILY[base] ?? "other";
}

interface Acc {
  families: Set<CheckFamily>;
  aggregate: boolean;
}

function addName(acc: Acc, name: string): void {
  const f = nameFamily(name);
  if (f === null) acc.aggregate = true;
  else acc.families.add(f);
}

function taskNames(values: readonly string[]): string[] {
  return values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
}

function addTurbo(acc: Acc, toks: readonly string[]): void {
  const cut = toks.indexOf("--");
  const opts = parseArgs(cut < 0 ? toks : toks.slice(0, cut), 1, TURBO_VALUE_OPTS);
  const tasks = opts.pos[0] === "run" ? opts.pos.slice(1) : opts.pos;
  for (const t of tasks) addName(acc, t);
}

function addNx(acc: Acc, toks: readonly string[]): void {
  const opts = parseArgs(toks, 1, NX_VALUE_OPTS);
  const command = opts.pos[0];
  if (command === "run-many" || command === "affected") for (const t of taskNames(valsOf(opts, "-t", "--targets"))) addName(acc, t);
  else if (command === "run") {
    const spec = opts.pos[1] ?? "";
    const colon = spec.indexOf(":");
    if (colon >= 0) addName(acc, spec.slice(colon + 1));
  } else if (command !== undefined) addName(acc, command);
}

function addPackageManager(acc: Acc, pm: string, toks: string[], repo: RepoScripts | undefined): void {
  const valueOpts = PM_VALUE_OPTS[pm] ?? new Set<string>();
  let i = 1;
  const skipOptions = (): void => {
    while (i < toks.length && (toks[i] as string).startsWith("-")) i += valueOpts.has(toks[i] as string) ? 2 : 1;
  };
  skipOptions();
  const word = toks[i];
  if (word === undefined) return;
  if (word === "exec" || word === "dlx") {
    i++;
    if (toks[i] === "--") i++;
    addSegment(acc, toks.slice(i).join(" "), repo);
    return;
  }
  if (pm !== "npm" && PM_CHECK_BINS.has(word) && !repo?.packageScripts.includes(word)) {
    addSegment(acc, toks.slice(i).join(" "), repo);
    return;
  }
  if (word === "turbo") return addTurbo(acc, toks.slice(i));
  if (word === "nx") return addNx(acc, toks.slice(i));
  if (word === "run" || word === "run-script") {
    i++;
    skipOptions();
    const script = toks[i];
    if (script !== undefined) addName(acc, script);
    return;
  }
  addName(acc, word);
}

function addMake(acc: Acc, toks: string[], repo: RepoScripts | undefined): void {
  const valueOpts = new Set(["-C", "-f", "-j", "--directory", "--file", "--jobs"]);
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t.startsWith("-")) {
      if (valueOpts.has(t)) i++;
      continue;
    }
    if (t.includes("=")) continue;
    if (["test", "check", "lint", "build"].includes(t) || repo?.makeTargets.includes(t)) addName(acc, t);
  }
}

function addJust(acc: Acc, toks: string[]): void {
  const valueOpts = new Set(["-d", "-f", "--working-directory", "--justfile", "--chooser", "--color", "--shell"]);
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t.startsWith("-")) {
      if (valueOpts.has(t)) i++;
      continue;
    }
    if (t.includes("=")) continue;
    addName(acc, t);
    return;
  }
}

/** Direct tool invocations (`tsc`, `vitest`, `cargo clippy`, `go vet`, ...). */
function directFamily(s: string, toks: readonly string[]): CheckFamily {
  const py = /^python3?(?:\.\d+)?\s+(?:-\S+\s+)*-m\s+/.exec(s);
  const body = py ? s.slice(py[0].length) : s;
  if (/^(?:tsc|mypy|pyright)(?:\s|$)/.test(body) || /^deno\s+check\b/.test(body) || /^cargo\s+(?:\+\S+\s+)?check\b/.test(body)) return "typecheck";
  if (/^(?:vitest|jest|pytest|py\.test|unittest|bats)(?:\s|$)/.test(body) || /^node\s+(?:\S+\s+)*--test\b/.test(s)) return "test";
  if (/^deno\s+test\b/.test(body) || /^go\s+test\b/.test(body) || /^cargo\s+(?:\+\S+\s+)?(?:test|nextest)\b/.test(body)) return "test";
  if (/^dotnet\s+test\b/.test(body) || /manage\.py\s+test\b/.test(s)) return "test";
  if (/^(?:eslint|biome|flake8|golangci-lint|pylint|shellcheck|hadolint|ruff|black)(?:\s|$)/.test(body)) return "lint";
  if (/^deno\s+lint\b/.test(body) || /^go\s+vet\b/.test(body) || /^cargo\s+(?:\+\S+\s+)?clippy\b/.test(body)) return "lint";
  if (/^go\s+build\b/.test(body) || /^cargo\s+(?:\+\S+\s+)?build\b/.test(body) || /^dotnet\s+build\b/.test(body)) return "build";
  if (/^mvnw?\s/.test(s)) return toks.includes("test") ? "test" : "build";
  if (/^gradlew?\s/.test(s)) return toks.includes("test") ? "test" : toks.includes("build") ? "build" : "other";
  return "other";
}

function scriptFileFamily(toks: readonly string[]): { family: CheckFamily | null } {
  const path = toks.find((t, i) => i > 0 || !/^(?:bash|sh|zsh)$/.test(t)) ?? "";
  const file = path.split("/").pop() ?? "";
  const stem = file.replace(/\.sh$/, "").toLowerCase();
  if (/^(?:check|ci|verify|validate|gate)/.test(stem)) return { family: null };
  if (/^test/.test(stem)) return { family: "test" };
  if (/^lint/.test(stem)) return { family: "lint" };
  if (/^build/.test(stem)) return { family: "build" };
  return { family: "other" };
}

function addSegment(acc: Acc, raw: string, repo: RepoScripts | undefined): void {
  const s = normalizeFirstToken(stripPrefixes(raw));
  const toks = tokens(s);
  const head = toks[0] ?? "";
  if (head === "pnpm" || head === "npm" || head === "yarn" || head === "bun") return addPackageManager(acc, head, toks, repo);
  if (head === "turbo") return addTurbo(acc, toks);
  if (head === "nx") return addNx(acc, toks);
  if (head === "make") return addMake(acc, toks, repo);
  if (head === "just") return addJust(acc, toks);
  if (/\.sh$/.test(toks.find((t) => !t.startsWith("-") && !/^(?:bash|sh|zsh)$/.test(t)) ?? "")) {
    const r = scriptFileFamily(toks);
    if (r.family === null) acc.aggregate = true;
    else acc.families.add(r.family);
    return;
  }
  acc.families.add(directFamily(s, toks));
}

/**
 * Families of the check segments of a command (a chain keeps one per distinct family). Never throws;
 * a command that is not a check, or that cannot be classified, belongs to `other`.
 */
export function checkFamilies(command: string, repo?: RepoScripts): CheckFamilies {
  try {
    const acc: Acc = { families: new Set(), aggregate: false };
    for (const seg of splitSegments(stripHeredocs(command))) if (matchSegment(seg.text, repo)) addSegment(acc, seg.text, repo);
    if (acc.aggregate) return { families: ["other"], aggregate: true };
    const families = CHECK_FAMILIES.filter((f) => acc.families.has(f));
    return { families: families.length > 0 ? families : ["other"], aggregate: false };
  } catch {
    return { families: ["other"], aggregate: false };
  }
}
