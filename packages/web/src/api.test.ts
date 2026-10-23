import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, fetchFileDiff, fetchPromptDetail, fetchSession, fetchSessions } from "./api";

const TOKEN = "t".repeat(32);
const listBody = { dir: "/x", sessions: [] };

function mockFetch(make: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init, headers: init.headers as Record<string, string> });
    return make(url, init);
  });
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("conditional client", () => {
  test("first request has no If-None-Match; the response ETag is returned", async () => {
    const calls = mockFetch(() => json(listBody, 200, { ETag: '"abc"' }));
    const r = await fetchSessions(TOKEN, null);
    expect(r).toEqual({ kind: "ok", data: listBody, etag: '"abc"' });
    expect(calls[0]!.url).toBe("api/sessions");
    expect(calls[0]!.headers).toEqual({ "X-Lgtm-Token": TOKEN });
    expect(calls[0]!.init.cache).toBe("no-store");
    expect(calls[0]!.init.credentials).toBe("omit");
  });

  test("a stored ETag is sent as If-None-Match; 304 => not-modified", async () => {
    const calls = mockFetch(() => new Response(null, { status: 304, headers: { ETag: '"abc"' } }));
    expect(await fetchSessions(TOKEN, '"abc"')).toEqual({ kind: "not-modified" });
    expect(calls[0]!.headers["If-None-Match"]).toBe('"abc"');
    expect(calls[0]!.headers["X-Lgtm-Token"]).toBe(TOKEN);
  });

  test("200 -> 304 -> 200 sequence with the validator carried by the caller", async () => {
    let etag = '"v1"';
    let body: unknown = listBody;
    const calls = mockFetch((_u, init) => {
      const inm = (init.headers as Record<string, string>)["If-None-Match"];
      return inm === etag ? new Response(null, { status: 304 }) : json(body, 200, { ETag: etag });
    });
    const a = await fetchSessions(TOKEN, null);
    if (a.kind !== "ok") throw new Error("expected ok");
    expect(await fetchSessions(TOKEN, a.etag)).toEqual({ kind: "not-modified" });
    etag = '"v2"';
    body = { dir: "/y", sessions: [] };
    const c = await fetchSessions(TOKEN, a.etag);
    expect(c).toEqual({ kind: "ok", data: body, etag: '"v2"' });
    expect(calls.length).toBe(3);
  });

  test("a response without ETag yields etag null", async () => {
    mockFetch(() => json(listBody));
    expect(await fetchSessions(TOKEN, null)).toEqual({ kind: "ok", data: listBody, etag: null });
  });

  test("304 to a request that sent no validator is invalid", async () => {
    mockFetch(() => new Response(null, { status: 304 }));
    await expect(fetchSessions(TOKEN, null)).rejects.toMatchObject({ kind: "invalid" });
  });

  test.each([
    [403, "forbidden"],
    [404, "not-found"],
    [500, "server"],
    [503, "server"],
  ])("status %i -> %s", async (status, kind) => {
    mockFetch(() => json({ error: "x" }, status));
    await expect(fetchSessions(TOKEN, '"abc"')).rejects.toMatchObject({ kind });
  });

  test("network error, bad json, schema mismatch, missing token", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fail");
    });
    await expect(fetchSessions(TOKEN, null)).rejects.toMatchObject({ kind: "network" });
    mockFetch(() => new Response("{nope", { status: 200 }));
    await expect(fetchSessions(TOKEN, null)).rejects.toMatchObject({ kind: "invalid" });
    mockFetch(() => json({ wrong: true }));
    await expect(fetchSessions(TOKEN, null)).rejects.toMatchObject({ kind: "invalid" });
    const calls = mockFetch(() => json(listBody));
    await expect(fetchSessions(null, null)).rejects.toBeInstanceOf(ApiError);
    expect(calls.length).toBe(0);
  });

  test("ABORT: the signal is passed on and an aborted fetch rethrows the abort, not a network error", async () => {
    const ac = new AbortController();
    const calls = mockFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          (init.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    const p = fetchSessions(TOKEN, '"abc"', ac.signal);
    expect(calls[0]!.init.signal).toBe(ac.signal);
    ac.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).name).toBe("AbortError");
  });

  test("each route sends its validator on its own URL", async () => {
    const calls = mockFetch(() => new Response(null, { status: 304 }));
    await fetchSession(TOKEN, "a b", '"1"');
    await fetchPromptDetail(TOKEN, "s", 3, '"2"');
    await fetchFileDiff(TOKEN, "s", 3, "src/a b.ts", '"3"');
    expect(calls.map((c) => c.url)).toEqual(["api/sessions/a%20b", "api/sessions/s/prompts/3", "api/sessions/s/prompts/3/diff?path=src%2Fa%20b.ts"]);
    expect(calls.map((c) => c.headers["If-None-Match"])).toEqual(['"1"', '"2"', '"3"']);
  });
});
