/**
 * Opt-in local LLM titles: flag parsing only.
 * The request queue and the disk cache writer land in phase 2b.
 * Nothing here opens a connection or creates the cache directory.
 */

import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Default title cache: `~/.lgtm-review/cache/titles`. Not created by reading this. */
export function defaultTitleCacheDir(): string {
  return join(homedir(), ".lgtm-review", "cache", "titles");
}

/**
 * Chat-completions endpoint for `--llm-url`, or an Error whose message the CLI prints.
 * Host is `new URL(s).hostname` after WHATWG canonicalisation. Allowed: a dotted IPv4
 * whose first octet is 127, or `[::1]`. The exact hostname `localhost` is rewritten to
 * `127.0.0.1` and is never resolved through DNS. Every other host is rejected, including
 * `localhost.`, `*.localhost`, `0.0.0.0` and IPv4-mapped IPv6.
 * Path: empty, `/`, `/v1` or `/v1/` becomes `/v1/chat/completions`. A path ending in
 * `/chat/completions` is kept. Any other path, or a query or fragment, is rejected.
 */
export function parseLlmUrl(s: string): URL | Error {
  let raw: URL;
  try {
    raw = new URL(s);
  } catch {
    return new Error("invalid --llm-url");
  }
  if (raw.protocol !== "http:") return new Error("only http:// to a loopback model server is allowed");
  if (raw.username !== "" || raw.password !== "") return new Error("a username or password in --llm-url is not allowed");
  if (raw.search !== "" || raw.hash !== "") return new Error("query and fragment are not allowed on --llm-url");

  const host = loopbackHost(raw.hostname);
  if (host === null) return new Error("only a loopback model server is allowed");

  const path = endpointPath(raw.pathname);
  if (path instanceof Error) return path;

  const port = raw.port === "" ? "" : `:${raw.port}`;
  try {
    return new URL(`http://${host}${port}${path}`);
  } catch {
    return new Error("invalid --llm-url");
  }
}

/** Dotted 127.0.0.0/8, `[::1]` (also a bare `::1` if a parser omits the brackets), or exact `localhost`. */
function loopbackHost(hostname: string): string | null {
  if (hostname === "localhost") return "127.0.0.1";
  if (hostname === "[::1]" || hostname === "::1") return "[::1]";
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (m === null) return null;
  const octets = [m[1], m[2], m[3]];
  if (octets.every((o) => Number(o) <= 255)) return hostname;
  return null;
}

function endpointPath(pathname: string): string | Error {
  if (pathname === "" || pathname === "/" || pathname === "/v1" || pathname === "/v1/") return "/v1/chat/completions";
  if (pathname.endsWith("/chat/completions")) return pathname;
  return new Error("unsupported path in --llm-url");
}

export type TitleCacheResolution = { dir: string } | { error: string };

/**
 * Absolute real path of the title cache, or why it must not be used.
 * Rejects a symlink at the cache path itself (not followed), a path that exists and is
 * not a directory, and a path inside a repository checkout, the projects dir or the
 * archive dir. Does not create the directory. A missing path is fine.
 */
export function resolveTitleCacheDir(cacheDir: string, projectsDir: string, archiveDir: string, repoDirs: readonly string[]): TitleCacheResolution {
  if (cacheDir.trim() === "" || /[\r\n]/.test(cacheDir)) return { error: "cache dir is empty" };

  const full = resolve(cacheDir);
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return { error: `cache dir ${cacheDir} cannot be used (${code ?? "error"})` };
  }
  if (st?.isSymbolicLink()) return { error: `cache dir ${cacheDir} is a symlink` };
  if (st !== undefined && !st.isDirectory()) return { error: `cache dir ${cacheDir} is not a directory` };

  const cache = realResolve(cacheDir);
  for (const d of repoDirs) {
    if (isInside(cache, realResolve(d))) return { error: `cache dir ${cacheDir} is inside the repository ${d}` };
  }
  if (isInside(cache, realResolve(projectsDir))) return { error: `cache dir ${cacheDir} is inside the Claude Code projects dir ${projectsDir}` };
  if (isInside(cache, realResolve(archiveDir))) return { error: `cache dir ${cacheDir} is inside the archive dir ${archiveDir}` };
  return { dir: cache };
}

/** Real path of `p`; when it does not exist yet, the real path of its nearest existing parent plus the rest. */
function realResolve(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel));
}
