import type {
  FileDiff,
  ImportMapResponse,
  MapEdge,
  MapNode,
  PlayBeat,
  PlayBeatKind,
  Step,
} from "./schema.js";

export const BEATS_MAX = 60;

export type DiffsInput =
  | ReadonlyMap<string, FileDiff>
  | Record<string, FileDiff | undefined>
  | ((path: string) => FileDiff | null | undefined);

export interface BuildBeatsInput {
  steps: readonly Step[];
  diffs: DiffsInput;
  map: ImportMapResponse | { nodes: readonly MapNode[]; edges: readonly MapEdge[] };
}

export interface BuildBeatsResult {
  beats: PlayBeat[];
  truncated: boolean;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

const ANSI_RE = /(?:\x1b|\u001b)(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  if (max <= 0) return "";
  if (t[max - 1] !== " " && t[max] !== " ") {
    const lastSpace = t.lastIndexOf(" ", max - 1);
    if (lastSpace !== -1) {
      return t.slice(0, lastSpace).trimEnd();
    }
  }
  return t.slice(0, max).trimEnd();
}

function countDiffLines(diff: FileDiff | null): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (diff && diff.hunks) {
    for (const h of diff.hunks) {
      for (const l of h.lines) {
        if (l.t === "+") added++;
        else if (l.t === "-") removed++;
      }
    }
  }
  return { added, removed };
}

function getDiff(diffs: DiffsInput, path: string): FileDiff | null {
  if (typeof diffs === "function") return diffs(path) ?? null;
  if ("get" in diffs && typeof diffs.get === "function") return diffs.get(path) ?? null;
  return (diffs as Record<string, FileDiff | undefined>)[path] ?? null;
}

/**
 * Pure, deterministic builder of the "Play the change" beat sequence for a prompt (S-07).
 *
 * Walks steps in order (`Step.n`). For each step:
 * - Emits file beats in first-edit order; Fix steps re-emitting an already-seen file add `fix: true`.
 * - Emits one `import-added` beat per newly added edge originating from the first-edited file.
 * - Emits check beats (`passed`, `failed` with excerpt, `no result`).
 * - Caps at 60 beats with `truncated: true`.
 */
