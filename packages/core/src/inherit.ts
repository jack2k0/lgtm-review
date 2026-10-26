import type { PromptAnalysis, SessionAnalysis } from "./schema.js";

/** Uuids that identify a prompt across sessions; empty and synthetic `line-<n>` fallbacks (parse.ts) are per file and never match. */
function isSharedUuid(uuid: string): boolean {
  return uuid !== "" && !uuid.startsWith("line-");
}

function compareStart(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Ownership rank of every session (0 = owns first), computed once and independent of input order.
 * Order: earliest `startedAt` (null last). A fork keeps the original's timestamps, so sessions that tie on
 * `startedAt` are ordered by: a session whose set of shared prompt uuids is a strict subset of another's
 * comes before it (the original, not the fork); among the rest, the smallest sessionId.
 * "Strict subset" is a partial order, so a group is emitted by repeatedly taking the smallest sessionId among
 * its members that have no remaining strict subset; this total order never depends on pairwise comparison order.
 * (`PromptAnalysis` carries no timestamp, so there is no "latest prompt" step.)
 */
export function ownershipRanks(sessions: readonly SessionAnalysis[]): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const s of sessions) sets.set(s.sessionId, new Set(s.prompts.map((p) => p.uuid).filter(isSharedUuid)));
  const byStart = [...sessions].sort((a, b) => compareStart(a.startedAt, b.startedAt) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const ranks = new Map<string, number>();
  let i = 0;
  while (i < byStart.length) {
    let j = i + 1;
    while (j < byStart.length && byStart[j]!.startedAt === byStart[i]!.startedAt) j++;
    const rest = byStart.slice(i, j); // already sorted by sessionId
    while (rest.length > 0) {
      const idx = rest.findIndex((c) => {
        const cs = sets.get(c.sessionId)!;
        return !rest.some((o) => {
          const os = sets.get(o.sessionId)!;
          return o !== c && os.size < cs.size && [...os].every((u) => cs.has(u));
        });
      });
      const [pick] = rest.splice(idx, 1);
      if (!ranks.has(pick!.sessionId)) ranks.set(pick!.sessionId, ranks.size);
    }
    i = j;
  }
  return ranks;
}

export function markInherited(sessions: SessionAnalysis[]): SessionAnalysis[] {
  const ranks = ownershipRanks(sessions);
  // uuid -> owning sessionId: the lowest-ranked session containing it
  const owner = new Map<string, string>();
  for (const s of sessions) {
    for (const p of s.prompts) {
      if (!isSharedUuid(p.uuid)) continue;
      const cur = owner.get(p.uuid);
      if (cur === undefined || ranks.get(s.sessionId)! < ranks.get(cur)!) owner.set(p.uuid, s.sessionId);
    }
  }

  // Apply inheritedFrom to sessions, preserving input order
  return sessions.map((s) => {
    const newPrompts = s.prompts.map((p) => {
      if (!isSharedUuid(p.uuid)) return p;
      const ownerSession = owner.get(p.uuid);
      if (ownerSession === undefined || ownerSession === s.sessionId) return p;
      return { ...p, inheritedFrom: ownerSession };
    });
    const changed = newPrompts.some((p, i) => p !== s.prompts[i]);
    return changed ? { ...s, prompts: newPrompts } : s;
  });
}

/**
 * The session most inherited prompts came from (ties: lower `ranks` value, i.e. the earlier owner; ids missing from
 * `ranks` after ranked ones, then by id). `others` is the number of further source sessions. Null when nothing is inherited.
 */
export function inheritedSource(
  prompts: readonly Pick<PromptAnalysis, "inheritedFrom">[],
  ranks?: ReadonlyMap<string, number>,
): { count: number; from: string; others: number } | null {
  const tally = new Map<string, number>();
  let count = 0;
  for (const p of prompts) {
    if (!p.inheritedFrom) continue;
    count++;
    tally.set(p.inheritedFrom, (tally.get(p.inheritedFrom) ?? 0) + 1);
  }
  if (count === 0) return null;
  const rankOf = (id: string): number => ranks?.get(id) ?? Number.POSITIVE_INFINITY;
  let from = "";
  let max = 0;
  for (const [id, n] of tally) {
    const better = n > max || (n === max && (rankOf(id) < rankOf(from) || (rankOf(id) === rankOf(from) && id < from)));
    if (better) [from, max] = [id, n];
  }
  return { count, from, others: tally.size - 1 };
}
