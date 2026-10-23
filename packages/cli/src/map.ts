import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
  createPythonResolver,
  createResolver,
  edgeKindFor,
  extractImports,
  extractPythonImports,
  layoutImportMap,
  loadTsconfigAliases,
  mapLanguageOf,
  MAP_NODE_MAX,
  normalizePath,
  selectMapNodes,
  type ImportMapResponse,
  type MapEdgeInput,
  type MapHost,
  type MapNodeInput,
  type SessionAnalysis,
  type Status,
} from "@lgtm/core";

/** Caps of the neighbour scan and the node selection (plan M1/M3); overridable for tests. */
export interface MapCaps {
  maxFiles: number;
  maxFileBytes: number;
  maxNodes: number;
}

export const MAP_CAPS: MapCaps = { maxFiles: 5000, maxFileBytes: 512 * 1024, maxNodes: MAP_NODE_MAX };

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "site-packages",
  ".mypy_cache",
  ".pytest_cache",
]);

/** Files that make their directory an import root of a nested Python project. */
const PROJECT_FILES = new Set(["pyproject.toml", "setup.py", "setup.cfg"]);

/** True for TS/JS and Python files the map considers (plan M1/D3 filters). */
export function isMapSource(path: string): boolean {
  if (mapLanguageOf(path) === null) return false;
  return !path.split("/").some((seg) => SKIP_DIRS.has(seg));
}

function listFiles(dir: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: dir, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) resolve(null);
        else resolve(stdout.split("\0").filter((p) => p !== ""));
      },
    );
  });
}

interface Stat {
  real: string;
  mtimeMs: number;
  size: number;
}

export interface MapPlan {
  /** Changes whenever the response could: files read (path, mtime, size), changed set, caps. */
  fingerprint: string;
  build(): ImportMapResponse;
}

/** Repo-relative path of a session file path (absolute or already relative); null when outside the dir. */
function toRepoRelative(p: string, roots: readonly string[]): string | null {
  let path = p.replaceAll("\\", "/");
  if (path === "" || path.startsWith("~") || path.includes("\0")) return null;
  if (isAbsolute(path)) {
    let rel: string | null = null;
    for (const root of roots) {
      const r = relative(root, path).split(sep).join("/");
      if (r !== "" && r !== ".." && !r.startsWith("../") && !isAbsolute(r)) {
        rel = r;
        break;
      }
    }
    if (rel === null) return null;
    path = rel;
  }
  const n = normalizePath(path);
  return n === "." || n === ".." || n.startsWith("../") || n.startsWith("/") ? null : n;
}

/**
 * Prepares the import map of one session (`promptIndex` null) or one prompt. Cheap part (git ls-files + stat)
 * yields the fingerprint used as the ETag; `build()` reads and parses the files. Never reads outside `dir` (M4).
 */
