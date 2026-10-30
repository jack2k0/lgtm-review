/**
 * Pure, node-free Python import extraction and module resolution for the import map (S-09).
 *
 * Extraction is regex-based with pre-processing (docstrings and comments stripped preserving
 * line numbers, backslash continuation and parenthesized multi-line imports joined).
 * Resolution probes `<mod>.py` and `<mod>/__init__.py` against ordered roots for absolute imports
 * and relative directory ascending for relative imports.
 */

import type { MapHost } from "./map-extract.js";
import { normalizePath } from "./map-extract.js";

export interface PythonImport {
  /** Dotted module name, e.g. "os", "a.b", or relative with leading dots: ".", "..pkg.mod". */
  module: string;
  /** Imported names; empty for plain `import ...` and wildcard `from ... import *`. */
  names: string[];
  /** 1-based start line of the `import` or `from` statement in source. */
  line: number;
}

export interface PythonResolverOptions {
  host: MapHost;
  /** Ordered repo-relative source roots (e.g. `["backend", "src", ""]`). Defaults to `[""]`. */
  roots?: readonly string[];
}

export interface PythonResolver {
  resolve(imp: PythonImport, fromFile: string): string[];
}

function computeLineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAtOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineStarts[mid]! <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return low;
}

/**
 * Blanks comments and string literals (keeping newlines and offsets) so that only code is matched.
 *
 * One left-to-right scan with states code / comment / string. In code, `#` starts a comment to the
 * end of the line — a comment can never open a string, and quotes inside it stay comment text.
 * A `'''` or `"""` starts a triple-quoted string ending at the same three characters, and `'` or `"`
 * starts a single-line string ending at the same unescaped quote or at an unescaped end of line.
 * A backslash inside a string skips the next character (a backslash-newline keeps the newline).
 * Every character of a comment or string, including its quotes, becomes a space, except `\r` and
 * `\n`. String prefixes (`r`, `b`, `f`, `u` and combinations) stay as code before the quote.
 *
 * A quote whose attached prefix run contains an `f`/`F` (as in `f"`, `F'''`, `rf"`, `Rf'''`,
 * `fR`; not `abf"x"`) is an f-string and is scanned with its braces (PEP 701, Python 3.12+):
 * `{{` and `}}` are literal braces; a `{` opens a field whose expression is scanned with
 * `(`,`[`,`{` nesting, the first top-level `:` switches to the format spec, and `}` at depth 0
 * ends the field. Inside a field a string of any quoting — including the outer quote type, which
 * PEP 701 allows to be reused — is scanned as a string, so nested f-strings spanning lines cannot
 * close the outer string early. `#` and stray quotes inside a field or spec are literal (Python
 * has no comments there). An unescaped newline inside a field of a single-quoted f-string, or an
 * unterminated nested string, aborts the f-string at the line like a plain string; when the
 * aborted f-string is triple-quoted the scanner keeps blanking the rest of that same string (its
 * opening quote to the first closing `"""` or end of source) so an abort can never re-enter code
 * state.
 *
 * Backslashes are only "live" in a plain string, where they skip the next character. In an
 * f-string body or field a backslash escapes just the quote character, another backslash or
 * `\r`/`\n` (a line continuation); before any other character only the backslash is consumed, so
 * `\{` still opens a field exactly as in Python 3.12+ (CPython warns there about the invalid
 * escape). Nested f-strings and spec parts are followed up to a fixed nesting cap (far above any
 * valid Python nesting); beyond it a string is scanned like a plain one, so that invalid or
 * hostile input can never grow the recursion without bound.
 */
