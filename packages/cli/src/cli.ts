import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { SessionFile } from "@lgtm/core/node";
import { discoverSessions, loadRepoScripts, projectDirFor, analyzeFile, defaultProjectsDir } from "@lgtm/core/node";
import type { Analysis, SessionAnalysis } from "@lgtm/core";
import { runExport } from "./export.js";
import { formatText, sortSessions } from "./format.js";
import { formatSummary } from "./summary.js";
import { createLauncher, openBrowser, type Launcher } from "./open.js";
import { startServer } from "./server.js";

const VERSION = "0.0.0";

const HELP = `lgtm-review ${VERSION}

Usage: lgtm-review [--dir <path>] [--projects-dir <path>] [--list | --json | --summary [--session <id-prefix>] [--no-titles] | --export <id-prefix> [--out <file>] [--force] [--no-diffs] [--no-titles]] [--no-open] [--port <n>]

Without --list/--json/--summary, starts a local web UI on 127.0.0.1 and prints its URL.

  --dir <path>           repository to inspect (default: current directory)
  --projects-dir <path>  Claude Code projects dir (default: ~/.claude/projects)
  --list                 print the sessions in the terminal instead of starting the UI
  --json                 print the analysis as JSON (implies --list)
  --summary              print a markdown review summary of one session (for a PR description)
  --session <id-prefix>  session for --summary (default: the newest)
  --no-titles            with --summary or --export: leave prompt titles out ("Prompt N")
  --export <id-prefix>   write one session as a self-contained HTML file (no JavaScript, secrets redacted best-effort)
  --out <file>           with --export: output file (default: lgtm-review-<first 8 chars of the id>.html)
  --force                with --export: overwrite an existing output file
  --no-diffs             with --export: leave the file diffs out
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

/** `--summary`: markdown for one session (the one matching the id prefix, else the newest) on stdout. */
async function summary(dir: string, files: SessionFile[], prefix: string | undefined, titles: boolean): Promise<number> {
  let pool = files;
  if (prefix !== undefined) {
    pool = files.filter((f) => f.id.startsWith(prefix));
    if (pool.length === 0) {
      console.error(`lgtm-review: no session id starts with "${prefix}"`);
      return 1;
    }
    if (pool.length > 1) {
      console.error(`lgtm-review: "${prefix}" matches ${pool.length} sessions (${pool.slice(0, 5).map((f) => f.id.slice(0, 12)).join(", ")}${pool.length > 5 ? ", …" : ""}); use a longer prefix`);
      return 1;
    }
  }
  const repo = await loadRepoScripts(dir);
  const sessions: SessionAnalysis[] = [];
  for (const f of pool) {
    try {
      sessions.push(await analyzeFile(f.path, { repo, sessionId: f.id, file: `${f.id}.jsonl` }));
    } catch (err) {
      console.error(`warning: ${f.id}.jsonl: unreadable (${err instanceof Error ? err.message : "error"})`);
    }
  }
  const chosen = sortSessions(sessions)[0];
  if (!chosen) {
    console.error("lgtm-review: no readable session");
    return 1;
  }
  process.stdout.write(formatSummary(chosen, { titles, root: dir }));
  return 0;
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
        summary: { type: "boolean" },
        session: { type: "string" },
        "no-titles": { type: "boolean" },
        export: { type: "string" },
        out: { type: "string" },
        force: { type: "boolean" },
        "no-diffs": { type: "boolean" },
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

  const exporting = values.export !== undefined;
  if (exporting && (values.list || values.json || values.summary || values.session !== undefined)) {
    console.error("lgtm-review: --export cannot be combined with --list, --json, --summary or --session");
    return 1;
  }
  if (!exporting && (values.out !== undefined || values.force || values["no-diffs"])) {
    console.error("lgtm-review: --out, --force and --no-diffs only work with --export");
    return 1;
  }
  if (exporting && !/^[A-Za-z0-9_-]+$/.test(values.export!)) {
    console.error(`lgtm-review: invalid --export "${values.export}" (expected the start of a session id)`);
    return 1;
  }
  if (exporting && values.out === "") {
    console.error("lgtm-review: --out needs a file name");
    return 1;
  }
  if (values.summary && (values.list || values.json)) {
    console.error("lgtm-review: --summary cannot be combined with --list or --json");
    return 1;
  }
  if (!values.summary && !exporting && (values.session !== undefined || values["no-titles"])) {
    console.error("lgtm-review: --session and --no-titles only work with --summary (--no-titles also with --export)");
    return 1;
  }
  if (values.session !== undefined && !/^[A-Za-z0-9_-]+$/.test(values.session)) {
    console.error(`lgtm-review: invalid --session "${values.session}" (expected the start of a session id)`);
    return 1;
  }

  const dir = resolve(values.dir ?? process.cwd());
  if (exporting) {
    return runExport({
      dir,
      projectsDir: values["projects-dir"] ?? defaultProjectsDir(),
      prefix: values.export!,
      ...(values.out !== undefined ? { out: values.out } : {}),
      force: values.force === true,
      diffs: values["no-diffs"] !== true,
      titles: values["no-titles"] !== true,
    });
  }
  if (!values.list && !values.json && !values.summary) return serve(dir, values["projects-dir"] ?? defaultProjectsDir(), port, values["no-open"] === true);

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
    if (values.summary) {
      console.error(`lgtm-review: no Claude Code sessions found for ${dir}`);
      return 1;
    }
    if (values.json) console.log(JSON.stringify({ dir, sessions: [] } satisfies Analysis, null, 2));
    else console.log(`No Claude Code sessions found for ${dir}`);
    return 0;
  }

  if (values.summary) return summary(dir, files, values.session, values["no-titles"] !== true);

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
