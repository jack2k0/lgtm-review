import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analyzeFile, analyzeFileDetail, discoverSessions, loadRepoScripts, projectDirFor, subagentStamp, type SessionFile } from "@lgtm/core/node";
import type { Analyzer, PromptDetail, SessionAnalysis, SessionSummary, Status } from "@lgtm/core";
import { sortSessions } from "./format.js";
import { etagFor, ifNoneMatch, sendJson, sendNotModified, type ApiHandler } from "./http.js";
import type { ServerOptions } from "./server.js";

export function summarize(s: SessionAnalysis): SessionSummary {
  const statusCounts: Record<Status, number> = { checked: 0, unchecked: 0, failing: 0, "no-changes": 0 };
  const inheritedTally = new Map<string, number>();
  let inheritedCount = 0;
  for (const p of s.prompts) {
    if (p.inheritedFrom !== undefined) {
      inheritedCount++;
      inheritedTally.set(p.inheritedFrom, (inheritedTally.get(p.inheritedFrom) ?? 0) + 1);
    } else {
      statusCounts[p.status]++;
    }
  }
  // forkOf: session id with most inherited prompts; ties broken by map insertion order (first seen = earliest by ownership order)
  let forkOf: string | undefined;
  let forkOfMax = 0;
  for (const [sid, count] of inheritedTally) {
    if (count > forkOfMax) {
      forkOfMax = count;
      forkOf = sid;
    }
  }
  return {
    id: s.sessionId,
    title: s.title,
    branch: s.branch,
    startedAt: s.startedAt,
    promptCount: s.prompts.length - inheritedCount,
    statusCounts,
    warningCount: s.warnings.length,
    inheritedCount,
    ...(forkOf !== undefined ? { forkOf } : {}),
  };
}

/** Total estimated size (`Analyzer.detailBytes`) of the cached detail analyses; least recently used go first. */
export const DETAIL_CACHE_BYTES = 50 * 1024 * 1024;

interface DetailEntry {
  analysis: SessionAnalysis;
  analyzer: Analyzer;
  details: PromptDetail[];
  bytes: number;
}

const INDEX_RE = /^(?:0|[1-9]\d{0,8})$/;

type PathParam = { ok: true; value: string } | { ok: false };

/** Reads the single `path` query parameter: raw split (no `+` -> space), percent-decoded once, `\` -> `/`. */
function pathParam(rawUrl: string): PathParam {
  const q = rawUrl.split("#", 1)[0]!.split("?").slice(1).join("?");
  let found: string | undefined;
  for (const part of q.split("&")) {
    const eq = part.indexOf("=");
    if ((eq < 0 ? part : part.slice(0, eq)) !== "path") continue;
    if (found !== undefined || eq < 0) return { ok: false };
    try {
      found = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return { ok: false };
    }
  }
  if (found === undefined || found === "" || found.includes("\0")) return { ok: false };
  return { ok: true, value: found.replaceAll("\\", "/") };
}

