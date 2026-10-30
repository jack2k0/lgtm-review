import type { SessionFile } from "@lgtm/core/node";
import { analyzeFile, loadRepoScripts } from "@lgtm/core/node";
import type { RepoScripts, SessionAnalysis } from "@lgtm/core";

export async function analyzeSessions(
  files: readonly SessionFile[],
  dir: string,
  onError?: (file: SessionFile, err: unknown) => void,
): Promise<SessionAnalysis[]> {
  const repos = new Map<string, Promise<RepoScripts>>();
  const repoFor = (d: string) => {
    let p = repos.get(d);
    if (!p) repos.set(d, (p = loadRepoScripts(d)));
    return p;
  };
  const sessions: SessionAnalysis[] = [];
  for (const f of files) {
    try {
      const rd = f.root ?? dir;
      const repo = await repoFor(rd);
      const a = await analyzeFile(f.path, { repo, sessionId: f.id, file: `${f.id}.jsonl` });
      if (f.archived) a.archived = true;
      if (f.worktree !== undefined) a.worktree = f.worktree;
      sessions.push(a);
    } catch (err) {
      onError?.(f, err);
    }
  }
  return sessions;
}
