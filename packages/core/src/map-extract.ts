/**
 * Pure, node-free import extraction and specifier resolution for the import map (S-04).
 *
 * The extractor is regex-based on purpose (plan M7): comments and string-literal-only lines are not
 * stripped, so a specifier-looking string inside a string literal may be reported. Everything here
 * is deterministic and never touches the filesystem; path existence and tsconfig JSON come from an
 * injected host (plan M7/M10).
 */

/** Syntax that produced an extracted specifier. */
export type ImportSyntax = "import" | "type-import" | "export" | "dynamic-import" | "require";

export interface ExtractedImport {
  /** Specifier with a query/hash removed (`?raw`, `?url`, `#fragment`). */
  specifier: string;
  syntax: ImportSyntax;
  /** 1-based line of the match. */
  line: number;
}

/** Satisfied by the CLI's filesystem adapter; `exists` reports files (not directories). */
export interface MapHost {
  exists(path: string): boolean;
  /** Parsed JSON, a raw JSON string (comments tolerated), or undefined when unreadable. */
  readJson?(path: string): unknown;
}

export interface TsconfigAlias {
  /** Literal or a single `*` pattern. */
  pattern: string;
  /** Targets relative to the project root, in declaration order. */
  targets: readonly string[];
}

/** Extensions tried in the plan's resolution order (M7). */
export const IMPORT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

const TS_SOURCE_RE = /\.(?:m|c)?[jt]sx?$/;
const TS_DECL_RE = /\.d\.(?:m|c)?ts$/;

/** Identifies language of a source path for the import map (plan D3). */
export function mapLanguageOf(path: string): "ts" | "py" | null {
  if (typeof path !== "string" || path === "") return null;
  if (path.endsWith(".pyi") || TS_DECL_RE.test(path)) return null;
  if (path.endsWith(".py")) return "py";
  if (TS_SOURCE_RE.test(path)) return "ts";
  return null;
}

