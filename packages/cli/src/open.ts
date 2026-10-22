import { spawn, type SpawnOptions } from "node:child_process";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => { on(ev: "error", cb: () => void): unknown; unref(): void };

export interface OpenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}

/** argv for the platform's "open this URL" helper. No shell is involved anywhere. */
export function openCommand(url: string, platform: NodeJS.Platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
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
