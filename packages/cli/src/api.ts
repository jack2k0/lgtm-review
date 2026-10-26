import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analyzeFile, analyzeFileDetail, discoverRootSessions, gitCrosscheck, loadRepoScripts, projectDirFor, subagentStamp, type SessionFile, type SessionRoot } from "@lgtm/core/node";
import { buildBeats, inheritedSource, markInherited, needsAttention, ownershipRanks } from "@lgtm/core";
import type { Analyzer, GitCrosscheckResponse, ImportMapResponse, PlayResponse, PromptDetail, SessionAnalysis, SessionSummary, Status } from "@lgtm/core";
import { planImportMap, toRepoRelative } from "./map.js";
import { sortSessions } from "./format.js";
import { etagFor, ifNoneMatch, sendJson, sendNotModified, type ApiHandler } from "./http.js";
import type { ServerOptions } from "./server.js";

/**
 * Counts only non-inherited prompts; `inheritedCount` and `forkOf` describe the rest. `all` (the project's sessions)
 * only serves the `forkOf` tie-break (ownership order); without it ties go to the smallest session id.
 */
export function summarize(s: SessionAnalysis, all: readonly SessionAnalysis[] = []): SessionSummary {
  const statusCounts: Record<Status, number> = { checked: 0, unchecked: 0, failing: 0, "no-changes": 0 };
  let inheritedCount = 0;
  let attentionCount = 0;
  for (const p of s.prompts) {
    if (p.inheritedFrom !== undefined) {
      inheritedCount++;
    } else {
      statusCounts[p.status]++;
      if (needsAttention(p)) attentionCount++;
    }
  }
  // forkOf: shared rule (most inherited prompts; ties to the earlier owner)
  const forkOf = inheritedSource(s.prompts, all.length > 0 ? ownershipRanks(all) : undefined)?.from;
  return {
    id: s.sessionId,
    title: s.title,
    branch: s.branch,
    startedAt: s.startedAt,
    promptCount: s.prompts.length - inheritedCount,
    statusCounts,
    warningCount: s.warnings.length,
    inheritedCount,
    attentionCount,
    ...(forkOf !== undefined ? { forkOf } : {}),
    ...(s.archived ? { archived: true } : {}),
    ...(s.worktree !== undefined ? { worktree: s.worktree } : {}),
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
  const roots: SessionRoot[] = opts.roots ?? [{ dir: opts.dir, worktree: ".", projectDir: projectDirFor(opts.dir, opts.projectsDir), archiveDir: opts.archiveDir ?? null }];
  const cache = new Map<string, { key: string; analysis: Promise<SessionAnalysis> }>();

  async function discover(): Promise<SessionFile[]> {
    try {
      return await discoverRootSessions(roots);
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
    const key = `${f.mtimeMs}:${size}:${await subagentStamp(f.path)}\0${f.worktree ?? ""}`;
    let hit = detailCache.get(f.path);
    if (hit && hit.key === key) {
      detailCache.delete(f.path); // refresh recency
      detailCache.set(f.path, hit);
    } else {
      const entry = loadRepoScripts(f.root ?? opts.dir).then(async (repo): Promise<DetailEntry> => {
        const { analysis, analyzer } = await analyzeFileDetail(f.path, { repo, sessionId: f.id, file: `${f.id}.jsonl` });
        if (f.archived) analysis.archived = true;
        if (f.worktree !== undefined) analysis.worktree = f.worktree;
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
    const key = `${f.mtimeMs}:${size}:${await subagentStamp(f.path)}\0${f.worktree ?? ""}`;
    let entry = cache.get(f.path);
    if (!entry || entry.key !== key) {
      const analysis = loadRepoScripts(f.root ?? opts.dir).then(async (repo) => {
        const a = await analyzeFile(f.path, { repo, sessionId: f.id, file: `${f.id}.jsonl` });
        if (f.archived) a.archived = true;
        if (f.worktree !== undefined) a.worktree = f.worktree;
        return a;
      });
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

  /** Stamp of the whole project: inheritance depends on every session file, so every ETag carries it. */
  async function projectStamp(files: SessionFile[]): Promise<string> {
    const versions: string[] = [];
    for (const f of files) {
      const v = await versionOf(f); // a file that vanished since discovery is skipped
      if (v !== null) versions.push(v);
    }
    return versions.join("\0");
  }

  /** All readable sessions of the project with inheritance marked. */
  async function allAnalyses(files: SessionFile[]): Promise<SessionAnalysis[]> {
    const sessions: SessionAnalysis[] = [];
    for (const f of files) {
      const a = await analysisFor(f); // sequential on purpose
      if (a) sessions.push(a);
    }
    return markInherited(sessions);
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
  async function promptRoute(req: IncomingMessage, res: ServerResponse, file: SessionFile | undefined, stamp: string | null, rawIndex: string, isDiff: boolean): Promise<boolean> {
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
    const etag = file && stamp !== null ? etagFor(`${isDiff ? "diff" : "prompt"}\0${file.id}\0${stamp}\0${index}\0${wanted ?? ""}`) : null;
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

  // Import maps: body cached under the fingerprint that doubles as the ETag source (plan M6).
  const mapCache = new Map<string, { key: string; body: unknown }>();
  // Play responses: body cached under per-prompt map key + "\0play" (plan B3).
  const playCache = new Map<string, { key: string; body: unknown }>();
  const MAP_CACHE_MAX = 32;

  /** `?prompt=N` of the map route: absent -> null, malformed or repeated -> "bad". */
  function promptQuery(rawUrl: string): number | null | "bad" {
    const q = rawUrl.split("#", 1)[0]!.split("?").slice(1).join("?");
    let found: string | undefined;
    for (const part of q.split("&")) {
      if (part === "") continue;
      const eq = part.indexOf("=");
      if ((eq < 0 ? part : part.slice(0, eq)) !== "prompt") continue;
      if (found !== undefined || eq < 0) return "bad";
      found = part.slice(eq + 1);
    }
    if (found === undefined) return null;
    return INDEX_RE.test(found) ? Number(found) : "bad";
  }

  async function mapRoute(req: IncomingMessage, res: ServerResponse, file: SessionFile | undefined, files: SessionFile[], stamp: string): Promise<boolean> {
    const prompt = promptQuery(req.url ?? "");
    if (prompt === "bad") {
      sendJson(req, res, 400, { error: "bad request" });
      return true;
    }
    if (!file || (await versionOf(file)) === null) return false;
    const analysis = (await allAnalyses(files)).find((x) => x.sessionId === file.id);
    if (!analysis) return false;
    if (prompt !== null && !analysis.prompts[prompt]) return false;
    const plan = await planImportMap(file.root ?? opts.dir, analysis, prompt, opts.mapCaps, async () => {
      const d = await detailFor(file);
      if (!d) return null;
      return {
        diffFor: (idx: number, path: string) => d.analyzer.diffFor(idx, path),
        steps: prompt !== null ? d.details[prompt]?.steps ?? null : null,
      };
    });
    const key = `${stamp}\0${prompt ?? "s"}\0${plan.fingerprint}`;
    const etag = etagFor(`map\0${file.id}\0${key}`);
    if (notModifiedEarly(req, res, etag)) return true;
    const slot = `${file.id}\0${prompt ?? "s"}`;
    let hit = mapCache.get(slot);
    if (!hit || hit.key !== key) {
      hit = { key, body: await plan.build() };
      mapCache.delete(slot);
      mapCache.set(slot, hit);
      while (mapCache.size > MAP_CACHE_MAX) mapCache.delete(mapCache.keys().next().value!);
    }
    reply(req, res, etag, hit.body);
    return true;
  }

  async function playRoute(
    req: IncomingMessage,
    res: ServerResponse,
    file: SessionFile | undefined,
    files: SessionFile[],
    stamp: string,
    rawIndex: string,
  ): Promise<boolean> {
    if (!INDEX_RE.test(rawIndex)) {
      sendJson(req, res, 400, { error: "bad request" });
      return true;
    }
    const index = Number(rawIndex);
    if (!file || (await versionOf(file)) === null) return false;
    const analysis = (await allAnalyses(files)).find((x) => x.sessionId === file.id);
    if (!analysis) return false;
    const prompt = analysis.prompts[index];
    if (!prompt) return false;
    if (prompt.inheritedFrom !== undefined) return false;

    let detailPromise: Promise<DetailEntry | null> | undefined;
    const detail = (): Promise<DetailEntry | null> => (detailPromise ??= detailFor(file));
    const plan = await planImportMap(file.root ?? opts.dir, analysis, index, opts.mapCaps, async () => {
      const d = await detail();
      const promptDetail = d?.details[index];
      if (!d || !promptDetail) return null;
      return {
        diffFor: (idx: number, path: string) => d.analyzer.diffFor(idx, path),
        steps: promptDetail.steps,
      };
    });
    const mapKey = `${stamp}\0${index}\0${plan.fingerprint}`;
    const playKey = `${mapKey}\0play`;
    const etag = etagFor(`play\0${file.id}\0${playKey}`);
    if (notModifiedEarly(req, res, etag)) return true;

    const slot = `${file.id}\0${index}`;
    let hit = playCache.get(slot);
    if (!hit || hit.key !== playKey) {
      const d = await detail();
      const promptDetail = d?.details[index];
      if (!d || !promptDetail) return false;
      let mapHit = mapCache.get(slot);
      if (!mapHit || mapHit.key !== mapKey) {
        mapHit = { key: mapKey, body: await plan.build() };
        mapCache.delete(slot);
        mapCache.set(slot, mapHit);
        while (mapCache.size > MAP_CACHE_MAX) mapCache.delete(mapCache.keys().next().value!);
      }
      const mapBody = mapHit.body as ImportMapResponse;

      const rootDir = file.root ?? opts.dir;
      let root: string;
      try {
        root = realpathSync(rootDir);
      } catch {
        root = rootDir;
      }

      const mappedSteps = promptDetail.steps.map((s) => ({
        ...s,
        // Files outside --dir (scratch notes, briefs) are not part of the change shown on the map.
        files: s.files.map((p) => toRepoRelative(p, [rootDir, root])).filter((p): p is string => p !== null),
      }));

      const diffsCallback = (path: string) => {
        const known = prompt.files.find((f) => f.path === path || toRepoRelative(f.path, [rootDir, root]) === path);
        return known ? d.analyzer.diffFor(index, known.path) : d.analyzer.diffFor(index, path);
      };

      const { beats, truncated } = buildBeats({
        steps: mappedSteps,
        diffs: diffsCallback,
        map: mapBody,
      });

      const body: PlayResponse = {
        sessionId: file.id,
        prompt: index,
        beats,
        truncated,
      };
      hit = { key: playKey, body };
      playCache.delete(slot);
      playCache.set(slot, hit);
      while (playCache.size > MAP_CACHE_MAX) playCache.delete(playCache.keys().next().value!);
    }
    reply(req, res, etag, hit.body);
    return true;
  }

  async function gitRoute(req: IncomingMessage, res: ServerResponse, file: SessionFile | undefined, files: SessionFile[]): Promise<boolean> {
    if (!file || (await versionOf(file)) === null) return false;
    const analysis = (await allAnalyses(files)).find((x) => x.sessionId === file.id);
    if (!analysis) return false;
    const sessionFiles = [...new Set(analysis.prompts.filter((p) => p.inheritedFrom === undefined).flatMap((p) => p.files.map((f) => f.path)))];
    const result = await gitCrosscheck({ dir: file.root ?? opts.dir, branch: analysis.branch, startedAt: analysis.startedAt, endedAtMs: file.mtimeMs, sessionFiles });
    const body: GitCrosscheckResponse = { sessionId: file.id, ...result };
    reply(req, res, etagFor(`git\0${file.id}\0${JSON.stringify(body)}`), body);
    return true;
  }

  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const match = /^\/api\/sessions(?:\/([^/]+)(?:\/prompts\/([^/]+)(\/diff|\/play)?|(\/map)|(\/git))?)?$/.exec(path);
    if (!match) return false;
    try {
      const files = await discover();
      const stamp = await projectStamp(files);
      if (match[1] === undefined) {
        const etag = etagFor(`list\0${stamp}`);
        if (notModifiedEarly(req, res, etag)) return true;
        const sessions = await allAnalyses(files);
        reply(req, res, etag, { dir: opts.dir, sessions: sortSessions(sessions).map((x) => summarize(x, sessions)) });
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
      if (match[4] !== undefined) return await mapRoute(req, res, file, files, stamp);
      if (match[5] !== undefined) return await gitRoute(req, res, file, files);
      if (match[3] === "/play") return await playRoute(req, res, file, files, stamp, match[2]);
      if (match[2] !== undefined) return await promptRoute(req, res, file, file ? stamp : null, match[2], match[3] === "/diff");
      if (!file || (await versionOf(file)) === null) return false;
      const etag = etagFor(`session\0${file.id}\0${stamp}`);
      if (notModifiedEarly(req, res, etag)) return true;
      const analysis = (await allAnalyses(files)).find((x) => x.sessionId === file.id);
      if (!analysis) return false;
      reply(req, res, etag, analysis);
      return true;
    } catch {
      sendJson(req, res, 500, { error: "internal error" });
      return true;
    }
  };
}
