import { FileDiff, ImportMapResponse, PlayResponse, PromptDetail, SessionAnalysis, SessionsResponse } from "@lgtm/core";

/** Structural subset of a zod schema, so the web package needs no direct zod dependency. */
interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

export type ApiErrorKind = "forbidden" | "not-found" | "network" | "invalid" | "server";

export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind, message: string) {
    super(message);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.kind) {
      case "forbidden":
        return "Open the URL printed by lgtm-review";
      case "not-found":
        return "Not found: the session, prompt or file is not in the current data";
      case "network":
        return "Cannot reach the lgtm-review server. Is it still running?";
      case "invalid":
        return "Unexpected response from the server";
      case "server":
        return "The server failed to read the session data";
    }
  }
  return "Something went wrong";
}

/** Result of a conditional GET: fresh data with its validator, or "nothing changed since `etag`". */
export type Conditional<T> = { kind: "ok"; data: T; etag: string | null } | { kind: "not-modified" };

/**
 * GET with a token. The caller owns the validator (one per view): `etag` goes out as `If-None-Match` and a `304`
 * becomes `not-modified`. `cache: "no-store"` keeps the browser's HTTP cache out of it, so a 304 always reaches us.
 */
async function getConditional<T>(path: string, token: string | null, schema: Schema<T>, etag: string | null, signal?: AbortSignal): Promise<Conditional<T>> {
  if (!token) throw new ApiError("forbidden", "no token");
  const headers: Record<string, string> = { "X-Lgtm-Token": token };
  if (etag) headers["If-None-Match"] = etag;
  let res: Response;
  try {
    res = await fetch(path, { headers, cache: "no-store", credentials: "omit", signal: signal ?? null });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError("network", "fetch failed");
  }
  if (res.status === 304) {
    if (!etag) throw new ApiError("invalid", "304 without a validator");
    return { kind: "not-modified" };
  }
  if (res.status === 403) throw new ApiError("forbidden", "403");
  if (res.status === 404) throw new ApiError("not-found", "404");
  if (!res.ok) throw new ApiError("server", String(res.status));
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError("invalid", "not json");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("invalid", "schema mismatch");
  return { kind: "ok", data: parsed.data, etag: res.headers.get("ETag") };
}

export const fetchSessions = (token: string | null, etag: string | null, signal?: AbortSignal): Promise<Conditional<SessionsResponse>> =>
  getConditional("api/sessions", token, SessionsResponse, etag, signal);

export const fetchSession = (token: string | null, id: string, etag: string | null, signal?: AbortSignal): Promise<Conditional<SessionAnalysis>> =>
  getConditional(`api/sessions/${encodeURIComponent(id)}`, token, SessionAnalysis, etag, signal);

export const fetchPromptDetail = (token: string | null, id: string, index: number, etag: string | null, signal?: AbortSignal): Promise<Conditional<PromptDetail>> =>
  getConditional(`api/sessions/${encodeURIComponent(id)}/prompts/${index}`, token, PromptDetail, etag, signal);

export const fetchFileDiff = (token: string | null, id: string, index: number, path: string, etag: string | null, signal?: AbortSignal): Promise<Conditional<FileDiff>> =>
  getConditional(`api/sessions/${encodeURIComponent(id)}/prompts/${index}/diff?path=${encodeURIComponent(path)}`, token, FileDiff, etag, signal);

/** Session map (`prompt` null) or per-prompt map; always the current working tree (plan M2). */
export const fetchImportMap = (token: string | null, id: string, prompt: number | null, etag: string | null, signal?: AbortSignal): Promise<Conditional<ImportMapResponse>> =>
  getConditional(`api/sessions/${encodeURIComponent(id)}/map${prompt === null ? "" : `?prompt=${prompt}`}`, token, ImportMapResponse, etag, signal);

export const fetchPlay = (token: string | null, id: string, index: number, etag: string | null, signal?: AbortSignal): Promise<Conditional<PlayResponse>> =>
  getConditional(`api/sessions/${encodeURIComponent(id)}/prompts/${index}/play`, token, PlayResponse, etag, signal);
