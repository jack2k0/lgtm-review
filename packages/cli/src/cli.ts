import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { SessionFile } from "@lgtm/core/node";
import { discoverSessions, loadRepoScripts, projectDirFor, analyzeFile, defaultProjectsDir } from "@lgtm/core/node";
import type { Analysis, SessionAnalysis } from "@lgtm/core";
import { formatText, sortSessions } from "./format.js";
import { createLauncher, openBrowser, type Launcher } from "./open.js";
import { startServer } from "./server.js";

const VERSION = "0.0.0";

const HELP = `lgtm-review ${VERSION}

Usage: lgtm-review [--dir <path>] [--projects-dir <path>] [--list | --json] [--no-open] [--port <n>]

Without --list/--json, starts a local web UI on 127.0.0.1 and prints its URL.

  --dir <path>           repository to inspect (default: current directory)
  --projects-dir <path>  Claude Code projects dir (default: ~/.claude/projects)
  --list                 print the sessions in the terminal instead of starting the UI
  --json                 print the analysis as JSON (implies --list)
  --no-open              do not open the browser
  --port <n>             port for the UI (default: a free port)
  --version              print the version
  --help                 print this help
`;

async function serve(dir: string, projectsDir: string, port: number, noOpen: boolean): Promise<number> {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "web");
  let running;
  try {
    running = await startServer({ dir, projectsDir, webRoot, port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") console.error(`lgtm-review: port ${port} is already in use`);
    else console.error(`lgtm-review: cannot start server: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  process.stdout.write(`${running.url}\n`);
  console.error("lgtm-review: serving on 127.0.0.1 only; press Ctrl+C to stop");
  let launcher: Launcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    launcher?.cleanup();
    launcher = undefined;
  };
  process.once("exit", cleanup);
  if (!noOpen) {
    try {
      launcher = createLauncher(running.url);
      timer = setTimeout(cleanup, 60_000);
      timer.unref();
      if (!openBrowser(launcher.fileUrl)) cleanup();
    } catch {
      cleanup();
    }
  }
  return new Promise<number>((done) => {
    const stop = () => {
      cleanup();
      void running.close().then(() => done(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        dir: { type: "string" },
        "projects-dir": { type: "string" },
        json: { type: "boolean" },
        list: { type: "boolean" },
        "no-open": { type: "boolean" },
        port: { type: "string" },
        version: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`lgtm-review: ${err instanceof Error ? err.message : err}\n\n${HELP}`);
    return 1;
  }
  if (values.version) {
    console.log(`lgtm-review ${VERSION}`);
    return 0;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  let port = 0;
  if (values.port !== undefined) {
    port = /^\d{1,5}$/.test(values.port) ? Number(values.port) : NaN;
    if (!(port >= 0 && port <= 65535)) {
      console.error(`lgtm-review: invalid --port "${values.port}" (expected 0-65535)`);
      return 1;
    }
  }

  const dir = resolve(values.dir ?? process.cwd());
  if (!values.list && !values.json) return serve(dir, values["projects-dir"] ?? defaultProjectsDir(), port, values["no-open"] === true);

  const projectDir = projectDirFor(dir, values["projects-dir"] ?? defaultProjectsDir());
  const discoveryWarnings: string[] = [];
  let files: SessionFile[];
  try {
    files = await discoverSessions(projectDir, discoveryWarnings);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") files = [];
    else {
      console.error(`lgtm-review: cannot read ${projectDir}: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }
  for (const w of discoveryWarnings) console.error(`warning: ${w}`);

  if (files.length === 0) {
    if (values.json) console.log(JSON.stringify({ dir, sessions: [] } satisfies Analysis, null, 2));
    else console.log(`No Claude Code sessions found for ${dir}`);
    return 0;
  }

  const repo = await loadRepoScripts(dir);
  const sessions: SessionAnalysis[] = [];
  for (const f of files) {
    try {
      sessions.push(await analyzeFile(f.path, { repo, sessionId: f.id, file: `${f.id}.jsonl` }));
    } catch (err) {
      console.error(`warning: ${f.id}.jsonl: unreadable (${err instanceof Error ? err.message : "error"})`);
    }
  }

  if (values.json) {
    console.log(JSON.stringify({ dir, sessions: sortSessions(sessions) } satisfies Analysis, null, 2));
  } else {
    const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
    console.log(formatText(sessions, { color, dir }));
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`lgtm-review: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  },
);