export function buildBeats(input: BuildBeatsInput): BuildBeatsResult {
  const { steps, diffs, map } = input;
  const beats: PlayBeat[] = [];
  let truncated = false;

  const nodeSet = new Set(map.nodes.map((n) => n.path));
  const changedNodes = map.nodes.filter((n) => n.kind === "changed").map((n) => n.path);

  // Group new edges by `from` path
  const newEdgesByFrom = new Map<string, { from: string; to: string }[]>();
  for (const e of map.edges) {
    if (e.new === true) {
      const list = newEdgesByFrom.get(e.from);
      if (list) list.push({ from: e.from, to: e.to });
      else newEdgesByFrom.set(e.from, [{ from: e.from, to: e.to }]);
    }
  }

  const seenFiles = new Set<string>();

  const beatFiles = new Set<string>();
  for (const step of steps) {
    for (const path of step.files) {
      beatFiles.add(path);
      const newEdges = newEdgesByFrom.get(path);
      if (newEdges) {
        for (const e of newEdges) {
          beatFiles.add(e.to);
        }
      }
    }
  }

  const basenameCounts = new Map<string, number>();
  for (const path of beatFiles) {
    const base = basename(path);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }

  const fileName = (path: string): string =>
    (basenameCounts.get(basename(path)) ?? 0) > 1 ? path : basename(path);

  const tryAddBeat = (beat: Omit<PlayBeat, "n">): boolean => {
    if (beats.length >= BEATS_MAX) {
      truncated = true;
      return false;
    }
    beats.push({
      n: beats.length + 1,
      ...beat,
    });
    return true;
  };

  stepLoop: for (const step of steps) {
    const isFix = step.phase === "fix";
    const fixFilesThisStep = new Set<string>();

    // Process files edited in this step
    for (const path of step.files) {
      const isFirstEdit = !seenFiles.has(path);
      if (isFirstEdit) {
        seenFiles.add(path);
        const diff = getDiff(diffs, path);
        const kind = diff?.kind ?? "M";
        const { added, removed } = countDiffLines(diff);
        const name = fileName(path);

        let beatKind: PlayBeatKind;
        let text: string;

        if (kind === "A") {
          beatKind = "file-added";
          const suffix = added > 0 ? ` (+${added})` : "";
          text = isFix ? `Fix: created ${name}${suffix}` : `Created ${name}${suffix}`;
        } else if (kind === "D") {
          beatKind = "file-deleted";
          text = isFix ? `Fix: deleted ${name}` : `Deleted ${name}`;
        } else {
          beatKind = "file-changed";
          const hasLines = added > 0 || removed > 0;
          const suffix = hasLines ? ` (+${added} -${removed})` : "";
          text = isFix ? `Fix: edited ${name}${suffix}` : `Edited ${name}${suffix}`;
        }

        const focusNodes = nodeSet.has(path) ? [path] : [];
        const focusEdges = (newEdgesByFrom.get(path) ?? []).map((e) => ({ from: e.from, to: e.to }));

        if (!tryAddBeat({
          kind: beatKind,
          fix: isFix,
          step: step.n,
          text: oneLine(text, 160),
          path,
          focus: { nodes: focusNodes, edges: focusEdges },
        })) {
          break stepLoop;
        }

        // Emit import-added beats for each new edge whose `from` is that path, sorted by `to`
        const newEdges = [...(newEdgesByFrom.get(path) ?? [])].sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
        for (const e of newEdges) {
          const fromName = basename(e.from) === basename(e.to) || (basenameCounts.get(basename(e.from)) ?? 0) > 1 ? e.from : basename(e.from);
          const toName = basename(e.from) === basename(e.to) || (basenameCounts.get(basename(e.to)) ?? 0) > 1 ? e.to : basename(e.to);
          const importText = `${fromName} now imports ${toName}`;

          const importFocusNodes = [e.from, e.to].filter((p) => nodeSet.has(p));
          const importFocusEdges = [{ from: e.from, to: e.to }];

          if (!tryAddBeat({
            kind: "import-added",
            fix: isFix,
            step: step.n,
            text: oneLine(importText, 160),
            path: e.from,
            focus: { nodes: importFocusNodes, edges: importFocusEdges },
          })) {
            break stepLoop;
          }
        }
      } else if (isFix && !fixFilesThisStep.has(path)) {
        fixFilesThisStep.add(path);
        const diff = getDiff(diffs, path);
        const kind = diff?.kind ?? "M";
        const { added, removed } = countDiffLines(diff);
        const name = fileName(path);

        let beatKind: PlayBeatKind;
        let text: string;

        if (kind === "A") {
          beatKind = "file-added";
          const suffix = added > 0 ? ` (+${added})` : "";
          text = `Fix: created ${name}${suffix}`;
        } else if (kind === "D") {
          beatKind = "file-deleted";
          text = `Fix: deleted ${name}`;
        } else {
          beatKind = "file-changed";
          const hasLines = added > 0 || removed > 0;
          const suffix = hasLines ? ` (+${added} -${removed})` : "";
          text = `Fix: edited ${name}${suffix}`;
        }

        const focusNodes = nodeSet.has(path) ? [path] : [];
        const focusEdges = (newEdgesByFrom.get(path) ?? []).map((e) => ({ from: e.from, to: e.to }));

        if (!tryAddBeat({
          kind: beatKind,
          fix: true,
          step: step.n,
          text: oneLine(text, 160),
          path,
          focus: { nodes: focusNodes, edges: focusEdges },
        })) {
          break stepLoop;
        }
      }
    }

    // Process check if present in this step
    if (step.check) {
      const cmd = oneLine(step.check.command, 80);
      let beatKind: PlayBeatKind;
      let outcome: string;
      let detail: string | undefined;

      if (step.check.passed === true) {
        beatKind = "check-passed";
        outcome = "passed";
      } else if (step.check.passed === false) {
        beatKind = "check-failed";
        outcome = "failed";
        if (step.check.excerpt) {
          detail = oneLine(stripAnsi(step.check.excerpt), 200);
        }
      } else {
        beatKind = "check-unknown";
        outcome = "no result";
      }

      const text = `${cmd} -> ${outcome}`;

      if (!tryAddBeat({
        kind: beatKind,
        fix: isFix,
        step: step.n,
        text: oneLine(text, 160),
        ...(detail !== undefined ? { detail } : {}),
        focus: { nodes: changedNodes, edges: [] },
      })) {
        break stepLoop;
      }
    }
  }

  return { beats, truncated };
}
