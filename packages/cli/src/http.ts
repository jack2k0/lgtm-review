import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Handles an authenticated GET/HEAD under /api/. Return false when the path is unknown (-> 404). */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;

/** `Cache-Control` of the four conditional routes: revalidate every time, never stored by shared caches. */
export const CONDITIONAL_CACHE_CONTROL = "no-cache, private";

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, etag?: string): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": etag === undefined ? "no-store" : CONDITIONAL_CACHE_CONTROL,
    ...(etag === undefined ? {} : { ETag: etag }),
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

/** Strong validator: `"` + first 16 hex chars of sha256(key) + `"`. */
export function etagFor(key: string): string {
  return `"${createHash("sha256").update(key).digest("hex").slice(0, 16)}"`;
}

const TAG_RE = /(?:W\/)?"[^"]*"/g;
const LIST_RE = /^\s*(?:W\/)?"[^"]*"(?:\s*,\s*(?:W\/)?"[^"]*")*\s*$/;

/**
 * Evaluates `If-None-Match` against `etag` (weak comparison: `W/` prefixes are ignored; several tags are
 * accepted). `*` matches only when `allowStar` (the resource is known to exist).
 */
export function ifNoneMatch(header: string | string[] | undefined, etag: string, allowStar = true): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (value === undefined) return false;
  if (value.trim() === "*") return allowStar;
  if (!LIST_RE.test(value)) return false; // malformed header: ignored
  for (const m of value.matchAll(TAG_RE)) {
    if (m[0].replace(/^W\//, "") === etag) return true;
  }
  return false;
}

/** `304 Not Modified`: no body; the security headers set earlier on `res` are kept. */
export function sendNotModified(res: ServerResponse, etag: string): void {
  res.writeHead(304, { "Cache-Control": CONDITIONAL_CACHE_CONTROL, ETag: etag });
  res.end();
}