function blankCommentsAndStrings(src: string): string {
  const out = src.split("");
  const blank = (index: number): void => {
    const ch = src[index];
    if (ch !== "\r" && ch !== "\n") out[index] = " ";
  };
  const n = src.length;
  let i = 0;

  const isPrefixChar = (ch: string): boolean =>
    ch === "r" || ch === "R" || ch === "b" || ch === "B" || ch === "u" || ch === "U" || ch === "f" || ch === "F";
  const isWordChar = (ch: string): boolean =>
    (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_";

  /**
   * Cap on how deeply the scanner follows nested f-strings and spec parts. Python rejects
   * nesting far below this ("too many nested f-strings"), so reaching the cap means invalid or
   * hostile input: the deeper string is then scanned like a plain one (see `blankString`), which
   * keeps the bound on recursion instead of overflowing the call stack.
   */
  const MAX_NESTING = 200;
  let nesting = 0;

  /** True when the prefix run attached to the quote at `at` contains an `f`/`F` (`rf"x"`,
   * `Rf'''`, `fR` are f-strings; `abf"x"` is not). */
  const isFstring = (at: number): boolean => {
    let p = at - 1;
    while (p >= 0 && isPrefixChar(src[p]!)) p--;
    if (p >= 0 && isWordChar(src[p]!)) return false;
    for (let q = p + 1; q < at; q++) {
      const prefixChar = src[q]!;
      if (prefixChar === "f" || prefixChar === "F") return true;
    }
    return false;
  };

  /**
   * Blanks a string body with non-f string semantics, starting just after its opening quote(s):
   * a backslash skips the next character (a backslash-newline keeps the newline); a triple-quoted
   * string ends at the same three characters, a single-line one at the same quote or at the end
   * of the line. Returns whether the closing delimiter was consumed. Never recurses, so it is
   * also the fallback for a nesting-aborted f-string and for strings beyond the nesting cap.
   */
  function blankPlainBody(quote: string, triple: boolean): boolean {
    const width = triple ? 3 : 1;
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") {
        blank(i);
        i++;
        if (i < n) {
          if (src[i] === "\r" && src[i + 1] === "\n") {
            i += 2;
          } else {
            blank(i);
            i++;
          }
        }
        continue;
      }
      if (triple) {
        if (src.startsWith(quote.repeat(width), i)) {
          for (let k = 0; k < width; k++) blank(i + k);
          i += width;
          return true;
        }
      } else if (c === quote) {
        blank(i);
        i++;
        return true;
      } else if (c === "\r" || c === "\n") {
        // An unterminated single-line string ends at the end of its line.
        break;
      }
      blank(i);
      i++;
    }
    return false;
  }

  /**
   * Blanks a string starting at `i` (position of the opening quote). Returns whether the closing
   * delimiter was consumed; an unterminated single-line string leaves `i` on the line break.
   * Declared as a function so a nested string inside an f-string field can recurse back into it.
   */
  function blankString(at: number): boolean {
    const quote = src[at]!;
    const triple = src.startsWith(quote.repeat(3), at);
    const width = triple ? 3 : 1;
    for (let k = 0; k < width; k++) blank(at + k);
    i = at + width;
    if (nesting >= MAX_NESTING) {
      // Nesting is exhausted (MAX_NESTING): nothing can be valid Python at this depth, so the
      // string is scanned like a plain one — its text stays blanked, but no fields or nested
      // f-strings are followed and no further recursion happens.
      blankPlainBody(quote, triple);
      return false;
    }
    if (!isFstring(at)) return blankPlainBody(quote, triple);
    nesting++;
    try {
      return blankFstringBody(quote, triple);
    } finally {
      nesting--;
    }
  }

  /**
   * Blanks the body of an f-string after its opening quote(s). Returns whether the closing
   * delimiter was consumed.
   */
  function blankFstringBody(quote: string, triple: boolean): boolean {
    const width = triple ? 3 : 1;
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") {
        blank(i);
        i++;
        if (i < n) {
          const d = src[i]!;
          if (d === quote || d === "\\" || d === "\r" || d === "\n") {
            if (d === "\r" && src[i + 1] === "\n") {
              i += 2;
            } else {
              blank(i);
              i++;
            }
          }
          // Any other escaped character lets the following character (e.g. `{`) be processed
          // normally: `\{` is still a field opener (invalid escape in CPython).
        }
        continue;
      }
      if (c === "{") {
        if (src[i + 1] === "{") {
          blank(i);
          blank(i + 1);
          i += 2;
          continue;
        }
        blank(i);
        i++;
        if (!blankField(quote, triple)) {
          if (triple) return blankPlainBody(quote, true);
          return false;
        }
        continue;
      }
      if (c === "}") {
        if (src[i + 1] === "}") {
          blank(i);
          blank(i + 1);
          i += 2;
          continue;
        }
        blank(i);
        i++;
        continue;
      }
      if (c === quote) {
        if (src.startsWith(quote.repeat(width), i)) {
          for (let k = 0; k < width; k++) blank(i + k);
          i += width;
          return true;
        }
        blank(i);
        i++;
        continue;
      }
      if ((c === "\r" || c === "\n") && !triple) {
        // An unterminated single-line f-string ends at the end of its line.
        break;
      }
      blank(i);
      i++;
    }
    return false;
  }

  /**
   * Blanks an f-string interpolation `{expression:spec}` (open brace consumed). Bracket nesting
   * tracks `(`, `[`, `{`; the first top-level `:` starts the format spec, where `{` opens a nested
   * dynamic part and the first `}` ends the field. `quote` is the enclosing f-string's quote
   * character, `outerTriple` its line-spanning flag; both feed the same lenient backslash rule as
   * `blankFstringBody`. Returns whether the field's closing `}` was consumed.
   */
  function blankField(quote: string, outerTriple: boolean): boolean {
    let depth = 0;
    let inSpec = false;
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") {
        blank(i);
        i++;
        if (i < n) {
          const d = src[i]!;
          if (d === quote || d === "\\" || d === "\r" || d === "\n") {
            if (d === "\r" && src[i + 1] === "\n") {
              i += 2;
            } else {
              blank(i);
              i++;
            }
          }
          // Any other escaped character lets the following character be processed normally.
        }
        continue;
      }
      if (inSpec) {
        if (c === "{") {
          // Nested dynamic part of the spec (f"{v:{w}}", f"{5:'^10}").
          blank(i);
          i++;
          if (nesting >= MAX_NESTING) return false;
          nesting++;
          try {
            if (!blankField(quote, outerTriple)) return false;
          } finally {
            nesting--;
          }
          continue;
        }
        if (c === "}") {
          blank(i);
          i++;
          return true;
        }
        // `#`, a lone quote, further colons: literal format-spec characters.
        blank(i);
        i++;
        continue;
      }
      if (outerTriple && src.startsWith(quote.repeat(3), i)) {
        if (src.indexOf(quote.repeat(3), i + 3) === -1) {
          return false;
        }
      }
      if (c === "'" || c === '"') {
        // Nested string of any quoting (PEP 701): scanned on its own so it cannot close the outer
        // f-string; an unterminated one aborts the whole f-string at its line.
        if (!blankString(i)) return false;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        depth++;
        blank(i);
        i++;
        continue;
      }
      if (c === ")" || c === "]") {
        if (depth > 0) depth--;
        blank(i);
        i++;
        continue;
      }
      if (c === "}") {
        if (depth > 0) {
          depth--;
          blank(i);
          i++;
          continue;
        }
        blank(i);
        i++;
        return true;
      }
      if (c === ":" && depth === 0) {
        inSpec = true;
        blank(i);
        i++;
        continue;
      }
      if ((c === "\r" || c === "\n") && !outerTriple) {
        // A field of a single-quoted f-string cannot span lines.
        break;
      }
      blank(i);
      i++;
    }
    return false;
  }

  while (i < n) {
    const ch = src[i]!;

    if (ch === "#") {
      while (i < n && src[i] !== "\r" && src[i] !== "\n") {
        blank(i);
        i++;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      blankString(i);
      continue;
    }

    i++;
  }

  return out.join("");
}

