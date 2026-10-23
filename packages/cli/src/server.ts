import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream";
import { createApi } from "./api.js";
import { sendJson } from "./http.js";
import { baseHeaders, contentTypeFor, hostAllowed, originAllowed, resolveStatic, TOKEN_HEADER, tokenValid } from "./security.js";

export interface ServerOptions {
  /** Repository the sessions belong to (reported by the API). */
  dir: string;
  /** Claude Code projects directory. */
  projectsDir: string;
  /** Local session archive directory (if any). */
  archiveDir?: string;
  /** Directory with the built web app; may not exist. */
  webRoot: string;
  /** 0 (default) picks a free port. */
  port?: number;
  /** Per-run token; random 32 bytes (hex) when omitted. */
  token?: string;
  /** Test hook: overrides the import-map caps (see `MapCaps`). */
  mapCaps?: Partial<import("./map.js").MapCaps>;
}

export interface RunningServer {
  /** `http://127.0.0.1:PORT/#k=<token>`; always the literal loopback address. */
  url: string;
  origin: string;
  port: number;
  token: string;
  server: Server;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(32).toString("hex");
  const api = createApi(opts);
  let port = 0; // set after listen; the Host/Origin checks read it per request

  const deny = (req: IncomingMessage, res: ServerResponse, status: number, error: string) => sendJson(req, res, status, { error });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(baseHeaders())) res.setHeader(k, v);

    // 1. Host first, for every request (static included).
    if (!hostAllowed(req.headers.host, port)) return deny(req, res, 403, "forbidden");
    // 2. Origin, when present, must be exactly our origin ("null" included).
    if (!originAllowed(req.headers.origin, port)) return deny(req, res, 403, "forbidden");
    // 3. Read-only server.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return deny(req, res, 405, "method not allowed");
    }

    const target = req.url ?? "";
    const pathname = target.split(/[?#]/, 1)[0] ?? "";
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      // 4. Token for everything under /api/, before any routing.
      if (!tokenValid(req.headers[TOKEN_HEADER], token)) return deny(req, res, 403, "forbidden");
      if (await api(req, res, pathname)) return;
      return deny(req, res, 404, "not found");
    }

    const r = await resolveStatic(opts.webRoot, target);
    if (r.kind === "error") return deny(req, res, r.status, r.status === 400 ? "bad request" : r.status === 403 ? "forbidden" : "not found");
    res.writeHead(200, {
      "Content-Type": contentTypeFor(r.path),
      "Content-Length": r.size,
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") return void res.end();
    pipeline(createReadStream(r.path), res, () => {});
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) deny(req, res, 500, "internal error");
      else res.destroy();
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 64;

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/#k=${token}`,
    origin,
    port,
    token,
    server,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}
