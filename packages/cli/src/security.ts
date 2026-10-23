import { createHash, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

/** Header carrying the per-run token on every /api/* request. */
export const TOKEN_HEADER = "x-lgtm-token";

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Headers set on every response. No CORS headers are ever set. */
export function baseHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

/** Host must be exactly `127.0.0.1:PORT` or `localhost:PORT` (defeats DNS rebinding). Case-insensitive host name. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** Origin is optional; when present it must be `http://127.0.0.1:PORT` or `http://localhost:PORT` (`null` and anything else is refused). */
export function originAllowed(origin: string | string[] | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** Constant-time token comparison. Both sides are hashed first so length does not leak. */
export function tokenValid(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const TEXT = (t: string) => `${t}; charset=utf-8`;
const MIME: Record<string, string> = {
  ".html": TEXT("text/html"),
  ".js": TEXT("text/javascript"),
  ".mjs": TEXT("text/javascript"),
  ".css": TEXT("text/css"),
  ".svg": TEXT("image/svg+xml"),
  ".json": TEXT("application/json"),
  ".map": TEXT("application/json"),
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function contentTypeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export type StaticResolution =
  | { kind: "file"; path: string; size: number }
  | { kind: "error"; status: 400 | 403 | 404 };

/**
 * Maps a request target to a file strictly inside `webRoot`.
 * Order: must be origin-form; strip query/fragment; percent-decode (URIError -> 400); reject NUL (400) and
 * `..` segments / backslashes (403); realpath the target and require it to sit under realpath(webRoot) (403,
 * which also covers symlinks pointing outside); missing file, missing root or directory -> 404.
 */
export async function resolveStatic(webRoot: string, target: string): Promise<StaticResolution> {
  if (!target.startsWith("/") || target.startsWith("//")) return { kind: "error", status: 400 };
  const rawPath = target.split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { kind: "error", status: 400 };
  }
  if (decoded.includes("\0")) return { kind: "error", status: 400 };
  if (decoded.includes("\\")) return { kind: "error", status: 403 };
  const segments = decoded.split("/");
  if (segments.includes("..")) return { kind: "error", status: 403 };

  const rel = decoded.endsWith("/") ? `${decoded}index.html` : decoded;
  let root: string;
  let real: string;
  try {
    root = await realpath(resolve(webRoot));
    real = await realpath(join(root, rel));
  } catch {
    return { kind: "error", status: 404 };
  }
  if (real !== root && !real.startsWith(root + sep)) return { kind: "error", status: 403 };
  try {
    const st = await stat(real);
    if (!st.isFile()) return { kind: "error", status: 404 };
    return { kind: "file", path: real, size: st.size };
  } catch {
    return { kind: "error", status: 404 };
  }
}