const FROM_IMPORT_RE = /\bimport\s+(type\s+)?([^;'"`]*?)\bfrom\s*(["'])([^"'`\n]+)\3/g;
const SIDE_EFFECT_RE = /\bimport\s*(["'])([^"'`\n]+)\1/g;
const EXPORT_FROM_RE = /\bexport\s+(type\s+)?(?:[^;'"`]*?)\bfrom\s*(["'])([^"'`\n]+)\2/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(["'])([^"'`\n]+)\1\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*(["'])([^"'`\n]+)\1\s*\)/g;

/** The map draws `type` imports dashed and every other kind as a normal import. */
export function edgeKindFor(syntax: ImportSyntax): "import" | "type" {
  return syntax === "type-import" ? "type" : "import";
}

/** Strips a query (`?raw`) or hash from a specifier; trims whitespace. */
export function cleanSpecifier(raw: string): string {
  const s = raw.trim();
  const cut = s.search(/[?#]/);
  return (cut === -1 ? s : s.slice(0, cut)).trim();
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

interface Match {
  index: number;
  specifier: string;
  syntax: ImportSyntax;
}

function collect(source: string, re: RegExp, specifierGroup: number, syntax: ImportSyntax, typeGroup?: number, out: Match[] = []): Match[] {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++;
    const raw = m[specifierGroup];
    if (raw === undefined) continue;
    const specifier = cleanSpecifier(raw);
    if (specifier === "") continue;
    out.push({ index: m.index, specifier, syntax: typeGroup !== undefined && m[typeGroup] !== undefined ? "type-import" : syntax });
  }
  return out;
}

/**
 * Extracts static/dynamic ESM imports, `export ... from` re-exports and literal `require` calls.
 * Template-literal and computed specifiers are ignored (plan M7). Results are ordered by position.
 */
export function extractImports(source: string): ExtractedImport[] {
  if (typeof source !== "string" || source === "") return [];
  const matches: Match[] = [];
  collect(source, FROM_IMPORT_RE, 4, "import", 1, matches);
  collect(source, SIDE_EFFECT_RE, 2, "import", undefined, matches);
  collect(source, EXPORT_FROM_RE, 3, "export", 1, matches);
  collect(source, DYNAMIC_IMPORT_RE, 2, "dynamic-import", undefined, matches);
  collect(source, REQUIRE_RE, 2, "require", undefined, matches);
  matches.sort((a, b) => a.index - b.index);
  return matches.map((m) => ({ specifier: m.specifier, syntax: m.syntax, line: lineAt(source, m.index) }));
}

// --- paths (posix, node-free) -----------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Collapses `.`/`..` and duplicate slashes; returns `..`-prefixed paths when escaping the root. */
export function normalizePath(path: string): string {
  const abs = path.startsWith("/");
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!abs) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join("/");
  return abs ? `/${joined}` : joined === "" ? "." : joined;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function joinPath(a: string, b: string): string {
  if (a === "" || a === ".") return b;
  return `${a.replace(/\/+$/, "")}/${b}`;
}

/** True when the path is a plain repo-relative path that cannot escape the project root. */
function insideRoot(path: string): boolean {
  return path !== ".." && !path.startsWith("../") && !path.startsWith("/");
}

// --- tsconfig (plan M7) -----------------------------------------------------------------------

/** Removes `//` and block comments outside JSON strings. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function readJson(host: MapHost, path: string): Record<string, unknown> | null {
  if (host.readJson === undefined) return null;
  let value: unknown;
  try {
    value = host.readJson(path);
  } catch {
    return null;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(stripJsonComments(value.replace(/^\uFEFF/, "")));
    } catch {
      return null;
    }
  }
  return isObj(value) ? value : null;
}

function starCount(s: string): number {
  let n = 0;
  for (const c of s) if (c === "*") n++;
  return n;
}

function normalizeTarget(target: string): string {
  return normalizePath(target.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""));
}

function aliasesOf(config: Record<string, unknown>): TsconfigAlias[] {
  const co = config["compilerOptions"];
  if (!isObj(co)) return [];
  const paths = co["paths"];
  if (!isObj(paths)) return [];
  const out: TsconfigAlias[] = [];
  for (const [pattern, value] of Object.entries(paths)) {
    if (starCount(pattern) > 1 || !Array.isArray(value)) continue;
    const targets: string[] = [];
    for (const t of value) {
      if (typeof t !== "string" || t === "" || starCount(t) > 1) continue;
      const normalized = normalizeTarget(t);
      if (insideRoot(normalized)) targets.push(normalized);
    }
    if (targets.length > 0) out.push({ pattern, targets });
  }
  return out;
}

function configFile(path: string): string {
  return /\.json$/i.test(path) ? path : `${path}.json`;
}

/**
 * Loads `compilerOptions.paths` from `<root>/tsconfig.base.json` and `<root>/tsconfig.json`
 * (one `extends` level, JSON-with-comments tolerated). Any unreadable or malformed file is ignored.
 */
export function loadTsconfigAliases(root: string, host: MapHost): TsconfigAlias[] {
  const byPattern = new Map<string, TsconfigAlias>();
  const seen = new Set<string>();
  const rootPrefix = root === "" ? "" : `${root.replace(/\/+$/, "")}/`;
  const withinRoot = (path: string): boolean => (rootPrefix === "" ? insideRoot(path) : path.startsWith(rootPrefix));

  const add = (configPath: string, depth: number): void => {
    if (depth > 1 || seen.has(configPath) || !withinRoot(configPath)) return;
    seen.add(configPath);
    const config = readJson(host, configPath);
    if (config === null) return;
    const parent = config["extends"];
    if (typeof parent === "string" && parent !== "") {
      add(configFile(normalizePath(joinPath(root, parent))), depth + 1);
    }
    for (const alias of aliasesOf(config)) byPattern.set(alias.pattern, alias);
  };

  add(configFile(normalizePath(joinPath(root, "tsconfig.base.json"))), 0);
  add(configFile(normalizePath(joinPath(root, "tsconfig.json"))), 0);
  return [...byPattern.values()];
}

// --- resolver (plan M7) -----------------------------------------------------------------------

export interface ResolverOptions {
  host: MapHost;
  /** Prefix passed to `host.exists`; returned paths stay repo-relative. */
  root?: string;
  aliases?: readonly TsconfigAlias[];
}

export interface Resolver {
  /** Resolves `specifier` as imported from `fromFile`; null when external, missing or outside the root. */
  resolve(specifier: string, fromFile: string): string | null;
}

function aliasBase(specifier: string, aliases: readonly TsconfigAlias[]): string[] {
  const exact: TsconfigAlias[] = [];
  const wild: { alias: TsconfigAlias; middle: string; prefix: string }[] = [];
  for (const alias of aliases) {
    const star = alias.pattern.indexOf("*");
    if (star === -1) {
      if (alias.pattern === specifier) exact.push(alias);
      continue;
    }
    const prefix = alias.pattern.slice(0, star);
    const postfix = alias.pattern.slice(star + 1);
    if (specifier.length < prefix.length + postfix.length) continue;
    if (!specifier.startsWith(prefix) || !specifier.endsWith(postfix)) continue;
    wild.push({ alias, middle: specifier.slice(prefix.length, specifier.length - postfix.length), prefix });
  }
  wild.sort((a, b) => b.prefix.length - a.prefix.length || (a.alias.pattern < b.alias.pattern ? -1 : a.alias.pattern > b.alias.pattern ? 1 : 0));
  const bases: string[] = [];
  for (const alias of exact) for (const t of alias.targets) bases.push(normalizeTarget(t));
  for (const w of wild) for (const t of w.alias.targets) bases.push(normalizeTarget(t.replace("*", w.middle)));
  return bases;
}

/**
 * Creates a resolver for relative specifiers and tsconfig path aliases.
 *
 * Resolution order (M7): exact path, then the eight TS/JS extensions, then `/index.<ext>`, then the
 * NodeNext `.js` -> `.ts` rewrite. Bare specifiers hit no alias are treated as external packages.
 */
export function createResolver(opts: ResolverOptions): Resolver {
  const aliases = opts.aliases ?? [];
  const root = opts.root === undefined || opts.root === "." ? "" : opts.root.replace(/\/+$/, "");

  const exists = (path: string): boolean => {
    try {
      return opts.host.exists(root === "" ? path : `${root}/${path}`);
    } catch {
      return false;
    }
  };

  const resolveBase = (base: string): string | null => {
    if (base === "" || !insideRoot(base)) return null;
    if (exists(base)) return base;
    for (const ext of IMPORT_EXTENSIONS) if (exists(base + ext)) return base + ext;
    for (const ext of IMPORT_EXTENSIONS) {
      const index = `${base.replace(/\/+$/, "")}/index${ext}`;
      if (exists(index)) return index;
    }
    if (base.endsWith(".js")) {
      const rewritten = `${base.slice(0, -3)}.ts`;
      if (exists(rewritten)) return rewritten;
    }
    return null;
  };

  return {
    resolve(specifier: string, fromFile: string): string | null {
      const clean = cleanSpecifier(specifier);
      if (clean === "") return null;
      if (clean.startsWith(".")) {
        return resolveBase(normalizePath(joinPath(dirOf(fromFile), clean)));
      }
      if (clean.startsWith("/")) return null;
      for (const base of aliasBase(clean, aliases)) {
        const resolved = resolveBase(base);
        if (resolved !== null) return resolved;
      }
      return null;
    },
  };
}
