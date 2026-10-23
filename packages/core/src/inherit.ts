import type { SessionAnalysis } from "./schema.js";

/** Comparison key for ownership ordering: earlier startedAt wins; null is last; ties by sessionId ascending. */
function ownershipKey(s: SessionAnalysis): string {
  // Use ISO timestamp string comparison (works for ISO 8601) + null-last
  if (s.startedAt === null) return "\xFF" + s.sessionId;
  return s.startedAt + "\x00" + s.sessionId;
}

export function markInherited(sessions: SessionAnalysis[]): SessionAnalysis[] {
  // Sort a copy to determine ownership order (do not mutate input array)
  const sorted = [...sessions].sort((a, b) => {
    const ka = ownershipKey(a);
    const kb = ownershipKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Build ownership map: uuid -> first owner sessionId
  const owner = new Map<string, string>();
  for (const s of sorted) {
    for (const p of s.prompts) {
      if (p.uuid !== "" && !owner.has(p.uuid)) {
        owner.set(p.uuid, s.sessionId);
      }
    }
  }

  // Apply inheritedFrom to sessions, preserving input order
  return sessions.map((s) => {
    const newPrompts = s.prompts.map((p) => {
      if (p.uuid === "") return p;
      const ownerSession = owner.get(p.uuid);
      if (ownerSession === undefined || ownerSession === s.sessionId) return p;
      return { ...p, inheritedFrom: ownerSession };
    });
    // Check if any prompt changed
    const changed = newPrompts.some((p, i) => p !== s.prompts[i]);
    return changed ? { ...s, prompts: newPrompts } : s;
  });
}
