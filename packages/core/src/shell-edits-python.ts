import { FILES_MAX, isIgnoredPath, SHELL_EDIT_FILE } from "./shell-edits-words.js";

export const GIT_APPLY_READONLY = new Set(["--check", "--stat", "--numstat", "--summary"]);

const PY_WRITE_RE = /\.write_(?:text|bytes)\s*\(/g;
const PY_OPEN_CALL_RE = /\bopen\s*\(/g;
// R2 (kept) + H4: heredoc-fed python is opaque unless every import is on the allow-list and the source has no
// dunder identifier and none of the dynamic-execution names. Only adds opacity.
const PY_SURFACE_MODULE_RE = /\b(?:import|from)\b[^\n;]*\b(?:os|subprocess|shutil|pty|importlib|ctypes|multiprocessing|pathlib)\b/;
const PY_SURFACE_CALL_RE = /\b(?:exec|eval|compile|__import__|getattr|globals|system|popen|spawn\w*)\b/;
const PY_PATH_IMPORT_RE = /\bfrom\s+pathlib\s+import\s+Path(?:\s+as\s+\w+)?[ \t]*(?=$|[;\n])/gm;
const PY_ALLOWED_MODULES = new Set([
  "json", "re", "math", "sys", "pathlib", "textwrap", "datetime", "collections", "itertools", "functools", "string", "typing",
]);
const PY_IMPORT_RE = /\bfrom\s+(\S+)\s+import\b|(?<!\bfrom\s+\S+\s+)\bimport\s+([^\n;]+)/g;
const PY_DYNAMIC_RE = /\b(?:exec|eval|compile|getattr|setattr|globals|vars|builtins)\b|\b__\w+__\b/;

export function pythonHasSurface(raw: string): boolean {
  const stripped = stripPyComments(raw);
  const body = stripped.replace(PY_PATH_IMPORT_RE, "");
  if (PY_SURFACE_MODULE_RE.test(body) || PY_SURFACE_CALL_RE.test(body)) return true;
  if (PY_DYNAMIC_RE.test(stripped)) return true;
  for (const m of stripped.matchAll(PY_IMPORT_RE)) {
    const mods = m[1] !== undefined ? [m[1]] : (m[2] ?? "").split(",").map((x) => x.trim().split(/\s+/)[0] ?? "");
    for (const mod of mods) if (!PY_ALLOWED_MODULES.has(mod.split(".")[0] ?? "")) return true;
  }
  return false;
}

const PY_BIND_RE = /(?:^|[;\n])[ \t]*(\w+)[ \t]*=(?!=)[ \t]*([^;\n]+)/g;

/** Splits `s` at the top-level occurrences of `sep` (outside quotes and brackets). */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote !== "") {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function joinPath(a: string, b: string): string {
  if (b.startsWith("/")) return b;
  return a === "" || a.endsWith("/") ? a + b : `${a}/${b}`;
}

/**
 * Resolves a Python expression to a string: a literal, `sys.argv[N]`, a bound name, `Path(x)` / `str(x)` / `(x)`,
 * `a + b`, `a / b` and `os.path.join(a, b, ...)` of resolvable parts. Null when any part is unknown.
 */
function pyValue(expr: string, bound: ReadonlyMap<string, string | null>, argv: (string | null)[], depth = 0): string | null {
  const e = expr.trim();
  if (e === "" || depth > 6) return null;
  const lit = /^(['"])([^'"\n]*)\1$/.exec(e);
  if (lit) return lit[2] as string;
  for (const [sep, join] of [
    ["+", (x: string, y: string) => x + y],
    ["/", joinPath],
  ] as const) {
    const parts = splitTop(e, sep);
    if (parts.length > 1) {
      let acc: string | null = null;
      for (const part of parts) {
        const v = pyValue(part, bound, argv, depth + 1);
        if (v === null) return null;
        acc = acc === null ? v : join(acc, v);
      }
      return acc;
    }
  }
  const wrapped = /^(?:(?:pathlib\.)?Path|PurePath|str|os\.fspath)?\(([\s\S]*)\)$/.exec(e);
  if (wrapped) return pyValue(wrapped[1] as string, bound, argv, depth + 1);
  const joinCall = /^os\.path\.join\(([\s\S]*)\)$/.exec(e);
  if (joinCall) {
    let acc: string | null = null;
    for (const part of splitTop(joinCall[1] as string, ",")) {
      const v = pyValue(part, bound, argv, depth + 1);
      if (v === null) return null;
      acc = acc === null ? v : joinPath(acc, v);
    }
    return acc;
  }
  const arg = /^sys\.argv\[\s*(\d+)\s*\]$/.exec(e);
  if (arg) return argv[Number(arg[1]) - 1] ?? null;
  return /^\w+$/.test(e) ? (bound.get(e) ?? null) : null;
}

/** Removes `#` comments outside string literals (an apostrophe in a comment must not open a string). */
function stripPyComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let quote = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i] as string;
        if (quote !== "") {
          if (c === "\\") i++;
          else if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** The text between the parenthesis at `open` and its match (quote-aware), or null when it is not closed. */
function balancedArgs(s: string, open: number): string | null {
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i++) {
    const c = s[i] as string;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return s.slice(open + 1, i);
  }
  return null;
}

/** Start of the receiver expression that ends `prefix` (`Path("x")`, `(a / "b")`, `p`), or null. */
function receiverOf(prefix: string): string | null {
  const t = prefix.trimEnd();
  // A qualified name (`a.b.write_text`, `x[0].write_text`) is not a plain name we can follow.
  if (/[\w)\]]\s*\.\s*\w+$/.test(t) || t.endsWith("]")) return null;
  if (t.endsWith(")")) {
    let depth = 0;
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i] === ")") depth++;
      else if (t[i] === "(" && --depth === 0) {
        const head = /[\w.]*$/.exec(t.slice(0, i));
        return (head?.[0] ?? "") + t.slice(i);
      }
    }
    return null;
  }
  return /\w+$/.exec(t)?.[0] ?? null;
}

