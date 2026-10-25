import { normalizePath } from "./shell-edits.js";

/** A check's resolved scope: where it ran and how to show it. */
export interface ResolvedScope {
  /** Absolute, normalised paths the check ran on. */
  roots: string[];
  /** Roots relative to the session root ("…/a/b" for roots outside it), at most two then "+N", <= 60 chars. */
  label: string;
}

/** Folder names that hold tests; a root made only of these is the whole test suite. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);

export const SCOPE_LABEL_MAX = 60;

const isAbs = (p: string): boolean => p.startsWith("/");

/** Prefix that every path inside `dir` starts with. */
const childPrefix = (dir: string): string => (dir.endsWith("/") ? dir : `${dir}/`);

/**
 * Resolves the raw roots of a check (as written in the command) against the working directory of
 * the tool call (`base`) and the session root. Returns `null` when the check cannot be placed or
 * when it covers the whole project (the session root, an ancestor of it, or the test suite).
 */
export function resolveScope(raw: readonly string[] | null, base: string | null, sessionRoot: string | null): ResolvedScope | null {
  if (raw === null || raw.length === 0) return null;
  if (base === null || !isAbs(base)) return null;
  if (sessionRoot === null || !isAbs(sessionRoot)) return null;
  const session = normalizePath(sessionRoot);
  const sessionPrefix = childPrefix(session);
  const roots: string[] = [];
  for (const r of raw) {
    const root = normalizePath(isAbs(r) ? r : `${base}/${r}`);
    if (root === "/" || root === session || session.startsWith(childPrefix(root))) return null;
    if (root.startsWith(sessionPrefix)) {
      const rel = root.slice(sessionPrefix.length).split("/");
      if (rel.every((seg) => TEST_DIRS.has(seg.toLowerCase()))) return null;
    }
    if (!roots.includes(root)) roots.push(root);
  }
  const parts = roots.map((root) => (root.startsWith(sessionPrefix) ? root.slice(sessionPrefix.length) : outsideLabel(root)));
  const extra = parts.length - 2;
  let label = parts.slice(0, 2).join(", ");
  if (extra > 0) label += ` +${extra}`;
  if (label.length > SCOPE_LABEL_MAX) label = `${label.slice(0, SCOPE_LABEL_MAX - 1)}…`;
  return { roots, label };
}

/** Last two segments of a path outside the session root, shown with a leading ellipsis. */
function outsideLabel(root: string): string {
  const segs = root.split("/").filter((s) => s !== "");
  return `…/${segs.slice(-2).join("/")}`;
}

/** Stem of a file name: up to the first dot, lower-cased, without a `test_` prefix or `_test`/`_spec` suffix. */
function stemOf(name: string): string {
  let stem = name.split(".")[0].toLowerCase();
  if (stem.startsWith("test_")) stem = stem.slice("test_".length);
  stem = stem.replace(/_(test|spec)$/, "");
  return stem;
}

/** The name a root is matched by when it is outside the file's own prefix, or null when it has none. */
function keyOf(root: string): string | null {
  const segs = root.split("/").filter((s) => s !== "");
  if (segs.length === 0) return null;
  const last = segs[segs.length - 1];
  if (last.includes(".")) return stemOf(last);
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i].toLowerCase();
    if (!TEST_DIRS.has(seg)) return seg;
  }
  return null;
}

/** Does a check that ran on `root` cover the edited `file`? Both absolute. */
export function scopeCovers(root: string, file: string): boolean {
  if (file === root || file.startsWith(childPrefix(root))) return true;
  const key = keyOf(root);
  if (key === null) return false;
  const segs = file.split("/").filter((s) => s !== "");
  if (segs.length === 0) return false;
  const name = segs[segs.length - 1];
  if (stemOf(name) === key) return true;
  return segs.slice(0, -1).some((d) => d.toLowerCase() === key);
}

export interface ScopeCheck {
  /** Sequence number at which the check finished. */
  coveredSeq: number;
  passed: boolean;
  /** `null` when the check covers the whole project. */
  scope: ResolvedScope | null;
}

export interface EditedFile {
  path: string;
  /** Sequence number of the file's last edit. */
  lastSeq: number;
}

/**
 * Paths of edited files that no passing check finishing after their last edit covers, in input order.
 * Relative paths (for example the shell-edit placeholder) are never gaps.
 */
export function scopeGaps(files: readonly EditedFile[], checks: readonly ScopeCheck[]): string[] {
  const gaps: string[] = [];
  for (const f of files) {
    if (!isAbs(f.path)) continue;
    const covered = checks.some(
      (c) => c.passed && c.coveredSeq > f.lastSeq && (c.scope === null || c.scope.roots.some((r) => scopeCovers(r, f.path))),
    );
    if (!covered) gaps.push(f.path);
  }
  return gaps;
}