/**
 * Extracts Python import statements (`import ...`, `from ... import ...`).
 * Ordered by position in source.
 */
export function extractPythonImports(source: string): PythonImport[] {
  if (typeof source !== "string" || source === "") return [];

  const lineStarts = computeLineStarts(source);

  // Pre-processing (preserving character count and exact offsets):
  // 1-2. Comments and string literals (single, double, triple quoted) -> spaces
  const withoutComments = blankCommentsAndStrings(source);

  // 3. Backslash continuation `\\[ \t]*\r?\n` -> replace with spaces
  const withoutBackslashes = withoutComments.replace(/\\(?:[ \t]*\r?\n)/g, (m) => " ".repeat(m.length));

  // 4. Multi-line parenthesized `from ... import (...)` -> replace \r and \n between parens with spaces
  const chars = withoutBackslashes.split("");
  const FROM_PAREN_RE = /\bfrom[ \t]+[.a-zA-Z0-9_]+[ \t]+import[ \t]*\(/g;
  let mParen: RegExpExecArray | null;
  while ((mParen = FROM_PAREN_RE.exec(withoutBackslashes)) !== null) {
    const openIdx = mParen.index + mParen[0].length - 1;
    let depth = 1;
    let closeIdx = openIdx + 1;
    while (closeIdx < chars.length && depth > 0) {
      if (chars[closeIdx] === "(") depth++;
      else if (chars[closeIdx] === ")") depth--;
      closeIdx++;
    }
    if (depth === 0) {
      for (let j = openIdx + 1; j < closeIdx - 1; j++) {
        if (chars[j] === "\r" || chars[j] === "\n") {
          chars[j] = " ";
        }
      }
    }
  }
  const preprocessed = chars.join("");

  interface Match {
    offset: number;
    imp: PythonImport;
  }
  const matches: Match[] = [];

  // Match `import ...`
  const IMPORT_RE = /(?:^|[\r\n;])[ \t]*import[ \t]+([^\r\n;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(preprocessed)) !== null) {
    const kwOffset = m.index + m[0].indexOf("import");
    const line = lineAtOffset(lineStarts, kwOffset);
    const rawMods = m[1]!;
    const pieces = rawMods.split(",");
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const modPart = trimmed.split(/\s+as\s+/)[0]?.trim();
      if (!modPart) continue;
      if (/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(modPart)) {
        matches.push({
          offset: kwOffset,
          imp: { module: modPart, names: [], line },
        });
      }
    }
  }

  // Match `from ... import ...`
  const FROM_RE = /(?:^|[\r\n;])[ \t]*from[ \t]+([.a-zA-Z0-9_]+)[ \t]+import[ \t]+([^\r\n;]+)/g;
  while ((m = FROM_RE.exec(preprocessed)) !== null) {
    const kwOffset = m.index + m[0].indexOf("from");
    const line = lineAtOffset(lineStarts, kwOffset);
    const mod = m[1]!;
    if (mod === "__future__") continue;
    if (!/^(?:\.+|\.*[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)$/.test(mod)) {
      continue;
    }
    let rawNames = m[2]!.trim();
    rawNames = rawNames.replace(/^\s*\(/, "").replace(/\)\s*$/, "").trim();
    if (rawNames === "*") {
      matches.push({
        offset: kwOffset,
        imp: { module: mod, names: [], line },
      });
    } else {
      const pieces = rawNames.split(",");
      const names: string[] = [];
      for (const piece of pieces) {
        const trimmed = piece.trim();
        if (!trimmed) continue;
        const namePart = trimmed.split(/\s+as\s+/)[0]?.replace(/[()]/g, "").trim();
        if (namePart && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(namePart)) {
          names.push(namePart);
        }
      }
      if (names.length > 0) {
        matches.push({
          offset: kwOffset,
          imp: { module: mod, names, line },
        });
      }
    }
  }

  matches.sort((a, b) => a.offset - b.offset);
  return matches.map((item) => item.imp);
}

function insideRoot(path: string): boolean {
  return path !== ".." && !path.startsWith("../") && !path.startsWith("/");
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function ascend(dir: string, times: number): string | null {
  let cur = dir;
  for (let i = 0; i < times; i++) {
    if (cur === "") return null;
    cur = dirname(cur);
  }
  return cur;
}

function cleanRoot(r: string): string {
  const norm = r.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return norm === "." ? "" : norm;
}

function probeModule(host: MapHost, p: string): string | null {
  if (p !== "") {
    const file = `${p}.py`;
    if (host.exists(file)) return file;
  }
  const init = p === "" ? "__init__.py" : `${p}/__init__.py`;
  if (host.exists(init)) return init;
  return null;
}

/**
 * Creates a Python module resolver adhering to S-09 rules (D2, A1, A2).
 */
export function createPythonResolver(opts: PythonResolverOptions): PythonResolver {
  const host = opts.host;
  const rawRoots = opts.roots && opts.roots.length > 0 ? opts.roots : [""];
  const roots = rawRoots.map(cleanRoot);

  return {
    resolve(imp: PythonImport, fromFile: string): string[] {
      const normFrom = normalizePath(fromFile);
      const isRelative = imp.module.startsWith(".");
      const rawHits: string[] = [];

      if (isRelative) {
        // A2 relative resolution
        const matchDots = imp.module.match(/^(\.+)(.*)$/);
        if (!matchDots) return [];
        const dots = matchDots[1]!;
        const k = dots.length;
        const rest = matchDots[2]!.replace(/^\.+/, "");
        const fromDir = dirname(normFrom);
        const baseDir = ascend(fromDir, k - 1);
        if (baseDir === null) return [];

        const restPath = rest === "" ? "" : rest.replace(/\./g, "/");
        const target = baseDir === "" ? restPath : restPath === "" ? baseDir : `${baseDir}/${restPath}`;

        if (imp.names.length === 0) {
          const hit = probeModule(host, target);
          if (hit !== null) rawHits.push(hit);
        } else {
          let missed = false;
          for (const name of imp.names) {
            const sub = target === "" ? name : `${target}/${name}`;
            const hit = probeModule(host, sub);
            if (hit !== null) rawHits.push(hit);
            else missed = true;
          }
          if (missed) {
            const fallback = probeModule(host, target);
            if (fallback !== null) rawHits.push(fallback);
          }
        }
      } else {
        // Absolute resolution
        const relMod = imp.module.replace(/\./g, "/");
        for (const R of roots) {
          const target = R === "" ? relMod : `${R}/${relMod}`;
          if (imp.names.length === 0) {
            const hit = probeModule(host, target);
            if (hit !== null) {
              rawHits.push(hit);
              break;
            }
          } else {
            const rootSubHits: string[] = [];
            let missed = false;
            for (const name of imp.names) {
              const sub = `${target}/${name}`;
              const hit = probeModule(host, sub);
              if (hit !== null) rootSubHits.push(hit);
              else missed = true;
            }
            const fallback = missed ? probeModule(host, target) : null;
            if (rootSubHits.length > 0 || fallback !== null) {
              rawHits.push(...rootSubHits);
              if (fallback !== null) rawHits.push(fallback);
              break;
            }
          }
        }
      }

      // Deduplicate, enforce insideRoot, exclude self-import
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const p of rawHits) {
        const norm = normalizePath(p);
        if (!insideRoot(norm)) continue;
        if (norm === normFrom) continue;
        if (seen.has(norm)) continue;
        seen.add(norm);
        deduped.push(norm);
      }
      return deduped;
    },
  };
}
