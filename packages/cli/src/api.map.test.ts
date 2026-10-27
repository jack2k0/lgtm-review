import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ImportMapResponse } from "@lgtm/core";
import { startServer, type RunningServer } from "./server.js";
import { DEFAULT_LIST_FILES_MAX_BUFFER, DEFAULT_LIST_FILES_TIMEOUT, listFiles } from "./map.js";

let tmp: string;
let repo: string;
let srv: RunningServer;
let small: RunningServer;
let noGit: RunningServer;
let djangoSrv: RunningServer;
let pyRootsSrv: RunningServer;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: any;
}

function get(s: RunningServer, path: string, extra: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${s.port}`, "X-Lgtm-Token": s.token, ...extra };
    request({ host: "127.0.0.1", port: s.port, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: b ? JSON.parse(b) : null }));
    })
      .on("error", reject)
      .end();
  });
}

function write(root: string, rel: string, text: string): void {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}

let n = 0;
const rec = (type: string, cwd: string, extra: Record<string, unknown>): string => {
  n++;
  return JSON.stringify({
    type,
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    sessionId: "map-session",
    timestamp: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.000Z`,
    cwd,
    gitBranch: "main",
    ...extra,
  });
};

function session(cwd: string, prompts: { text: string; files: string[] }[]): string {
  const lines: string[] = [];
  let t = 0;
  for (const p of prompts) {
    lines.push(rec("user", cwd, { message: { role: "user", content: p.text } }));
    for (const f of p.files) {
      const id = `toolu_${++t}`;
      lines.push(rec("assistant", cwd, { message: { role: "assistant", content: [{ type: "tool_use", id, name: "Edit", input: { file_path: join(cwd, f), old_string: "a", new_string: "b" } }] } }));
      lines.push(
        rec("user", cwd, {
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "File updated." }] },
          toolUseResult: { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] },
        }),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function projectDir(root: string, cwd: string): string {
  const d = join(root, "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(d, { recursive: true });
  return d;
}

const git = (...args: string[]): void => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lgtm-map-test-")));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  write(repo, "tsconfig.json", '{ // comment\n "compilerOptions": { "paths": { "@lib/*": ["lib/*"], "@app/util": ["src/util.ts"] } } }');
  write(repo, "src/a.ts", 'import { b } from "./b.js";\nimport type { T } from "@lib/t";\nimport u from "@app/util";\nexport const a = [b, u];\n');
  write(repo, "src/b.ts", 'import "./c";\nexport const b = 1;\n');
  write(repo, "src/c.ts", "export const c = 1;\n");
  write(repo, "src/util.ts", "export default 1;\n");
  write(repo, "src/user.ts", 'import { a } from "./a";\nexport const user = a;\n');
  write(repo, "src/other.ts", 'import { b } from "./b";\nexport const o = b;\n');
  write(repo, "lib/t.ts", "export type T = 1;\n");
  write(repo, "src/gone.ts", "export const gone = 1;\n");
  write(repo, "notes.md", "# not source\n");
  // A symlink inside the repo that escapes it; its target imports a changed file.
  write(tmp, "outside/evil.ts", 'import "../repo/src/a";\n');
  symlinkSync(join(tmp, "outside/evil.ts"), join(repo, "src/evil.ts"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  rmSync(join(repo, "src/gone.ts"));

  const root = join(tmp, "p");
  const body = session(repo, [
    { text: "first", files: ["src/a.ts", "src/gone.ts", "notes.md"] },
    { text: "second", files: ["src/b.ts", "src/a.ts"] },
  ]);
  writeFileSync(join(projectDir(root, repo), "map-session.jsonl"), body);
  srv = await startServer({ dir: repo, projectsDir: join(root, "projects"), webRoot: join(tmp, "no-web") });
  small = await startServer({ dir: repo, projectsDir: join(root, "projects"), webRoot: join(tmp, "no-web"), mapCaps: { maxFiles: 2, maxNodes: 4 } });

  const plain = join(tmp, "plain");
  write(plain, "x.ts", 'import "./y";\n');
  write(plain, "y.ts", "export {};\n");
  write(plain, "z.ts", 'import "./x";\n');
  writeFileSync(join(projectDir(root, plain), "map-session.jsonl"), session(plain, [{ text: "go", files: ["x.ts"] }]));
  noGit = await startServer({ dir: plain, projectsDir: join(root, "projects"), webRoot: join(tmp, "no-web") });

  const djRepo = join(tmp, "django-repo");
  mkdirSync(djRepo);
  write(djRepo, "backend/manage.py", "#!/usr/bin/env python\n");
  write(djRepo, "backend/shop/__init__.py", "");
  write(djRepo, "backend/shop/models.py", "class X:\n    pass\n");
  write(djRepo, "backend/shop/views.py", "from .models import X\nfrom core.utils import y\ndef my_view():\n    pass\n");
  write(djRepo, "backend/shop/urls.py", "from . import views\n");
  write(djRepo, "backend/core/__init__.py", "");
  write(djRepo, "backend/core/utils.py", "def y():\n    pass\n");
  write(djRepo, "frontend/app.ts", 'import "./other";\n');
  write(djRepo, "frontend/other.ts", "export const x = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: djRepo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: djRepo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: djRepo });
  writeFileSync(
    join(projectDir(root, djRepo), "django-session.jsonl"),
    session(djRepo, [{ text: "update views and app", files: ["backend/shop/views.py", "frontend/app.ts"] }]),
  );
  djangoSrv = await startServer({ dir: djRepo, projectsDir: join(root, "projects"), webRoot: join(tmp, "no-web") });

  const pyRootsRepo = join(tmp, "py-roots-repo");
  mkdirSync(pyRootsRepo);
  write(pyRootsRepo, "vendor/libx/pyproject.toml", '[project]\nname = "libx"\n');
  write(pyRootsRepo, "vendor/libx/libx/__init__.py", "");
  write(pyRootsRepo, "vendor/libx/libx/core.py", "def f():\n    return 1\n");
  write(pyRootsRepo, "vendor/liby/pyproject.toml", '[project]\nname = "liby"\n');
  write(pyRootsRepo, "vendor/liby/src/liby/__init__.py", "");
  write(pyRootsRepo, "vendor/liby/src/liby/util.py", "def g():\n    return 2\n");
  write(pyRootsRepo, "app/main.py", "from libx.core import f\nimport liby.util\n");
  execFileSync("git", ["init", "-q"], { cwd: pyRootsRepo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: pyRootsRepo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: pyRootsRepo });
  writeFileSync(
    join(projectDir(root, pyRootsRepo), "py-roots-session.jsonl"),
    session(pyRootsRepo, [{ text: "edit main", files: ["app/main.py"] }]),
  );
  pyRootsSrv = await startServer({ dir: pyRootsRepo, projectsDir: join(root, "projects"), webRoot: join(tmp, "no-web") });
});
afterAll(async () => {
  await srv.close();
  await small.close();
  await noGit.close();
  await djangoSrv.close();
  await pyRootsSrv.close();
  rmSync(tmp, { recursive: true, force: true });
});

const ids = (r: Res, kind: string): string[] => (r.json.nodes as any[]).filter((x) => x.kind === kind).map((x) => x.id).sort();
const edgeKeys = (r: Res): string[] => (r.json.edges as any[]).map((e) => `${e.from}>${e.to}:${e.kind}`).sort();

describe("GET /api/sessions/:id/map", () => {
  test("session map: changed nodes, neighbours in both directions, deleted node, promptIndex", async () => {
    const r = await get(srv, "/api/sessions/map-session/map");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-cache, private");
    const map = ImportMapResponse.parse(r.json);
    expect(map.snapshot).toBe("working-tree");
    expect(map.prompt).toBeNull();
    expect(ids(r, "changed")).toEqual(["src/a.ts", "src/b.ts", "src/gone.ts"]);
    // outgoing: b->c, a->util, a->lib/t; incoming: user->a, other->b
    expect(ids(r, "neighbour")).toEqual(["lib/t.ts", "src/c.ts", "src/other.ts", "src/user.ts", "src/util.ts"]);
    expect(edgeKeys(r)).toEqual([
      "src/a.ts>lib/t.ts:type",
      "src/a.ts>src/b.ts:import",
      "src/a.ts>src/util.ts:import",
      "src/b.ts>src/c.ts:import",
      "src/other.ts>src/b.ts:import",
      "src/user.ts>src/a.ts:import",
    ]);
    const node = (id: string) => map.nodes.find((x) => x.id === id)!;
    expect(node("src/gone.ts").deleted).toBe(true);
    expect(map.edges.some((e) => e.from === "src/gone.ts" || e.to === "src/gone.ts")).toBe(false);
    expect(node("src/a.ts").promptIndex).toBe(1);
    expect(node("src/a.ts").deleted).toBe(false);
    expect(node("src/gone.ts").promptIndex).toBe(0);
    expect(node("src/user.ts").promptIndex).toBeNull();
    expect(node("src/user.ts").status).toBeNull();
    expect(node("src/a.ts").status).not.toBeNull();
    expect(map.nodes.some((x) => x.id === "notes.md")).toBe(false);
  });

  test("per-prompt map uses only that prompt", async () => {
    const r = await get(srv, "/api/sessions/map-session/map?prompt=0");
    expect(r.status).toBe(200);
    expect(r.json.prompt).toBe(0);
    expect(ids(r, "changed")).toEqual(["src/a.ts", "src/gone.ts"]);
    expect((r.json.nodes as any[]).find((x) => x.id === "src/a.ts").promptIndex).toBe(0);
    const r1 = await get(srv, "/api/sessions/map-session/map?prompt=1");
    expect(ids(r1, "changed")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a symlink escaping --dir is never read", async () => {
    const r = await get(srv, "/api/sessions/map-session/map");
    expect(r.json.nodes.some((x: any) => x.id === "src/evil.ts")).toBe(false);
    expect(edgeKeys(r).some((e) => e.includes("evil"))).toBe(false);
  });

  test("404 for unknown session, 404/400 for bad prompt", async () => {
    expect((await get(srv, "/api/sessions/nope/map")).status).toBe(404);
    expect((await get(srv, "/api/sessions/map-session/map?prompt=9")).status).toBe(404);
    expect((await get(srv, "/api/sessions/map-session/map?prompt=x")).status).toBe(400);
    expect((await get(srv, "/api/sessions/map-session/map?prompt=-1")).status).toBe(400);
    expect((await get(srv, "/api/sessions/map-session/map?prompt=0&prompt=1")).status).toBe(400);
  });

  test("caps: file cap and node cap report notes and truncated", async () => {
    const r = await get(small, "/api/sessions/map-session/map");
    expect(r.status).toBe(200);
    const map = ImportMapResponse.parse(r.json);
    expect(map.truncated).toBe(true);
    expect(map.nodes.length).toBeLessThanOrEqual(4);
    expect(map.hiddenNeighbours).toBeGreaterThan(0);
    expect(map.notes?.some((s) => s.includes("limited to the first 2"))).toBe(true);
    expect(map.notes?.some((s) => s.includes("hidden"))).toBe(true);
    expect(map.nodes.filter((x) => x.kind === "changed")).toHaveLength(3);
  });

  test("without git: outgoing only and a note", async () => {
    const r = await get(noGit, "/api/sessions/map-session/map");
    expect(r.status).toBe(200);
    expect(ids(r, "neighbour")).toEqual(["y.ts"]);
    expect(r.json.notes[0]).toMatch(/git ls-files failed/);
  });

  test("200 -> 304, and editing a neighbour flips the ETag", async () => {
    const a = await get(srv, "/api/sessions/map-session/map");
    const tag = a.headers.etag as string;
    expect(tag).toMatch(/^"[0-9a-f]{16}"$/);
    const b = await get(srv, "/api/sessions/map-session/map", { "If-None-Match": tag });
    expect(b.status).toBe(304);
    expect((await get(srv, "/api/sessions/map-session/map?prompt=0", { "If-None-Match": tag })).status).toBe(200);

    const f = join(repo, "src/user.ts");
    writeFileSync(f, 'import { a } from "./a";\nimport "./c";\nexport const user = a;\n');
    utimesSync(f, 1_800_000_000, 1_800_000_000);
    const c = await get(srv, "/api/sessions/map-session/map", { "If-None-Match": tag });
    expect(c.status).toBe(200);
    expect(c.headers.etag).not.toBe(tag);
    expect(c.json.edges.length).toBe(a.json.edges.length);
  });

  test("Django fixture: app layers, Python imports, and mixed TS in same response", async () => {
    const r = await get(djangoSrv, "/api/sessions/django-session/map");
    expect(r.status).toBe(200);
    const map = ImportMapResponse.parse(r.json);

    // Changed nodes
    expect(ids(r, "changed")).toEqual(["backend/shop/views.py", "frontend/app.ts"]);

    // Neighbours:
    // outgoing from views.py: backend/shop/models.py, backend/core/utils.py
    // incoming to views.py: backend/shop/urls.py
    // outgoing from app.ts: frontend/other.ts
    expect(ids(r, "neighbour")).toEqual([
      "backend/core/utils.py",
      "backend/shop/models.py",
      "backend/shop/urls.py",
      "frontend/other.ts",
    ]);

    // Edges
    expect(edgeKeys(r)).toEqual([
      "backend/shop/urls.py>backend/shop/views.py:import",
      "backend/shop/views.py>backend/core/utils.py:import",
      "backend/shop/views.py>backend/shop/models.py:import",
      "frontend/app.ts>frontend/other.ts:import",
    ]);

    // Edge kinds: all Python edges are kind "import"
    const pyEdges = map.edges.filter((e) => e.from.endsWith(".py"));
    expect(pyEdges.length).toBe(3);
    for (const e of pyEdges) {
      expect(e.kind).toBe("import");
    }

    // Layers: backend/shop, backend/core, and frontend
    const layerNames = map.layers.map((l) => l.name);
    expect(layerNames).toContain("backend/shop");
    expect(layerNames).toContain("backend/core");
    expect(layerNames).toContain("frontend");

    const nodeByPath = (path: string) => map.nodes.find((n) => n.path === path)!;
    expect(nodeByPath("backend/shop/views.py").layer).toBe("backend/shop");
    expect(nodeByPath("backend/shop/models.py").layer).toBe("backend/shop");
    expect(nodeByPath("backend/shop/urls.py").layer).toBe("backend/shop");
    expect(nodeByPath("backend/core/utils.py").layer).toBe("backend/core");
    expect(nodeByPath("frontend/app.ts").layer).toBe("frontend");
    expect(nodeByPath("frontend/other.ts").layer).toBe("frontend");
  });

  test("nested Python projects: their pyproject dirs and src layouts are import roots", async () => {
    const r = await get(pyRootsSrv, "/api/sessions/py-roots-session/map");
    expect(r.status).toBe(200);
    ImportMapResponse.parse(r.json);

    expect(ids(r, "changed")).toEqual(["app/main.py"]);
    expect(ids(r, "neighbour")).toEqual(["vendor/libx/libx/core.py", "vendor/liby/src/liby/util.py"]);
    expect(edgeKeys(r)).toEqual([
      "app/main.py>vendor/libx/libx/core.py:import",
      "app/main.py>vendor/liby/src/liby/util.py:import",
    ]);
  });

  test("a new Python project marker flips the ETag (fingerprint covers root-steering files)", async () => {
    const fpRepo = join(tmp, "fp-repo");
    mkdirSync(fpRepo);
    write(fpRepo, "vendor/libx/libx/__init__.py", "");
    write(fpRepo, "vendor/libx/libx/core.py", "def f():\n    return 1\n");
    write(fpRepo, "app/main.py", "from libx.core import f\n");
    execFileSync("git", ["init", "-q"], { cwd: fpRepo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: fpRepo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: fpRepo });

    const root = join(tmp, "p-fp");
    writeFileSync(join(projectDir(root, fpRepo), "fp-session.jsonl"), session(fpRepo, [{ text: "edit main", files: ["app/main.py"] }]));
    const fpSrv = await startServer({ dir: fpRepo, projectsDir: join(root, "projects"), webRoot: join(tmp, "no-web") });
    try {
      const before = await get(fpSrv, "/api/sessions/fp-session/map");
      expect(before.status).toBe(200);
      // Without a marker file, libx is not an import root: the Python edge is missing.
      expect(edgeKeys(before).some((e) => e.startsWith("app/main.py>"))).toBe(false);
      // Each marker's appearance must flip the fingerprint, so a held tag gets 200, never a stale 304.
      let tag = before.headers.etag as string;
      for (const marker of ["pyproject.toml", "setup.py", "setup.cfg"]) {
        write(fpRepo, `vendor/libx/${marker}`, "# marker\n");
        const r = await get(fpSrv, "/api/sessions/fp-session/map", { "If-None-Match": tag });
        expect(r.status, `after writing vendor/libx/${marker}`).toBe(200);
        expect(edgeKeys(r)).toContain("app/main.py>vendor/libx/libx/core.py:import");
        tag = r.headers.etag as string;
      }
    } finally {
      await fpSrv.close();
    }
  });

  test("new-edge detection in TS and Python, created file, unrelated edit", async () => {
    const newRepo = join(tmp, "new-edge-repo");
    mkdirSync(newRepo);
    write(newRepo, "src/a.ts", 'import { b } from "./b";\nimport { c } from "./c";\nexport const a = 1;\n');
    write(newRepo, "src/b.ts", "export const b = 2;\n");
    write(newRepo, "src/c.ts", "export const c = 3;\n");
    write(newRepo, "src/newfile.ts", 'import { b } from "./b";\nexport const n = 1;\n');
    write(newRepo, "shop/models.py", "class M:\n    pass\n");
    write(newRepo, "shop/views.py", "from .models import M\ndef v():\n    pass\n");
    execFileSync("git", ["init", "-q"], { cwd: newRepo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: newRepo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: newRepo });

    const root = join(tmp, "p-new-edge");
    const sessionLines: string[] = [];
    let t = 0;
    const addPrompt = (text: string, edits: { file: string; isCreate?: boolean; patchLines?: string[]; content?: string }[]) => {
      sessionLines.push(rec("user", newRepo, { message: { role: "user", content: text } }));
      for (const e of edits) {
        const id = `toolu_ne_${++t}`;
        const filePath = join(newRepo, e.file);
        if (e.isCreate) {
          sessionLines.push(
            rec("assistant", newRepo, {
              message: { role: "assistant", content: [{ type: "tool_use", id, name: "Write", input: { file_path: filePath, content: e.content ?? 'import { b } from "./b";\n' } }] },
            }),
          );
          sessionLines.push(
            rec("user", newRepo, {
              message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Created" }] },
              toolUseResult: { type: "create" },
            }),
          );
        } else {
          sessionLines.push(
            rec("assistant", newRepo, {
              message: { role: "assistant", content: [{ type: "tool_use", id, name: "Edit", input: { file_path: filePath, old_string: "x", new_string: "y" } }] },
            }),
          );
          sessionLines.push(
            rec("user", newRepo, {
              message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Updated" }] },
              toolUseResult: {
                type: "update",
                structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: e.patchLines?.length ?? 1, lines: e.patchLines ?? ["-old", "+new"] }],
              },
            }),
          );
        }
      }
    };

    // Prompt 0: adds import to src/c.ts in src/a.ts
    addPrompt("add import", [{ file: "src/a.ts", patchLines: ["-export const a = 1;", '+import { c } from "./c";', "+export const a = 1;"] }]);
    // Prompt 1: unrelated edit to src/a.ts
    addPrompt("unrelated edit", [{ file: "src/a.ts", patchLines: ["-export const a = 1;", "+export const a = 99;"] }]);
    // Prompt 2: created file src/newfile.ts
    addPrompt("create file", [{ file: "src/newfile.ts", isCreate: true, content: 'import { b } from "./b";\n' }]);
    // Prompt 3: python file adds import
    addPrompt("python import", [{ file: "shop/views.py", patchLines: ["-def v():", "+from .models import M", "+def v():"] }]);

    writeFileSync(join(projectDir(root, newRepo), "new-edge-session.jsonl"), sessionLines.join("\n") + "\n");
    const newSrv = await startServer({ dir: newRepo, projectsDir: join(root, "projects"), webRoot: join(tmp, "no-web") });

    try {
      // Prompt 0: a.ts -> c.ts is new; a.ts -> b.ts is NOT new
      const p0 = await get(newSrv, "/api/sessions/new-edge-session/map?prompt=0");
      expect(p0.status).toBe(200);
      expect(p0.json.playable).toBe(true);
      const e0_ac = p0.json.edges.find((e: any) => e.from === "src/a.ts" && e.to === "src/c.ts");
      const e0_ab = p0.json.edges.find((e: any) => e.from === "src/a.ts" && e.to === "src/b.ts");
      expect(e0_ac?.new).toBe(true);
      expect(e0_ab?.new).toBeUndefined();

      // Prompt 1: unrelated edit -> no new edges
      const p1 = await get(newSrv, "/api/sessions/new-edge-session/map?prompt=1");
      expect(p1.status).toBe(200);
      expect(p1.json.playable).toBe(true);
      for (const e of p1.json.edges) {
        expect(e.new).toBeUndefined();
      }

      // Prompt 2: created file -> all edges new
      const p2 = await get(newSrv, "/api/sessions/new-edge-session/map?prompt=2");
      expect(p2.status).toBe(200);
      const e2 = p2.json.edges.find((e: any) => e.from === "src/newfile.ts");
      expect(e2?.new).toBe(true);

      // Prompt 3: Python import -> new
      const p3 = await get(newSrv, "/api/sessions/new-edge-session/map?prompt=3");
      expect(p3.status).toBe(200);
      const e3 = p3.json.edges.find((e: any) => e.from === "shop/views.py" && e.to === "shop/models.py");
      expect(e3?.new).toBe(true);

      // Session map: prompt is null, playable is omitted, union of new edges
      const s = await get(newSrv, "/api/sessions/new-edge-session/map");
      expect(s.status).toBe(200);
      expect(s.json.prompt).toBeNull();
      expect(s.json.playable).toBeUndefined();
      const s_ac = s.json.edges.find((e: any) => e.from === "src/a.ts" && e.to === "src/c.ts");
      const s_ab = s.json.edges.find((e: any) => e.from === "src/a.ts" && e.to === "src/b.ts");
      const s_nf = s.json.edges.find((e: any) => e.from === "src/newfile.ts");
      const s_py = s.json.edges.find((e: any) => e.from === "shop/views.py" && e.to === "shop/models.py");
      expect(s_ac?.new).toBe(true);
      expect(s_ab?.new).toBeUndefined();
      expect(s_nf?.new).toBe(true);
      expect(s_py?.new).toBe(true);
    } finally {
      await newSrv.close();
    }
  });

  describe("listFiles", () => {
    test("default options and timeout / error behavior", async () => {
      expect(DEFAULT_LIST_FILES_TIMEOUT).toBe(10_000);
      expect(DEFAULT_LIST_FILES_MAX_BUFFER).toBe(64 * 1024 * 1024);

      const files = await listFiles(repo);
      expect(files).not.toBeNull();
      expect(files).toContain("src/a.ts");

      // Injected exec check: verifies default options
      let capturedOpts: any;
      await listFiles(repo, {
        exec: ((cmd: string, args: string[], options: any, cb: any) => {
          capturedOpts = options;
          cb(null, "src/a.ts\0");
          return {} as any;
        }) as any,
      });
      expect(capturedOpts).toEqual({
        cwd: repo,
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });

      // Injected exec check: verifies overrides
      let overrideOpts: any;
      await listFiles(repo, {
        timeout: 500,
        maxBuffer: 1024,
        exec: ((cmd: string, args: string[], options: any, cb: any) => {
          overrideOpts = options;
          cb(null, "src/a.ts\0");
          return {} as any;
        }) as any,
      });
      expect(overrideOpts).toEqual({
        cwd: repo,
        timeout: 500,
        maxBuffer: 1024,
        windowsHide: true,
      });

      // Timeout / error handling returns null via injected runner
      const timeoutErr = new Error("Command timed out");
      (timeoutErr as any).killed = true;
      (timeoutErr as any).signal = "SIGTERM";
      const timedOut = await listFiles(repo, {
        exec: ((cmd: string, args: string[], options: any, cb: any) => {
          cb(timeoutErr, "");
          return {} as any;
        }) as any,
      });
      expect(timedOut).toBeNull();

      // Synchronous throw in exec returns null
      const syncErr = await listFiles(repo, {
        exec: (() => {
          throw new Error("spawn error");
        }) as any,
      });
      expect(syncErr).toBeNull();

      // Real non-existent directory returns null
      expect(await listFiles(join(tmp, "does-not-exist"))).toBeNull();
    });
  });
});