interface PyWriteSite {
  at: number;
  expr: string | null;
  /** Identifier starts that belong to this write once its path resolves (`open`, a chained `.write`). */
  tokens: number[];
  /** Start of `open(`, so a wrapping `dump(` can be tied to a resolved open. */
  openAt: number | null;
  /** Body slice whose forbidden names belong to this write once it resolves (the args, or the receiver). */
  span: { abs: number; text: string } | null;
}

interface PyWriteInfo {
  files: string[];
  /** Starts of identifiers that are part of a write whose path resolved (scratch included). */
  owned: Set<number>;
  /** A parsed `open` / `write_text` whose path did not resolve. */
  unresolved: boolean;
  /** A parsed write whose path resolved, including one later dropped as scratch. */
  resolved: boolean;
}

/**
 * Files written by the Python code of one heredoc (`open(path, 'w')`, `.write_text(`). A path resolves when it is a
 * string literal, `sys.argv[N]` (of `python3 - args`), a name bound to such a value by an assignment above the
 * write (the binding in effect at the write counts), or a concatenation / `Path` / `os.path.join` of those.
 */
export function pythonWrites(raw: string, argv: (string | null)[]): string[] {
  return inspectPythonWrites(raw, argv).files;
}

/** Same file list as `pythonWrites`, plus which identifier occurrences sit on a resolved write (C12). */
function inspectPythonWrites(raw: string, argv: (string | null)[]): PyWriteInfo {
  const body = stripPyComments(raw);
  const out: string[] = [];
  let unknown = false;
  let resolved = false;
  const owned = new Set<number>();
  const binds: { at: number; name: string; expr: string; nested: boolean }[] = [];
  for (const m of body.matchAll(PY_BIND_RE)) {
    const name = m[1] as string;
    const at = (m.index ?? 0) + m[0].indexOf(name);
    const lineStart = body.lastIndexOf("\n", at - 1) + 1;
    // An indented binding (inside if / for / with / def) may or may not run: the name is then unresolved.
    const nested = (/^[ \t]*/.exec(body.slice(lineStart))?.[0] ?? "") !== "";
    binds.push({ at, name, expr: m[2] as string, nested });
  }
  const writes: PyWriteSite[] = [];
  for (const m of body.matchAll(PY_OPEN_CALL_RE)) {
    const at = m.index ?? 0;
    const paren = at + m[0].length - 1;
    const args = balancedArgs(body, paren);
    if (args === null) {
      // Cannot tell what is written: stay conservative.
      writes.push({ at, expr: null, tokens: [], openAt: null, span: null });
      continue;
    }
    const parts = splitTop(args, ",").map((x) => x.trim());
    const kw = parts.find((x) => /^mode\s*=/.test(x));
    const mode = kw !== undefined ? kw.replace(/^mode\s*=\s*/, "") : parts[1] !== undefined && !/^\w+\s*=(?!=)/.test(parts[1]) ? parts[1] : undefined;
    if (mode === undefined) continue; // open(path): read
    const lit = /^(['"])([^'"\n]*)\1$/.exec(mode);
    if (lit && !/[wax+]/.test(lit[2] as string)) continue; // a literal read mode
    const after = paren + 1 + args.length + 1;
    const tokens = [at];
    const chained = /^\s*\.\s*write\b/.exec(body.slice(after));
    if (chained) tokens.push(after + chained[0].lastIndexOf("write"));
    writes.push({ at, expr: lit ? (parts[0] ?? null) : null, tokens, openAt: at, span: { abs: paren + 1, text: args } });
  }
  for (const m of body.matchAll(PY_WRITE_RE)) {
    const at = m.index ?? 0;
    const prefixStart = Math.max(0, at - 300);
    const prefix = body.slice(prefixStart, at);
    const recv = receiverOf(prefix);
    const trimmed = prefix.trimEnd();
    const span = recv !== null && trimmed.endsWith(recv) ? { abs: prefixStart + trimmed.length - recv.length, text: recv } : null;
    writes.push({ at, expr: recv, tokens: [], openAt: null, span });
  }
  writes.sort((x, y) => x.at - y.at);
  const bound = new Map<string, string | null>();
  let bi = 0;
  for (const w of writes) {
    while (bi < binds.length && (binds[bi] as { at: number }).at < w.at) {
      const b = binds[bi++] as { name: string; expr: string; nested: boolean };
      bound.set(b.name, b.nested ? null : pyValue(b.expr, bound, argv));
    }
    const v = w.expr === null ? null : pyValue(w.expr, bound, argv);
    if (v === null || v === "") unknown = true;
    else {
      resolved = true;
      if (!isIgnoredPath(v)) out.push(v);
      for (const t of w.tokens) owned.add(t);
    }
    if (out.length >= FILES_MAX) {
      unknown = true; // cut: more writes may follow
      break;
    }
  }
  if (unknown) out.push(SHELL_EDIT_FILE);
  return { files: out, owned, unresolved: unknown, resolved };
}

