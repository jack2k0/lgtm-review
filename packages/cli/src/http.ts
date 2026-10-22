import type { IncomingMessage, ServerResponse } from "node:http";

/** Handles an authenticated GET/HEAD under /api/. Return false when the path is unknown (-> 404). */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : data);
}
