/**
 * Opt-in local LLM titles: URL and cache-dir checks, plus the one-at-a-time generator.
 * The generator speaks HTTP only to the already-canonical loopback endpoint, caches titles
 * on disk, and creates the cache directory only when it writes a title.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { Agent, request as httpRequest, type ClientRequest } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { TITLE_PROMPT_VERSION, redact, sanitizeTitle, titleRequestBody } from "@lgtm/core";
import type { RedactOptions } from "@lgtm/core";

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

/** Shown after three transport failures. Never includes a response body. */
export const TITLE_ERR_UNREACHABLE = "model server not reachable";
/** Shown after three HTTP or shape failures, or when the per-run request cap is hit. */
export const TITLE_ERR_RESPONSE = "model server returned an error";
/** Model requests (not cache hits) allowed in one process. */
export const TITLE_REQUEST_CAP = 500;
/** Deadline for one model response, including the time to connect. */
export const TITLE_TIMEOUT_MS = 60_000;
/** Consecutive transport, HTTP or shape failures before the queue is drained. */
export const TITLE_FAILURE_LIMIT = 3;
/** Largest response body that is still parsed. One byte more is an error. */
export const TITLE_BODY_CAP = 64 * 1024;
/** Largest cache file that is still parsed. */
export const TITLE_CACHE_READ_MAX = 1024;

/** sha256 hex of `TITLE_PROMPT_VERSION`, the model name and the condensed input, separated by NUL. */
export function titleCacheKey(model: string, input: string): string {
  return createHash("sha256").update(`${TITLE_PROMPT_VERSION}\0${model}\0${input}`).digest("hex");
}

/** What the queue worker returns. `input` is already condensed; `redact` is applied to the sanitised title. */
export interface TitleSource {
  input: string;
  redact: RedactOptions;
}

export interface TitleView {
  titles: Record<string, string>;
  pending: number;
  error: string | null;
}

export interface Titler {
  /**
   * Enqueue every own prompt when `stamp` is new. Same stamp: only indexes not already known.
   * A new stamp keeps an already-resolved title visible until the cache key is known again;
   * an unchanged key is not requested again. A null sanitised title is remembered for the run
   * and is not written to disk.
   * Returns immediately. Does not build prompt details and does not wait for the model.
   */
  enqueue(sessionId: string, stamp: string, ownIndexes: readonly number[], load: (index: number) => Promise<TitleSource | null>): void;
  /** Titles already known, prompts still queued or in flight, and the run's generic error. */
  view(sessionId: string): TitleView;
  /** Resolves when nothing is queued or in flight. */
  settled(): Promise<void>;
  /** Abort the in-flight model request, drop queued work, and resolve when the worker has stopped. */
  stop(): Promise<void>;
}

export interface TitlerOptions {
  /** Chat-completions URL from `parseLlmUrl` (http, canonical loopback host). */
  endpoint: URL;
  model: string;
  cacheDir: string;
  /** Defaults to 60s. */
  timeoutMs?: number;
  /** Defaults to 500. */
  maxRequests?: number;
}

type SlotState = "queued" | "inflight" | "ready" | "miss";

interface Slot {
  state: SlotState;
  title?: string;
  key?: string;
  /** Model accepted the response and the sanitised title was empty. Not an HTTP failure. */
  empty?: boolean;
  /** Title kept on screen while a new stamp re-checks this index's cache key. */
  carry?: string;
}

interface SessionRec {
  stamp: string;
  load: (index: number) => Promise<TitleSource | null>;
  slots: Map<number, Slot>;
}

interface Job {
  sessionId: string;
  index: number;
  stamp: string;
}

type FailureKind = "unreachable" | "response";

type Resolved = { ok: true; title: string | null } | { ok: false; kind: FailureKind };

type HttpOutcome =
  | { kind: "ok"; body: string }
  | { kind: "redirect" }
  | { kind: "oversize" }
  | { kind: "status" }
  | { kind: "unreachable" };