/** JSON API over the analysis of the repo's sessions. Analysis is cached per `path + mtime + size` of the session file and of its subagent files. */
export function createApi(opts: ServerOptions): ApiHandler {
  const projectDir = projectDirFor(opts.dir, opts.projectsDir);
  const cache = new Map<string, { key: string; analysis: Promise<SessionAnalysis> }>();

  async function discover(): Promise<SessionFile[]> {
    try {
      return await discoverSessions(projectDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  // Detail analyses (steps + diff material), LRU by estimated bytes, keyed like the summary cache.
  const detailCache = new Map<string, { key: string; entry: Promise<DetailEntry>; bytes: number }>();

  function trimDetailCache(keep: string): void {
    let total = 0;
    for (const v of detailCache.values()) total += v.bytes;
    for (const [k, v] of detailCache) {
      if (total <= DETAIL_CACHE_BYTES) break;
      if (k === keep) continue;
      detailCache.delete(k);
      total -= v.bytes;
    }
  }

  async function detailFor(f: SessionFile): Promise<DetailEntry | null> {
    let size: number;
    try {
      size = (await stat(f.path)).size;
    } catch {
      return null;
    }
    const key = `${f.mtimeMs}:${size}:${await subagentStamp(f.path)}`;
    let hit = detailCache.get(f.path);
    if (hit && hit.key === key) {
      detailCache.delete(f.path); // refresh recency
      detailCache.set(f.path, hit);
    } else {
      const entry = loadRepoScripts(opts.dir).then(async (repo): Promise<DetailEntry> => {
        const { analysis, analyzer } = await analyzeFileDetail(f.path, { repo, sessionId: f.id, file: `${f.id}.jsonl` });
        const details = analyzer.details();
        return { analysis, analyzer, details, bytes: analyzer.detailBytes() };
      });
      const slot = { key, entry, bytes: 0 };
      hit = slot;
      detailCache.set(f.path, slot);
      entry.then(
        (e) => {
          slot.bytes = e.bytes;
          if (detailCache.get(f.path) === slot) trimDetailCache(f.path);
        },
        () => {
          if (detailCache.get(f.path) === slot) detailCache.delete(f.path);
        },
      );
    }
    try {
      return await hit.entry;
    } catch {
      return null;
    }
  }

  async function analysisFor(f: SessionFile): Promise<SessionAnalysis | null> {
    let size: number;
    try {
      size = (await stat(f.path)).size;
    } catch {
      return null;
    }
    const key = `${f.mtimeMs}:${size}:${await subagentStamp(f.path)}`;
    let entry = cache.get(f.path);
    if (!entry || entry.key !== key) {
      const analysis = loadRepoScripts(opts.dir).then((repo) => analyzeFile(f.path, { repo, sessionId: f.id, file: `${f.id}.jsonl` }));
      entry = { key, analysis };
      cache.set(f.path, entry);
      analysis.catch(() => {
        if (cache.get(f.path) === entry) cache.delete(f.path);
      });
    }
    try {
      return await entry.analysis;
    } catch {
      return null; // unreadable session: skipped, like the CLI list does
    }
  }

  /** `path:mtime:size` from one `stat`, or null when the file is gone. Cheap: no reading, no analysis. */
  async function versionOf(f: SessionFile): Promise<string | null> {
    try {
      const st = await stat(f.path);
      const sub = await subagentStamp(f.path); // subagent progress must change the tag too
      return `${f.path}:${st.mtimeMs}:${st.size}${sub === "" ? "" : `:${sub}`}`;
    } catch {
      return null;
    }
  }

  /**
   * Sends a 200 with `etag`, or a 304 when `If-None-Match` matches (`*` too: the caller has produced the body,
   * so the resource exists).
   */
  function reply(req: IncomingMessage, res: ServerResponse, etag: string, body: unknown): void {
    if (ifNoneMatch(req.headers["if-none-match"], etag)) sendNotModified(res, etag);
    else sendJson(req, res, 200, body, etag);
  }

  /**
   * Early 304 before any analysis: only for a concrete tag (it was issued for this very resource and file state).
   * `*` is deliberately not handled here; it needs proof that the resource exists.
   */
  function notModifiedEarly(req: IncomingMessage, res: ServerResponse, etag: string): boolean {
    if (!ifNoneMatch(req.headers["if-none-match"], etag, false)) return false;
    sendNotModified(res, etag);
    return true;
  }

  /** `/prompts/:index` and `/prompts/:index/diff?path=`. `path` is only ever compared with the prompt's own file list. */
  async function promptRoute(req: IncomingMessage, res: ServerResponse, file: SessionFile | undefined, rawIndex: string, isDiff: boolean): Promise<boolean> {
    if (!INDEX_RE.test(rawIndex)) {
      sendJson(req, res, 400, { error: "bad request" });
      return true;
    }
    const index = Number(rawIndex);
    let wanted: string | undefined;
    if (isDiff) {
      const p = pathParam(req.url ?? "");
      if (!p.ok) {
        sendJson(req, res, 400, { error: "bad request" });
        return true;
      }
      wanted = p.value;
    }
    const version = file ? await versionOf(file) : null;
    const etag = version === null ? null : etagFor(`${isDiff ? "diff" : "prompt"}\0${version}\0${index}\0${wanted ?? ""}`);
    if (file && etag && notModifiedEarly(req, res, etag)) return true;
    const d = file ? await detailFor(file) : null;
    const prompt = d?.analysis.prompts[index];
    if (!d || !prompt) return false;
    if (wanted === undefined) {
      const detail = d.details[index];
      if (!detail) return false;
      reply(req, res, etag!, detail);
      return true;
    }
    const known = prompt.files.find((f) => f.path.replaceAll("\\", "/") === wanted);
    const diff = known ? d.analyzer.diffFor(index, known.path) : null;
    if (!diff) return false;
    reply(req, res, etag!, diff);
    return true;
  }

  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const match = /^\/api\/sessions(?:\/([^/]+)(?:\/prompts\/([^/]+)(\/diff)?)?)?$/.exec(path);
    if (!match) return false;
    try {
      const files = await discover();
      if (match[1] === undefined) {
        const versions: string[] = [];
        for (const f of files) {
          const v = await versionOf(f); // a file that vanished since discovery is skipped
          if (v !== null) versions.push(v);
        }
        const etag = etagFor(`list\0${versions.join("\0")}`);
        if (notModifiedEarly(req, res, etag)) return true;
        const sessions: SessionAnalysis[] = [];
        for (const f of files) {
          const a = await analysisFor(f); // sequential on purpose
          if (a) sessions.push(a);
        }
        reply(req, res, etag, { dir: opts.dir, sessions: sortSessions(sessions).map(summarize) });
        return true;
      }
      let id: string;
      try {
        id = decodeURIComponent(match[1]);
      } catch {
        return false;
      }
      // The id is only ever compared against the discovered list; it never becomes a path.
      const file = files.find((f) => f.id === id);
      if (match[2] !== undefined) return await promptRoute(req, res, file, match[2], match[3] !== undefined);
      const version = file ? await versionOf(file) : null;
      if (!file || version === null) return false;
      const etag = etagFor(`session\0${version}`);
      if (notModifiedEarly(req, res, etag)) return true;
      const analysis = await analysisFor(file);
      if (!analysis) return false;
      reply(req, res, etag, analysis);
      return true;
    } catch {
      sendJson(req, res, 500, { error: "internal error" });
      return true;
    }
  };
}
