import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analyzeFile, discoverSessions, loadRepoScripts, projectDirFor, type SessionFile } from "@lgtm/core/node";
import type { SessionAnalysis, SessionSummary, Status } from "@lgtm/core";
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

  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const match = /^\/api\/sessions(?:\/([^/]+))?$/.exec(path);
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