export async function planImportMap(
  dir: string,
  analysis: SessionAnalysis,
  promptIndex: number | null,
  capsIn: Partial<MapCaps> = {},
): Promise<MapPlan> {
  const caps: MapCaps = { ...MAP_CAPS, ...capsIn };
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    root = dir;
  }
  const insideRoot = (real: string): boolean => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

  // Changed files: last non-inherited prompt (index order) wins for the session map.
  const changed = new Map<string, { status: Status; promptIndex: number }>();
  for (const p of analysis.prompts) {
    if (p.inheritedFrom !== undefined) continue;
    if (promptIndex !== null && p.index !== promptIndex) continue;
    for (const f of p.files) {
      const rel = toRepoRelative(f.path, [dir, root]);
      if (rel === null || !isMapSource(rel)) continue;
      changed.set(rel, { status: p.status, promptIndex: p.index });
    }
  }

  const notes: string[] = [];
  let truncated = false;

  const statCache = new Map<string, Stat | null>();
  /** Realpath-checked stat of a repo-relative regular file; null when missing, not a file or escaping the dir. */
  const safeStat = (rel: string): Stat | null => {
    if (statCache.has(rel)) return statCache.get(rel)!;
    let out: Stat | null = null;
    try {
      const real = realpathSync(`${root}/${rel}`);
      if (insideRoot(real)) {
        const st = statSync(real);
        if (st.isFile()) out = { real, mtimeMs: st.mtimeMs, size: st.size };
      }
    } catch {
      out = null;
    }
    statCache.set(rel, out);
    return out;
  };

  // Candidate scan (incoming edges) and Python roots (D4, A5).
  let candidates: string[] = [];
  let manageDirs: string[] = [];
  let pyRoots: string[] = [""];
  let hasSrc = false;
  const listed = await listFiles(dir);
  if (listed === null) {
    notes.push("Neighbour scan unavailable (git ls-files failed): showing outgoing imports only.");
  } else {
    const rawFiles = listed.map((p) => p.replaceAll("\\", "/"));
    let projectDirs: string[] = [];
    const srcLayoutDirs = new Set<string>();
    for (const p of rawFiles) {
      if (p.endsWith("/manage.py") && !p.split("/").some((seg) => SKIP_DIRS.has(seg))) {
        const d = p.slice(0, p.lastIndexOf("/"));
        if (d !== "") manageDirs.push(d);
      }
      if (p.startsWith("src/") && p.endsWith(".py") && !p.split("/").some((seg) => SKIP_DIRS.has(seg))) {
        hasSrc = true;
      }
      if (p.endsWith("pyproject.toml") || p.endsWith("setup.py") || p.endsWith("setup.cfg")) {
        const slash = p.lastIndexOf("/");
        if (slash > 0 && PROJECT_FILES.has(p.slice(slash + 1)) && !p.split("/").some((seg) => SKIP_DIRS.has(seg))) {
          projectDirs.push(p.slice(0, slash));
        }
      }
      if (p.endsWith(".py")) {
        // Remember every `<dir>` that has a `<dir>/src/**/*.py` file (a src layout inside a nested project).
        for (let i = p.indexOf("/src/"); i > 0; i = p.indexOf("/src/", i + 1)) srcLayoutDirs.add(p.slice(0, i));
      }
    }
    manageDirs = [...new Set(manageDirs)].sort();
    projectDirs = [...new Set(projectDirs)].sort();

    // Nested projects (vendor/letsfg with its own pyproject.toml) are import roots too: `<dir>/src` first when
    // the project uses a src layout, then `<dir>` itself.
    const projectRoots: string[] = [];
    for (const d of projectDirs) {
      if (srcLayoutDirs.has(d)) projectRoots.push(`${d}/src`);
      projectRoots.push(d);
    }

    const filtered = [...new Set(rawFiles.filter(isMapSource))].sort();
    if (filtered.length > caps.maxFiles) {
      truncated = true;
      notes.push(`Neighbour scan limited to the first ${caps.maxFiles} of ${filtered.length} source files.`);
    }
    candidates = filtered.slice(0, caps.maxFiles);

    const orderedRoots = [...new Set([...manageDirs, ...projectRoots, ...(hasSrc ? ["src"] : []), ""])];
    pyRoots = orderedRoots.length <= 20 ? orderedRoots : [...orderedRoots.slice(0, 19), ""];
  }

  const layerRoots = manageDirs;

  const changedPaths = [...changed.keys()].sort();
  const toRead = [...new Set([...changedPaths, ...candidates])].sort();
  const fp = createHash("sha256");
  fp.update(`${caps.maxFiles}:${caps.maxFileBytes}:${caps.maxNodes}\0${promptIndex ?? "s"}\0${notes.join("|")}\0`);
  for (const p of changedPaths) {
    const c = changed.get(p)!;
    fp.update(`C${p}:${c.status}:${c.promptIndex}\0`);
  }
  let oversize = 0;
  for (const p of toRead) {
    const st = safeStat(p);
    if (st === null) fp.update(`${p}:-\0`);
    else {
      if (st.size > caps.maxFileBytes) oversize++;
      fp.update(`${p}:${st.mtimeMs}:${st.size}\0`);
    }
  }
  // tsconfig files feed the resolver
  for (const p of ["tsconfig.json", "tsconfig.base.json"]) {
    const st = safeStat(p);
    fp.update(`${p}:${st === null ? "-" : `${st.mtimeMs}:${st.size}`}\0`);
  }

  return {
    fingerprint: fp.digest("hex"),
    build(): ImportMapResponse {
      const buildNotes = [...notes];
      let buildTruncated = truncated;
      if (oversize > 0) {
        buildTruncated = true;
        buildNotes.push(`${oversize} source file${oversize === 1 ? "" : "s"} over ${Math.round(caps.maxFileBytes / 1024)} KB not scanned.`);
      }

      const readText = (rel: string): string | null => {
        const st = safeStat(rel);
        if (st === null || st.size > caps.maxFileBytes) return null;
        try {
          return readFileSync(st.real, "utf8");
        } catch {
          return null;
        }
      };
      const host: MapHost = {
        exists: (rel) => safeStat(rel) !== null,
        readJson: (rel) => {
          const text = readText(rel);
          return text === null ? undefined : text;
        },
      };
      const tsResolver = createResolver({ host, aliases: loadTsconfigAliases("", host) });
      const pyResolver = createPythonResolver({ host, roots: pyRoots });

      const edges: MapEdgeInput[] = [];
      const importsOf = (rel: string): { to: string; kind: "import" | "type" }[] => {
        const lang = mapLanguageOf(rel);
        if (lang === null) return [];
        const text = readText(rel);
        if (text === null) return [];
        const out: { to: string; kind: "import" | "type" }[] = [];
        if (lang === "ts") {
          for (const imp of extractImports(text)) {
            const to = tsResolver.resolve(imp.specifier, rel);
            if (to !== null && to !== rel) out.push({ to, kind: edgeKindFor(imp.syntax) });
          }
        } else if (lang === "py") {
          for (const imp of extractPythonImports(text)) {
            for (const to of pyResolver.resolve(imp, rel)) {
              if (to !== rel) out.push({ to, kind: "import" });
            }
          }
        }
        return out;
      };

      const deleted = new Set(changedPaths.filter((p) => safeStat(p) === null));
      const neighbourEdges = new Map<string, number>();
      // Outgoing edges of changed files.
      for (const from of changedPaths) {
        if (deleted.has(from)) continue;
        for (const e of importsOf(from)) {
          edges.push({ from, to: e.to, kind: e.kind });
          if (!changed.has(e.to)) neighbourEdges.set(e.to, (neighbourEdges.get(e.to) ?? 0) + 1);
        }
      }
      // Incoming edges: unchanged files that import a changed file.
      for (const from of candidates) {
        if (changed.has(from)) continue;
        for (const e of importsOf(from)) {
          if (!changed.has(e.to) || deleted.has(e.to)) continue;
          edges.push({ from, to: e.to, kind: e.kind });
          neighbourEdges.set(from, (neighbourEdges.get(from) ?? 0) + 1);
        }
      }

      const sel = selectMapNodes(changedPaths, [...neighbourEdges].map(([path, n]) => ({ path, edges: n })), caps.maxNodes);
      if (sel.truncated) buildTruncated = true;
      const nodes: MapNodeInput[] = [
        ...sel.changed.map((path) => ({ path, changed: true, status: changed.get(path)!.status, deleted: deleted.has(path) })),
        ...sel.neighbours.map((path) => ({ path, changed: false })),
      ];
      const layout = layoutImportMap(nodes, edges, { layerRoots });
      if (sel.hiddenNeighbours > 0) buildNotes.push(`${sel.hiddenNeighbours} neighbour file${sel.hiddenNeighbours === 1 ? "" : "s"} hidden by the ${caps.maxNodes}-node cap.`);

      return {
        sessionId: analysis.sessionId,
        prompt: promptIndex,
        snapshot: "working-tree",
        truncated: buildTruncated,
        hiddenNeighbours: sel.hiddenNeighbours,
        layers: layout.layers,
        nodes: layout.nodes.map((n) => ({ ...n, promptIndex: n.kind === "changed" ? (changed.get(n.id)?.promptIndex ?? null) : null })),
        edges: layout.edges,
        width: layout.width,
        height: layout.height,
        ...(buildNotes.length > 0 ? { notes: buildNotes } : {}),
      };
    },
  };
}
