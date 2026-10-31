import { spawn, type SpawnOptions } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => { on(ev: "error", cb: () => void): unknown; unref(): void };

export interface OpenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}

/** argv for the platform's "open this URL" helper. No shell is involved anywhere. */
export function openCommand(url: string, platform: NodeJS.Platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

function ciSet(env: NodeJS.ProcessEnv): boolean {
  const v = env.CI;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** Opens `url` in the default browser. Skipped when CI is set; failures are ignored. Returns whether a launch was attempted. */
export function openBrowser(url: string, opts: OpenOptions = {}): boolean {
  if (ciSet(opts.env ?? process.env)) return false;
  const [cmd, args] = openCommand(url, opts.platform ?? process.platform);
  try {
    const child = (opts.spawnFn ?? (spawn as SpawnFn))(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML that forwards to `url`; keeps the token out of the argv of the process that opens the browser. */
export function redirectHtml(url: string): string {
  const a = escapeAttr(url);
  const js = JSON.stringify(url).replace(/</g, "\\u003c");
  return `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${a}">\n<title>lgtm-review</title>\n<a href="${a}">Continue</a>\n<script>location.replace(${js})</script>\n`;
}

export interface Launcher {
  dir: string;
  file: string;
  fileUrl: string;
  cleanup(): void;
}

/** Writes the redirect page to `<mkdtemp dir 0700>/open.html` (0600). The caller must `cleanup()`. */
export function createLauncher(url: string, baseDir: string = tmpdir()): Launcher {
  const dir = mkdtempSync(join(baseDir, "lgtm-review-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "open.html");
    writeFileSync(file, redirectHtml(url), { mode: 0o600 });
    chmodSync(file, 0o600);
    return { dir, file, fileUrl: pathToFileURL(file).href, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
