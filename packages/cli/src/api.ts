import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analyzeFile, analyzeFileDetail, discoverSessions, loadRepoScripts, projectDirFor, type SessionFile } from "@lgtm/core/node";
import type { Analyzer, PromptDetail, SessionAnalysis, SessionSummary, Status } from "@lgtm/core";
import { sortSessions } from "./format.js";
import { sendJson, type ApiHandler } from "./http.js";
import type { ServerOptions } from "./server.js";

export function summarize(s: SessionAnalysis): SessionSummary {
  const statusCounts: Record<Status, number> = { checked: 0, unchecked: 0, failing: 0, "no-changes": 0 };
  for (const p of s.prompts) statusCounts[p.status]++;
  return {
    id: s.sessionId,
    title: s.title,
    branch: s.branch,
    startedAt: s.startedAt,
    promptCount: s.prompts.length,
    statusCounts,
    warningCount: s.warnings.length,
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

/** JSON API over the analysis of the repo's sessions. Analysis is cached per `path + mtime + size`. */
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
    const key = `${f.mtimeMs}:${size}`;
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
    const key = `${f.mtimeMs}:${size}`;
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
    const d = file ? await detailFor(file) : null;
    const prompt = d?.analysis.prompts[index];
    if (!d || !prompt) return false;
    if (wanted === undefined) {
      const detail = d.details[index];
      if (!detail) return false;
      sendJson(req, res, 200, detail);
      return true;
    }
    const known = prompt.files.find((f) => f.path.replaceAll("\\", "/") === wanted);
    const diff = known ? d.analyzer.diffFor(index, known.path) : null;
    if (!diff) return false;
    sendJson(req, res, 200, diff);
    return true;
  }

  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const match = /^\/api\/sessions(?:\/([^/]+)(?:\/prompts\/([^/]+)(\/diff)?)?)?$/.exec(path);
    if (!match) return false;
    try {
      const files = await discover();
      if (match[1] === undefined) {
        const sessions: SessionAnalysis[] = [];
        for (const f of files) {
          const a = await analysisFor(f); // sequential on purpose
          if (a) sessions.push(a);
        }
        sendJson(req, res, 200, { dir: opts.dir, sessions: sortSessions(sessions).map(summarize) });
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
      const analysis = file ? await analysisFor(file) : null;
      if (!analysis) return false;
      sendJson(req, res, 200, analysis);
      return true;
    } catch {
      sendJson(req, res, 500, { error: "internal error" });
      return true;
    }
  };
}
