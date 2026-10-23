import { PromptDetail, SessionAnalysis, SessionsResponse } from "@lgtm/core";

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
        return "Not found";
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

async function getJson<T>(path: string, token: string | null, schema: Schema<T>, signal?: AbortSignal): Promise<T> {
  if (!token) throw new ApiError("forbidden", "no token");
  let res: Response;
  try {
    res = await fetch(path, { headers: { "X-Lgtm-Token": token }, cache: "no-store", credentials: "omit", signal: signal ?? null });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError("network", "fetch failed");
  }
  if (res.status === 403) throw new ApiError("forbidden", "403");
  if (res.status === 404) throw new ApiError("not-found", "404");
  if (!res.ok) throw new ApiError("server", String(res.status));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("invalid", "not json");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("invalid", "schema mismatch");
  return parsed.data;
}

export const fetchSessions = (token: string | null, signal?: AbortSignal): Promise<SessionsResponse> =>
  getJson("api/sessions", token, SessionsResponse, signal);

export const fetchSession = (token: string | null, id: string, signal?: AbortSignal): Promise<SessionAnalysis> =>
  getJson(`api/sessions/${encodeURIComponent(id)}`, token, SessionAnalysis, signal);

export const fetchPromptDetail = (token: string | null, id: string, index: number, signal?: AbortSignal): Promise<PromptDetail> =>
  getJson(`api/sessions/${encodeURIComponent(id)}/prompts/${index}`, token, PromptDetail, signal);
