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
 * Extracts Python import statements (`import ...`, `from ... import ...`).
 * Ordered by position in source.
 */
export function extractPythonImports(source: string): PythonImport[] {
  if (typeof source !== "string" || source === "") return [];

  const lineStarts = computeLineStarts(source);

  // Pre-processing (preserving character count and exact offsets):
  // 1. Triple-quoted strings (docstrings) -> replace non-newline chars with spaces
  const withoutDocstrings = source.replace(
    /(?:"""(?:\\.|[\s\S])*?"""|'''(?:\\.|[\s\S])*?''')/g,
    (m) => m.replace(/[^\r\n]/g, " "),
  );

  // 2. Comments `# ...` -> replace with spaces
  const withoutComments = withoutDocstrings.replace(/#[^\r\n]*/g, (m) => " ".repeat(m.length));

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