interface RequestTarget {
  hostname: string;
  port: number;
  path: string;
  family: 4 | 6;
}

/** Literal loopback only. `localhost` is rewritten here as well so it is never resolved. */
function requestTarget(endpoint: URL): RequestTarget | null {
  if (endpoint.protocol !== "http:") return null;
  let hostname = endpoint.hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname === "localhost") hostname = "127.0.0.1";
  const family: 4 | 6 = hostname.includes(":") ? 6 : 4;
  if (family === 6) {
    if (hostname !== "::1") return null;
  } else {
    const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (m === null) return null;
    if ([m[1], m[2], m[3]].some((o) => Number(o) > 255)) return null;
  }
  const port = endpoint.port === "" ? 80 : Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const path = endpoint.pathname === "" ? "/" : endpoint.pathname;
  return { hostname, port, path, family };
}

function openAiContent(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function presentTitle(title: string, opts: RedactOptions): string | null {
  const options: RedactOptions = {};
  if (opts.repoDir !== undefined && opts.repoDir !== "") options.repoDir = opts.repoDir;
  if (opts.usernames !== undefined) options.usernames = [...opts.usernames];
  const stable = sanitizeTitle(redact(title, options).text);
  if (stable === null || sanitizeTitle(stable) !== stable) return null;
  return stable;
}

function titleFromContent(content: string, opts: RedactOptions): string | null {
  const clean = sanitizeTitle(content);
  if (clean === null) return null;
  return presentTitle(clean, opts);
}

function parseCachePayload(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || obj.v !== 1 || typeof obj.title !== "string") return null;
  if (sanitizeTitle(obj.title) !== obj.title) return null;
  return obj.title;
}

/** Directories from `dir` upward that do not exist yet, leaf first. Null when a parent cannot be stat'd. */
async function dirsToCreate(dir: string): Promise<string[] | null> {
  const missing: string[] = [];
  let cur = dir;
  for (;;) {
    try {
      await lstat(cur);
      return missing;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      missing.push(cur);
      const parent = dirname(cur);
      if (parent === cur) return missing;
      cur = parent;
    }
  }
}

function fileInRoot(root: string, key: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  const dest = join(root, `${key}.json`);
  if (dirname(dest) !== root || basename(dest) !== `${key}.json`) return null;
  return dest;
}

/**
 * One title generator for the process. Concurrency is 1. The same cache key is requested once.
 * Three consecutive transport, HTTP or shape failures, or `maxRequests` model calls, drain the queue.
 */
