import { request } from "node:http";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CSP, contentTypeFor, hostAllowed, originAllowed, tokenValid } from "./security.js";
import { startServer, type RunningServer } from "./server.js";

const SECRET = "TOP-SECRET-OUTSIDE-WEBROOT";
let tmp: string;
let webRoot: string;
let srv: RunningServer;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Sends a hand-written request (for targets and headers the http client refuses to produce). */
function raw(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(srv.port, "127.0.0.1");
    let out = "";
    sock.on("data", (d) => (out += d.toString("utf8")));
    sock.on("end", () => resolve(out));
    sock.on("error", reject);
    sock.write(text);
  });
}

const host = () => ({ Host: `127.0.0.1:${srv.port}` });
const auth = () => ({ "X-Lgtm-Token": srv.token });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lgtm-server-test-"));
  webRoot = join(tmp, "web");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(tmp, "package.json"), SECRET);
  writeFileSync(join(tmp, "secret.txt"), SECRET);
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(webRoot, "assets", "app.css"), "a{}");
  writeFileSync(join(webRoot, "assets", "app.js.map"), "{}");
  writeFileSync(join(webRoot, "logo.svg"), "<svg/>");
  writeFileSync(join(webRoot, "data.json"), "{}");
  writeFileSync(join(webRoot, "f.png"), "png");
  writeFileSync(join(webRoot, "favicon.ico"), "ico");
  writeFileSync(join(webRoot, "font.woff2"), "woff");
  writeFileSync(join(webRoot, "blob.xyz"), "?");
  writeFileSync(join(webRoot, "UPPER.JS"), "1");
  symlinkSync(join(tmp, "secret.txt"), join(webRoot, "link-file.txt"));
  symlinkSync(tmp, join(webRoot, "link-dir"));
  srv = await startServer({ dir: "/x", projectsDir: join(tmp, "projects"), webRoot });
});
afterAll(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("listening", () => {
  test("binds 127.0.0.1 only", () => {
    const a = srv.server.address();
    expect(a && typeof a === "object" && a.address).toBe("127.0.0.1");
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}/#k=${srv.token}`);
    expect(srv.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("tokens differ per run; custom token and busy port", async () => {
    const other = await startServer({ dir: "/x", projectsDir: tmp, webRoot, token: "abc" });
    expect(other.token).toBe("abc");
    expect(other.token).not.toBe(srv.token);
    await expect(startServer({ dir: "/x", projectsDir: tmp, webRoot, port: other.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
    await other.close();
  });
});

describe("Host (first check, all requests)", () => {
  const bad = ["evil.example", "evil.example:80", "127.0.0.1", "localhost", "127.0.0.1:1", "127.0.0.1.evil.example", "0.0.0.0", "[::1]"];
  test.each(bad)("static refused for Host %s", async (h) => {
    const r = await get("/", { Host: h });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: "forbidden" });
  });
  test.each(bad)("API with valid token still refused for Host %s", async (h) => {
    expect((await get("/api/sessions", { Host: h, ...auth() })).status).toBe(403);
  });
  test("Host check precedes method check, 404 and traversal handling", async () => {
    expect((await get("/", { Host: "evil.example" }, "POST")).status).toBe(403);
    expect((await get("/nope", { Host: "evil.example" })).status).toBe(403);
    expect((await get("/%2e%2e/x", { Host: "evil.example" })).status).toBe(403);
  });
  test("missing Host (HTTP/1.0) refused", async () => {
    expect(await raw("GET / HTTP/1.0\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/);
  });
  test("127.0.0.1:PORT and localhost:PORT accepted (connect address stays 127.0.0.1)", async () => {
    expect((await get("/", host())).status).toBe(200);
    expect((await get("/", { Host: `localhost:${srv.port}` })).status).toBe(200);
    expect((await get("/", { Host: `LOCALHOST:${srv.port}` })).status).toBe(200);
  });
  test("unit", () => {
    expect(hostAllowed(undefined, 5)).toBe(false);
    expect(hostAllowed("127.0.0.1:5", 5)).toBe(true);
    expect(hostAllowed("127.0.0.1:5 ", 5)).toBe(false);
    expect(hostAllowed("127.0.0.1:5@evil", 5)).toBe(false);
  });
});

describe("Origin", () => {
  test.each(["null", "http://evil.example", `http://localhost:${0}`, "https://127.0.0.1", "", "http://127.0.0.1:1"])("refused: %j", async (o) => {
    expect((await get("/", { ...host(), Origin: o })).status).toBe(403);
    expect((await get("/api/sessions", { ...host(), ...auth(), Origin: o })).status).toBe(403);
  });
  test("refused: localhost origin with the right port (exact match only)", async () => {
    expect((await get("/", { ...host(), Origin: `http://localhost:${srv.port}` })).status).toBe(403);
  });
  test("exact origin accepted; absent accepted", async () => {
    expect((await get("/", { ...host(), Origin: srv.origin })).status).toBe(200);
    expect((await get("/", host())).status).toBe(200);
  });
  test("unit", () => {
    expect(originAllowed(undefined, 5)).toBe(true);
    expect(originAllowed("null", 5)).toBe(false);
    expect(originAllowed("http://127.0.0.1:5", 5)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5/", 5)).toBe(false);
  });
});

describe("token on /api/*", () => {
  test("missing, empty, wrong, wrong length, near-miss -> 403", async () => {
    for (const t of [undefined, "", "wrong", srv.token + "0", srv.token.slice(0, -1), srv.token.slice(0, -1) + "x", srv.token.toUpperCase()]) {
      const r = await get("/api/sessions", t === undefined ? host() : { ...host(), "X-Lgtm-Token": t });
      expect(r.status, String(t)).toBe(403);
      expect(JSON.parse(r.body)).toEqual({ error: "forbidden" });
    }
  });
  test("token in query string or cookie does not count", async () => {
    expect((await get(`/api/sessions?k=${srv.token}`, host())).status).toBe(403);
    expect((await get("/api/sessions", { ...host(), Cookie: `k=${srv.token}`, Authorization: `Bearer ${srv.token}` })).status).toBe(403);
  });
  test("duplicated token header does not authenticate", async () => {
    const out = await raw(`GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nX-Lgtm-Token: ${srv.token}\r\nX-Lgtm-Token: ${srv.token}\r\nConnection: close\r\n\r\n`);
    expect(out).toMatch(/^HTTP\/1\.1 403/);
  });
  test("right token: unknown API path -> 404 JSON, never reaches static", async () => {
    for (const p of ["/api", "/api/", "/api/nope", "/api/sessions/a/b", "/api/sessionsx"]) {
      const r = await get(p, { ...host(), ...auth() });
      expect(r.status, p).toBe(404);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body)).toEqual({ error: "not found" });
    }
  });
  test("static assets need no token", async () => {
    expect((await get("/assets/app.js", host())).status).toBe(200);
  });
  test("unit constant-time compare", () => {
    expect(tokenValid("a", "a")).toBe(true);
    expect(tokenValid("a", "b")).toBe(false);
    expect(tokenValid(undefined, "a")).toBe(false);
    expect(tokenValid(["a", "a"], "a")).toBe(false);
    expect(tokenValid("", "")).toBe(false);
  });
});

describe("response headers", () => {
  test.each([
    ["static 200", "/", false],
    ["static 404", "/missing.js", false],
    ["API 403", "/api/sessions", false],
    ["API 404", "/api/zzz", true],
  ])("%s", async (_n, path, withToken) => {
    const r = await get(path, { ...host(), ...(withToken ? auth() : {}) });
    expect(r.headers["content-security-policy"]).toBe(CSP);
    expect(CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    if (path.startsWith("/api")) expect(r.headers["cache-control"]).toBe("no-store");
  });
  test("denied responses (bad Host / Origin / method) also carry them, and never CORS", async () => {
    const rs = [
      await get("/", { Host: "evil.example" }),
      await get("/", { ...host(), Origin: "null" }),
      await get("/", host(), "POST"),
      await get("/", { ...host(), Origin: srv.origin }),
      await get("/%2e%2e/x", host()),
      await get("/api/sessions", { ...host(), ...auth() }),
    ];
    for (const r of rs) {
      expect(r.headers["content-security-policy"]).toBe(CSP);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });
  test("preflight OPTIONS gets no CORS grant", async () => {
    const r = await get("/api/sessions", { ...host(), Origin: srv.origin, "Access-Control-Request-Method": "GET" }, "OPTIONS");
    expect(r.status).toBe(405);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
  test("only GET and HEAD", async () => {
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) expect((await get("/", host(), m)).status).toBe(405);
    const h = await get("/", host(), "HEAD");
    expect(h.status).toBe(200);
    expect(h.body).toBe("");
  });
});

describe("static files and content types", () => {
  const cases: [string, string][] = [
    ["/", "text/html; charset=utf-8"],
    ["/index.html", "text/html; charset=utf-8"],
    ["/assets/app.js", "text/javascript; charset=utf-8"],
    ["/UPPER.JS", "text/javascript; charset=utf-8"],
    ["/assets/app.css", "text/css; charset=utf-8"],
    ["/assets/app.js.map", "application/json; charset=utf-8"],
    ["/logo.svg", "image/svg+xml; charset=utf-8"],
    ["/data.json", "application/json; charset=utf-8"],
    ["/f.png", "image/png"],
    ["/favicon.ico", "image/x-icon"],
    ["/font.woff2", "font/woff2"],
    ["/blob.xyz", "application/octet-stream"],
    ["/index.html?x=1#y", "text/html; charset=utf-8"],
    ["/assets/%61pp.js", "text/javascript; charset=utf-8"],
  ];
  test.each(cases)("%s", async (path, type) => {
    const r = await get(path, host());
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe(type);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
  test("contentTypeFor", () => {
    expect(contentTypeFor("/a/b")).toBe("application/octet-stream");
    expect(contentTypeFor("x.MJS")).toBe("text/javascript; charset=utf-8");
  });
  test("directories and missing files -> 404", async () => {
    for (const p of ["/assets", "/assets/", "/nope.js"]) expect((await get(p, host())).status, p).toBe(404);
  });
});

describe("path traversal and file-system escapes", () => {
  const targets = [
    "/../package.json",
    "/../secret.txt",
    "/..%2fpackage.json",
    "/%2e%2e/package.json",
    "/%2E%2E/package.json",
    "/%2e%2e%2fpackage.json",
    "/%2e%2e%2f%2e%2e%2fetc/passwd",
    "/assets/../../package.json",
    "/assets/%2e%2e/%2e%2e/package.json",
    "/%252e%252e/package.json",
    "/..%5cpackage.json",
    "/%5c..%5cpackage.json",
    "/.%2e/package.json",
    "/%c0%ae%c0%ae/package.json",
    "/....//package.json",
    "/link-file.txt",
    "/link-dir/package.json",
    "/link-dir/secret.txt",
    "//etc/passwd",
    "//package.json",
  ];
  test.each(targets)("%s never leaks the outside file", async (t) => {
    const r = await get(t, host());
    expect([400, 403, 404], `${t} -> ${r.status}`).toContain(r.status);
    expect(r.body).not.toContain(SECRET);
  });
  test("symlink escapes are 403", async () => {
    expect((await get("/link-file.txt", host())).status).toBe(403);
    expect((await get("/link-dir/secret.txt", host())).status).toBe(403);
  });
  test("malformed percent-encoding -> 400", async () => {
    for (const t of ["/%zz", "/%", "/%E0%A4%A", "/%c0"]) {
      const r = await get(t, host());
      expect([400, 404], t).toContain(r.status);
    }
    expect((await get("/%zz", host())).status).toBe(400);
  });
  test("NUL byte -> 400", async () => {
    expect((await get("/%00", host())).status).toBe(400);
    expect((await get("/index.html%00.png", host())).status).toBe(400);
    expect((await get("/a%00/../../package.json", host())).status).toBe(400);
  });
  test("absolute-form and non-origin-form targets are refused", async () => {
    const abs = await raw(`GET http://evil.example/index.html HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nConnection: close\r\n\r\n`);
    expect(abs).toMatch(/^HTTP\/1\.1 (400|403|404)/);
    const star = await raw(`GET * HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nConnection: close\r\n\r\n`);
    expect(star).toMatch(/^HTTP\/1\.1 (400|403|404)/);
    expect(abs + star).not.toContain(SECRET);
  });
  test("raw ../ on the wire (no client normalisation)", async () => {
    const out = await raw(`GET /../package.json HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nConnection: close\r\n\r\n`);
    expect(out).toMatch(/^HTTP\/1\.1 (400|403|404)/);
    expect(out).not.toContain(SECRET);
  });
});

describe("missing web root", () => {
  test("static -> 404 JSON, API still works, no crash", async () => {
    const s = await startServer({ dir: "/x", projectsDir: tmp, webRoot: join(tmp, "does-not-exist") });
    try {
      const r = await new Promise<Res>((resolve, reject) => {
        request({ host: "127.0.0.1", port: s.port, path: "/", headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
        })
          .on("error", reject)
          .end();
      });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body)).toEqual({ error: "not found" });
    } finally {
      await s.close();
    }
  });
});
