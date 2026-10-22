import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { SessionFile } from "@lgtm/core/node";
import { discoverSessions, loadRepoScripts, projectDirFor, analyzeFile, defaultProjectsDir } from "@lgtm/core/node";
import type { Analysis, SessionAnalysis } from "@lgtm/core";
import { formatText, sortSessions } from "./format.js";

const VERSION = "0.0.0";

const HELP = `lgtm-review ${VERSION}

Usage: lgtm-review [--dir <path>] [--projects-dir <path>] [--json]

  --dir <path>           repository to inspect (default: current directory)
  --projects-dir <path>  Claude Code projects dir (default: ~/.claude/projects)
  --json                 print the analysis as JSON
  --version              print the version
  --help                 print this help
`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        dir: { type: "string" },
        "projects-dir": { type: "string" },
        json: { type: "boolean" },
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

  const dir = resolve(values.dir ?? process.cwd());
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