export function createTitler(opts: TitlerOptions): Titler {
  const endpoint = opts.endpoint;
  const model = opts.model;
  const cacheDir = resolve(opts.cacheDir);
  const timeoutMs = opts.timeoutMs ?? TITLE_TIMEOUT_MS;
  const maxRequests = opts.maxRequests ?? TITLE_REQUEST_CAP;

  const sessions = new Map<string, SessionRec>();
  /** Title, or null when sanitise produced nothing. Lives for the run. Null is never written to disk. */
  const outcomes = new Map<string, string | null>();
  let queue: Job[] = [];
  let pumping = false;
  let inflight = 0;
  let stopped = false;
  let error: string | null = null;
  let consecutive = 0;
  let requestCount = 0;
  let idleWaiters: (() => void)[] = [];
  let currentReq: ClientRequest | null = null;

  function idle(): boolean {
    return queue.length === 0 && inflight === 0 && !pumping;
  }

  function flushIdle(): void {
    if (!idle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wait of waiters) wait();
  }

  function trip(kind: FailureKind): void {
    if (stopped) return;
    stopped = true;
    error = kind === "unreachable" ? TITLE_ERR_UNREACHABLE : TITLE_ERR_RESPONSE;
    queue = [];
    for (const rec of sessions.values()) {
      for (const slot of rec.slots.values()) {
        if (slot.state === "queued") slot.state = "miss";
      }
    }
  }

  function noteFailure(kind: FailureKind): void {
    if (stopped) return;
    consecutive += 1;
    if (consecutive >= TITLE_FAILURE_LIMIT) trip(kind);
  }

  function noteSuccess(): void {
    if (!stopped) consecutive = 0;
  }

  async function cacheRoot(create: boolean): Promise<string | null> {
    try {
      const st = await lstat(cacheDir);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) return null;
      try {
        // chmod only the directories this call creates. A pre-existing cache dir keeps its mode.
        const created = await dirsToCreate(cacheDir);
        if (created === null) return null;
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        for (const dir of created) await chmod(dir, 0o700);
      } catch {
        return null;
      }
      try {
        const st = await lstat(cacheDir);
        if (st.isSymbolicLink() || !st.isDirectory()) return null;
      } catch {
        return null;
      }
    }
    try {
      return await realpath(cacheDir);
    } catch {
      return null;
    }
  }

  async function readCache(key: string): Promise<string | null> {
    try {
      const root = await cacheRoot(false);
      if (root === null) return null;
      const dest = fileInRoot(root, key);
      if (dest === null) return null;
      const st = await lstat(dest);
      if (st.isSymbolicLink() || !st.isFile() || st.size > TITLE_CACHE_READ_MAX) return null;
      const realFile = await realpath(dest);
      if (!isInside(realFile, root)) return null;
      const fh = await open(dest, "r");
      try {
        const buf = Buffer.alloc(TITLE_CACHE_READ_MAX);
        const { bytesRead } = await fh.read(buf, 0, TITLE_CACHE_READ_MAX, 0);
        if (bytesRead > TITLE_CACHE_READ_MAX) return null;
        return parseCachePayload(buf.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  async function writeCache(key: string, title: string): Promise<void> {
    if (sanitizeTitle(title) !== title) return;
    const root = await cacheRoot(true);
    if (root === null) return;
    const dest = fileInRoot(root, key);
    if (dest === null) return;
    try {
      const existing = await lstat(dest);
      if (existing.isSymbolicLink() || !existing.isFile()) return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const tmp = join(root, `.${key}.${randomBytes(8).toString("hex")}.tmp`);
    if (dirname(tmp) !== root) return;
    let opened = false;
    try {
      const fh = await open(tmp, "wx", 0o600);
      opened = true;
      try {
        await fh.writeFile(JSON.stringify({ v: 1, title }));
      } finally {
        await fh.close();
      }
      await chmod(tmp, 0o600);
      await rename(tmp, dest);
      opened = false;
      await chmod(dest, 0o600);
    } catch {
      if (opened) await unlink(tmp).catch(() => {});
    }
  }

  function postChat(json: string): Promise<HttpOutcome> {
    const target = requestTarget(endpoint);
    if (target === null) return Promise.resolve({ kind: "unreachable" });
    return new Promise((resolveRequest) => {
      let settled = false;
      const agent = new Agent({ keepAlive: false });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: HttpOutcome) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (currentReq === req) currentReq = null;
        resolveRequest(outcome);
        agent.destroy();
      };
      const host = target.family === 6 ? `[${target.hostname}]:${target.port}` : `${target.hostname}:${target.port}`;
      const req = httpRequest(
        {
          protocol: "http:",
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: "POST",
          family: target.family,
          agent,
          headers: {
            host,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(json),
            connection: "close",
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            finish({ kind: "redirect" });
            return;
          }
          if (status !== 200) {
            res.resume();
            finish({ kind: "status" });
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            received += chunk.length;
            if (received > TITLE_BODY_CAP) {
              chunks.length = 0;
              // Settle before destroy: destroy emits `error` on this response, and that must not replace oversize.
              finish({ kind: "oversize" });
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (settled) return;
            finish({ kind: "ok", body: Buffer.concat(chunks).toString("utf8") });
          });
          res.on("error", () => finish({ kind: "unreachable" }));
          res.on("aborted", () => finish({ kind: "unreachable" }));
        },
      );
      req.on("error", () => finish({ kind: "unreachable" }));
      req.on("timeout", () => {
        req.destroy();
        finish({ kind: "unreachable" });
      });
      req.setTimeout(timeoutMs);
      timer = setTimeout(() => {
        req.destroy();
        finish({ kind: "unreachable" });
      }, timeoutMs);
      // The socket keeps the process alive until stop() aborts it. This timer must not.
      timer.unref();
      currentReq = req;
      if (stopped) {
        req.destroy();
        finish({ kind: "unreachable" });
        return;
      }
      req.end(json);
    });
  }

  function classify(outcome: HttpOutcome, redactOpts: RedactOptions): Resolved {
    if (outcome.kind === "unreachable") return { ok: false, kind: "unreachable" };
    if (outcome.kind !== "ok") return { ok: false, kind: "response" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.body);
    } catch {
      return { ok: false, kind: "response" };
    }
    const content = openAiContent(parsed);
    if (content === null) return { ok: false, kind: "response" };
    return { ok: true, title: titleFromContent(content, redactOpts) };
  }

  async function requestAndCache(key: string, input: string, redactOpts: RedactOptions): Promise<Resolved> {
    if (stopped) return { ok: false, kind: "response" };
    if (requestTarget(endpoint) === null) {
      noteFailure("unreachable");
      return { ok: false, kind: "unreachable" };
    }
    if (requestCount >= maxRequests) {
      trip("response");
      return { ok: false, kind: "response" };
    }
    requestCount += 1;
    const outcome = await postChat(JSON.stringify(titleRequestBody(model, input)));
    const resolved = classify(outcome, redactOpts);
    if (!resolved.ok) {
      noteFailure(resolved.kind);
      return resolved;
    }
    noteSuccess();
    remember(key, resolved.title);
    if (resolved.title !== null) {
      try {
        await writeCache(key, resolved.title);
      } catch {
        // The title is still kept in memory. A cache that cannot be written is ignored.
      }
    }
    return resolved;
  }

  function remember(key: string, title: string | null): void {
    if (!outcomes.has(key)) outcomes.set(key, title);
  }

  function apply(slot: Slot, key: string, title: string | null): void {
    slot.key = key;
    slot.carry = undefined;
    if (title === null) {
      slot.state = "miss";
      slot.empty = true;
      slot.title = undefined;
      return;
    }
    slot.state = "ready";
    slot.empty = false;
    slot.title = title;
  }

  async function runJob(job: Job): Promise<void> {
    const rec = sessions.get(job.sessionId);
    if (!rec || rec.stamp !== job.stamp || stopped) return;
    const slot = rec.slots.get(job.index);
    if (!slot || slot.state !== "queued") return;
    slot.state = "inflight";
    let source: TitleSource | null = null;
    try {
      source = await rec.load(job.index);
    } catch {
      source = null;
    }
    if (sessions.get(job.sessionId) !== rec) return;
    const current = rec.slots.get(job.index);
    if (!current || current.state !== "inflight") return;
    if (stopped || !source) {
      current.state = "miss";
      return;
    }
    const key = titleCacheKey(model, source.input);
    if (outcomes.has(key)) {
      const remembered = outcomes.get(key) ?? null;
      const shown = remembered === null ? null : presentTitle(remembered, source.redact);
      apply(current, key, shown);
      return;
    }
    // The input changed. Stop showing the previous title before the new one is fetched.
    if (current.carry !== undefined && current.key !== undefined && current.key !== key) current.carry = undefined;
    const cached = await readCache(key);
    if (sessions.get(job.sessionId) !== rec) return;
    const afterRead = rec.slots.get(job.index);
    if (!afterRead || afterRead.state !== "inflight") return;
    if (stopped) {
      afterRead.state = "miss";
      afterRead.carry = undefined;
      return;
    }
    if (cached !== null) {
      remember(key, cached);
      apply(afterRead, key, presentTitle(cached, source.redact));
      return;
    }
    afterRead.carry = undefined;
    const result = await requestAndCache(key, source.input, source.redact);
    if (sessions.get(job.sessionId) !== rec) return;
    const after = rec.slots.get(job.index);
    if (!after) return;
    if (!result.ok) {
      after.state = "miss";
      after.key = key;
      after.empty = false;
      after.carry = undefined;
      return;
    }
    apply(after, key, result.title);
  }

  async function runLoop(): Promise<void> {
    try {
      while (queue.length > 0 && !stopped) {
        const job = queue.shift()!;
        inflight += 1;
        try {
          await runJob(job);
        } catch {
          const rec = sessions.get(job.sessionId);
          const slot = rec?.stamp === job.stamp ? rec.slots.get(job.index) : undefined;
          if (slot && slot.state === "inflight") slot.state = "miss";
        } finally {
          inflight -= 1;
        }
      }
    } finally {
      pumping = false;
      if (!stopped && queue.length > 0) pump();
      else flushIdle();
    }
  }

  function pump(): void {
    if (pumping || stopped) return;
    pumping = true;
    void runLoop();
  }

  function carried(old: Slot | undefined): { carry?: string; key?: string } {
    if (!old) return {};
    const carry = old.state === "ready" && old.title !== undefined ? old.title : old.carry;
    if (carry === undefined) return {};
    return old.key !== undefined ? { carry, key: old.key } : { carry };
  }

  function enqueue(sessionId: string, stamp: string, ownIndexes: readonly number[], load: (index: number) => Promise<TitleSource | null>): void {
    if (stopped) return;
    const indexes = [...new Set(ownIndexes)].filter((n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000_000);
    let rec = sessions.get(sessionId);
    if (!rec || rec.stamp !== stamp) {
      const prev = rec?.slots;
      queue = queue.filter((job) => job.sessionId !== sessionId);
      rec = { stamp, load, slots: new Map() };
      sessions.set(sessionId, rec);
      for (const index of indexes) {
        rec.slots.set(index, { state: "queued", ...carried(prev?.get(index)) });
        queue.push({ sessionId, index, stamp });
      }
      if (indexes.length > 0) pump();
      return;
    }
    rec.load = load;
    for (const index of [...rec.slots.keys()]) {
      if (!indexes.includes(index)) rec.slots.delete(index);
    }
    queue = queue.filter((job) => job.sessionId !== sessionId || rec!.slots.has(job.index));
    let added = false;
    for (const index of indexes) {
      if (!rec.slots.has(index)) {
        rec.slots.set(index, { state: "queued" });
        queue.push({ sessionId, index, stamp });
        added = true;
      }
    }
    if (added) pump();
  }

  function view(sessionId: string): TitleView {
    const rec = sessions.get(sessionId);
    const titles: Record<string, string> = {};
    let pending = 0;
    if (rec) {
      for (const index of [...rec.slots.keys()].sort((a, b) => a - b)) {
        const slot = rec.slots.get(index)!;
        if (slot.state === "ready" && slot.title !== undefined) titles[String(index)] = slot.title;
        else if ((slot.state === "queued" || slot.state === "inflight") && slot.carry !== undefined) titles[String(index)] = slot.carry;
        if (!stopped && (slot.state === "queued" || slot.state === "inflight")) pending += 1;
      }
    }
    return { titles, pending, error };
  }

  function settled(): Promise<void> {
    if (idle()) return Promise.resolve();
    return new Promise((resolveSettled) => {
      if (idle()) resolveSettled();
      else idleWaiters.push(resolveSettled);
    });
  }

  function abortInFlight(): void {
    const req = currentReq;
    currentReq = null;
    req?.destroy();
  }

  function stop(): Promise<void> {
    if (!stopped) {
      stopped = true;
      queue = [];
      for (const rec of sessions.values()) {
        for (const slot of rec.slots.values()) {
          if (slot.state === "queued") {
            slot.state = "miss";
            slot.carry = undefined;
          }
        }
      }
    } else {
      queue = [];
    }
    abortInFlight();
    return settled();
  }

  return { enqueue, view, settled, stop };
}
