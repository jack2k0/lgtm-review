import { describe, expect, test } from "vitest";
import { isEnvFilePath, redact } from "./redact.js";

// Every secret below is assembled at test time from fragments and a deterministic pseudo-random body, so that no file
// of the repository contains a complete realistic secret (fixture secret scan, push protection).

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B64URL = ALNUM + "-_";
const UPPER_DIGIT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEXCH = "0123456789abcdef";

/** Deterministic body of `n` characters out of `alphabet` (LCG, seed-dependent, always contains a digit and a letter). */
function body(n: number, seed: number, alphabet = ALNUM): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  let s = "";
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    s += alphabet[(x >>> 8) % alphabet.length];
  }
  // guarantee at least one digit and one letter at fixed positions
  return "7" + s.slice(1, n - 1) + "Q";
}

interface Sample {
  name: string;
  text: string;
  /** Substrings that must not survive. */
  secrets: string[];
  kind?: string;
}

function sample(name: string, secret: string, wrap: (s: string) => string, kind?: string, extra: string[] = []): Sample {
  return { name, text: wrap(secret), secrets: [secret, ...extra], kind };
}

const id = (s: string): string => s;
const b = (n: number, seed: number, alphabet?: string): string => body(n, seed, alphabet);
/** Lowercase-only body (for a bearer token with no digits or uppercase letters). */
const lower = (n: number, seed: number): string => body(n, seed, "abcdefghijklmnopqrstuvwxyz").toLowerCase().replace(/[^a-z]/g, "q");

// Example UUID used as an npm automation token; not a real credential.
const NPM_UUID = "123e4567-e89b-12d3-a456-426614174000";

const POSITIVES: Sample[] = [
  // vendor tokens
  sample("anthropic key", "sk-" + "ant-" + "api03-" + b(60, 1, B64URL), id, "anthropic-key"),
  sample("anthropic key in sentence", "sk-" + "ant-" + b(30, 2), (s) => `use ${s} for the call`, "anthropic-key"),
  sample("openai key", "sk-" + b(48, 3), id, "openai-key"),
  sample("openai project key", "sk-" + "proj-" + b(60, 4, B64URL), id, "openai-key"),
  sample("github pat classic", "gh" + "p_" + b(36, 5), id, "github-token"),
  sample("github oauth", "gh" + "o_" + b(36, 6), id, "github-token"),
  sample("github server", "gh" + "s_" + b(36, 7), id, "github-token"),
  sample("github fine-grained", "github" + "_pat_" + b(22, 8) + "_" + b(40, 9), id, "github-token"),
  sample("gitlab token", "gl" + "pat-" + b(24, 10, B64URL), id, "gitlab-token"),
  sample("npm token", "np" + "m_" + b(36, 11), id, "npm-token"),
  sample("huggingface token", "h" + "f_" + b(34, 12, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"), id, "huggingface-token"),
  sample("sendgrid key", "S" + "G." + b(22, 13, B64URL) + "." + b(43, 14, B64URL), id, "sendgrid-key"),
  sample("aws access key id", "AK" + "IA" + b(16, 15, UPPER_DIGIT), (s) => `aws_access_key_id ${s}`, "aws-key-id"),
  sample("aws temp key id", "AS" + "IA" + b(16, 16, UPPER_DIGIT), (s) => `key ${s}.`, "aws-key-id"),
  sample("google api key", "AI" + "za" + b(35, 17, B64URL), (s) => `?key=${s}&x=1`, "google-key"),
  sample("google oauth", "ya" + "29." + b(60, 18, B64URL), id, "google-oauth"),
  sample("slack bot", "xo" + "xb-" + "1234567890-" + b(24, 19), id, "slack-token"),
  sample("slack user", "xo" + "xp-" + "1234567890-" + b(24, 20), id, "slack-token"),
  sample("slack app", "xa" + "pp-1-" + b(30, 21, B64URL), id, "slack-token"),
  sample("stripe live", "sk" + "_live_" + b(24, 22), id, "stripe-key"),
  sample("stripe restricted", "rk" + "_live_" + b(24, 23), id, "stripe-key"),
  sample("stripe test", "sk" + "_test_" + b(24, 24), id, "stripe-key"),
  sample("jwt", "ey" + "J" + b(30, 25, B64URL) + "." + "ey" + "J" + b(50, 26, B64URL) + "." + b(43, 27, B64URL), (s) => `token in log: ${s}`, "jwt"),
  sample("jwt unsigned", "ey" + "J" + b(20, 28, B64URL) + "." + b(30, 29, B64URL) + ".", id, "jwt"),
  // headers
  sample("authorization bearer", b(40, 30, B64URL), (s) => `Authorization: Bearer ${s}`, "auth-header"),
  sample("authorization basic", "dXNlcjpwYXNz" + b(12, 31), (s) => `authorization: Basic ${s}`, "auth-header"),
  sample("authorization token scheme", b(30, 32), (s) => `Authorization: token ${s}`, "auth-header"),
  sample("authorization json", b(34, 33, B64URL), (s) => `"Authorization": "Bearer ${s}"`, "auth-header"),
  sample("bearer standalone", b(32, 34, B64URL), (s) => `curl with Bearer ${s} done`, "bearer"),
  sample("x-api-key header", b(30, 35), (s) => `curl -H "x-api-key: ${s}" https://example.test`),
  sample("api-key header (azure)", b(32, 36, HEXCH), (s) => `api-key: ${s}`),
  sample("set-cookie session", b(32, 37), (s) => `Set-Cookie: session_id=${s}; Path=/; HttpOnly`, "cookie"),
  sample("cookie header", b(24, 38), (s) => `Cookie: theme=dark; auth_token=${s}; lang=en`, "cookie"),
  sample("cookie sid", b(20, 39), (s) => `cookie: connect.sid=${s}`, "cookie"),
  // urls
  sample("url credentials postgres", "s3" + "cr3t" + b(10, 40), (s) => `postgres://admin:${s}@db.example.test:5432/app`, "url-credentials"),
  sample("url credentials https", "p4" + "ssw0rd" + b(6, 41), (s) => `git clone https://bob:${s}@example.test/repo.git`, "url-credentials"),
  sample("url credentials mongodb+srv", b(14, 42), (s) => `mongodb+srv://svc:${s}@cluster0.example.test/db`, "url-credentials"),
  // assignments
  sample("env style token", b(30, 43), (s) => `GITHUB_TOKEN=${s}`, "secret"),
  sample("export api key", b(30, 44), (s) => `export OPENAI_API_KEY=${s}`, "secret"),
  sample("export anthropic key name", b(30, 45), (s) => `ANTHROPIC_API_KEY="${s}"`, "secret"),
  sample("password colon", "hunter2" + b(6, 46), (s) => `password: ${s}`, "secret"),
  sample("password quoted", "Tr0ub4dor&" + "3x", (s) => `password = "${s}"`, "secret"),
  sample("json secret", b(26, 47), (s) => `{"client_secret": "${s}"}`, "secret"),
  sample("json access_token", b(26, 48), (s) => `{"access_token":"${s}","expires_in":3600}`, "secret"),
  sample("auth_token", b(26, 49), (s) => `auth_token=${s}`, "secret"),
  sample("api-token", b(26, 50), (s) => `api-token: ${s}`, "secret"),
  sample("apikey camel", b(26, 51), (s) => `const cfg = { apiKey: '${s}' }`, "secret"),
  sample("private_key assignment", b(26, 52), (s) => `private_key=${s}`, "secret"),
  sample("credentials yaml", b(26, 53), (s) => `credentials: ${s}`, "secret"),
  sample("passwd", "pa" + "ss" + b(8, 54), (s) => `DB_PASSWD=${s}`, "secret"),
  sample("aws secret assignment", b(40, 55, B64URL), (s) => `aws_secret_access_key = ${s}`, "secret"),
  sample("aws secret with slashes", "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCY" + b(8, 56), (s) => `aws_secret_access_key=${s}`, "secret"),
  sample("assignment inside a quoted value of a harmless key", "ab&" + b(10, 70), (s) => `x = "PASSWORD=${s}"`, "secret"),
  sample("assignment inside a single-quoted value", b(26, 71), (s) => `cmd: 'GITHUB_TOKEN=${s} node run.js'`, "secret"),
  sample("assignment inside an unquoted value", b(26, 72), (s) => `env=API_KEY=${s}`, "secret"),
  sample("password with ampersand", "ab&" + b(10, 57), (s) => `PASSWORD=${s}`, "secret"),
  sample("url query token", b(24, 58), (s) => `GET /cb?access_token=${s}&state=1`, "secret"),
  sample("cli flag", b(24, 59), (s) => `deploy --token ${s} --env prod`, "secret"),
  sample("cli flag quoted", "my pass" + b(8, 60), (s) => `login --password "${s}"`, "secret"),
  sample("cli flag single quoted", "my pass" + b(8, 60), (s) => `login --password '${s}'`, "secret"),
  sample("cli flag equals", b(24, 61), (s) => `tool --api-key=${s}`, "secret"),
  sample("azure account key", b(44, 62, ALNUM) + "==", (s) => `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${s};EndpointSuffix=core`, "azure-key", []),
  sample("x-api-key lowercase json", b(28, 63), (s) => `{"x-api-key": "${s}"}`, "secret"),
  // review 2026-10-26 (S-06 F3-F7, F9-F11)
  sample("slack client xoxc", "xo" + "xc-" + "123456789012-1234567890123-" + b(24, 90), (s) => `excerpt ${s}`, "slack-token"),
  sample("slack xoxd", "xo" + "xd-" + "123456789012-1234567890123-" + b(24, 91), id, "slack-token"),
  sample("slack rotated xoxe.xoxp", "xo" + "xe.xo" + "xp-1-" + b(40, 92), id, "slack-token"),
  sample("stripe webhook secret", "wh" + "sec_" + b(28, 93), (s) => `signing ${s}`, "stripe-webhook"),
  sample("stripe key name", b(28, 94), (s) => `STRIPE_KEY=${s}`, "secret"),
  sample("url credentials empty user", "S3" + "cret" + b(8, 95), (s) => `redis://:${s}@127.0.0.1:6379/0`, "url-credentials"),
  sample("url credentials slash in password", b(10, 96) + "/" + b(10, 97), (s) => `https://admin:${s}@127.0.0.1:5432/app`, "url-credentials"),
  sample("url credentials at in password", "p" + "@ss" + b(8, 98), (s) => `postgres://admin:${s}@db.example.test/app`, "url-credentials"),
  sample("authorization lowercase bearer", lower(26, 99), (s) => `Authorization: Bearer ${s}`, "auth-header"),
  sample("authorization bot", b(24, 100) + "." + b(26, 101), (s) => `Authorization: Bot ${s}`, "auth-header"),
  sample("authorization digest response", b(32, 102, HEXCH), (s) => `Authorization: Digest username="admin", realm="x", nonce="abc123", response="${s}"`, "auth-header"),
  sample("npm authToken uuid", NPM_UUID, (s) => `//registry.npmjs.org/:_authToken=${s}`, "secret"),
  sample("long quoted passphrase", "correct horse battery staple " + b(30, 103), (s) => `password = "${s}"`, "secret"),
  sample("short cli flag value", "hun" + "ter2", (s) => `pytest -q --password ${s}`, "secret"),
  sample("json escaped quotes", b(16, 104), (s) => `{\\"password\\": \\"${s}\\"}`, "secret"),
  sample("json unicode quotes", b(16, 105), (s) => `{\\u0022api_key\\u0022: \\u0022${s}\\u0022}`, "secret"),
  sample("json escaped underscore", "gh" + "p\\u005f" + b(36, 106), id, undefined, ["gh" + "p_" + b(36, 106)]),
  // entropy with context
  sample("hex with context", b(40, 64, HEXCH), (s) => `the token is ${s}`, "secret"),
  sample("hex64 with context", b(64, 65, HEXCH), (s) => `secret: ${s}`, "secret"),
  sample("mixed with context", b(24, 66), (s) => `my api key is ${s} ok`, "secret"),
  // entropy without context
  sample("long random free", b(48, 67), (s) => `the value ${s} appeared`, "high-entropy"),
  sample("long random base64", b(44, 68, ALNUM + "+/"), (s) => `blob ${s}==`, "high-entropy"),
  sample("long random in quotes", b(52, 69, B64URL), (s) => `x = "${s}"`, "high-entropy"),
];

describe("redact: positive samples", () => {
  test("corpus size", () => {
    expect(POSITIVES.length).toBeGreaterThanOrEqual(50);
  });

  test.each(POSITIVES.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const r = redact(s.text);
    for (const secret of s.secrets) expect(r.text, `leaked: ${r.text}`).not.toContain(secret);
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.text).toContain("[redacted");
    if (s.kind) expect(r.text).toContain(`[redacted:${s.kind}]`);
  });

  test("secrets mixed into prose keep the surrounding text", () => {
    const tok = "gh" + "p_" + b(36, 70);
    const r = redact(`before ${tok} after`);
    expect(r.text).toBe("before [redacted:github-token] after");
    expect(r.count).toBe(1);
  });

  test("a literal ampersand in a secret is redacted completely (redact runs before HTML escaping)", () => {
    const pw = "ab&cd" + b(8, 71) + "&amp;x&lt";
    const r = redact(`PASSWORD=${pw} next`);
    expect(r.text).toBe("PASSWORD=[redacted:secret] next");
    expect(redact(`&lt;script&gt; &amp; text`).text).toBe("&lt;script&gt; &amp; text");
  });

  test("count is the total number of replacements", () => {
    const a = "gh" + "p_" + b(36, 72);
    const c = "sk-" + b(40, 73);
    expect(redact(`${a} and ${c} and /home/zed/x and bob@example.test`).count).toBe(4);
  });

  test("env file mode redacts every value", () => {
    const text = ["# comment", "FOO=bar", "export DB_HOST=localhost", "+NEW=value1", "EMPTY=", "TOKEN=[redacted:secret]"].join("\n");
    const r = redact(text, { envFile: true });
    expect(r.text).toBe(
      ["# comment", "FOO=[redacted:env-value]", "export DB_HOST=[redacted:env-value]", "+NEW=[redacted:env-value]", "EMPTY=", "TOKEN=[redacted:secret]"].join("\n"),
    );
    expect(r.count).toBe(3);
    expect(redact("FOO=bar").text).toBe("FOO=bar");
  });

  test("isEnvFilePath", () => {
    for (const p of [".env", "a/b/.env.local", ".env.production", "C:\\x\\.env", "prod.env"]) expect(isEnvFilePath(p), p).toBe(true);
    for (const p of ["environment.ts", "src/env.ts", "a/.envrc", "README.md"]) expect(isEnvFilePath(p), p).toBe(false);
  });
});

const NEGATIVES: [string, string][] = [
  ["relative path", "packages/core/src/redact.ts"],
  ["long relative path", "packages/web/src/components/ReviewTable/ReviewTableRow.test.tsx"],
  ["absolute path", "/usr/local/lib/node_modules/typescript/lib/typescript.js"],
  ["deep path with digits", "/var/lib/app/releases/20260101123000/current/public"],
  ["node_modules path", "node_modules/.pnpm/vitest@4.1.12/node_modules/vitest/dist/index.js"],
  ["uuid", "session 3f2b8c1e-9d4a-4b7e-8a61-2c5d7e9f0a1b started"],
  ["uuid upper", "id=3F2B8C1E-9D4A-4B7E-8A61-2C5D7E9F0A1B"],
  ["uuid with token word", "token 3f2b8c1e-9d4a-4b7e-8a61-2c5d7e9f0a1b"],
  ["git sha 40", "commit 2a4c48b0f3c1d5e6a7b8c9d0e1f2a3b4c5d6e7f8"],
  ["git sha in diff header", "index 2a4c48b0f3c1d5e6a7b8c9d0e1f2a3b4c5d6e7f8..f8f6d1f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 100644"],
  ["sha256 hex", "sha256 " + "a".repeat(8) + "0123456789abcdef".repeat(3) + "01234567"],
  ["short sha", "git show 582605b"],
  ["data url png", "data:image/png;base64," + body(200, 80, ALNUM + "+/") + "=="],
  ["data url in css", "url(data:image/svg+xml;base64," + body(120, 81, ALNUM + "+/") + ")"],
  ["sri integrity", "integrity sha512-" + body(86, 82, ALNUM + "+/") + "=="],
  ["plain prose", "The quick brown fox jumps over the lazy dog and then rests by the river."],
  ["prose about tokens", "We count input tokens and output tokens, the token limit is generous."],
  ["max_tokens", "max_tokens: 4096"],
  ["token_count", "token_count = 12345"],
  ["tokenizer", "tokenizer: gpt-bpe-merge-table"],
  ["password type", "password: string;"],
  ["token variable", "const token = parseToken(header);"],
  ["secret from env", "secret: process.env.APP_SECRET,"],
  ["token from object", "token = req.headers.authorization"],
  ["password placeholder", "password: <your-password>"],
  ["template var", "TOKEN=${{ secrets.GITHUB_TOKEN }}"],
  ["shell subst", "API_KEY=$(cat ~/.key)"],
  ["env reference", "api_key: ANTHROPIC_API_KEY"],
  ["long snake identifier", "this_is_a_very_long_snake_case_identifier_name_for_a_helper_function_1"],
  ["long camel identifier", "createSessionAnalyzerWithCustomCheckPatternsAndTimingOptions2"],
  ["long kebab name", "my-very-long-kebab-case-package-name-for-the-monorepo-workspace-2"],
  ["package@version", "react@18.2.0.beta and lodash@4.17.21"],
  ["scoped package", "@babel/plugin-transform-runtime-and-other-things-long"],
  ["url without credentials", "https://example.test/a/b/c?x=1&y=2#frag"],
  ["url port", "http://localhost:3000/api/health"],
  ["ssh git remote", "git@github.com:owner/repo.git"],
  ["version string", "v1.2.3-beta.4+build.5678"],
  ["iso timestamp", "2026-10-23T12:34:56.789Z"],
  ["hex color", "color: #ff00aa; background: #0f0f0f"],
  ["short hex without context", "id 0123456789abcdef"],
  ["tool use id", "toolu_01A2B3c4D5e6F7g8H9i0J1k2"],
  ["markdown table", "| status | checked |\n| ------ | ------- |"],
  ["sk dash in word", "task-runner and risk-assessment-for-the-quarterly-review-process"],
  ["cookie harmless", "Cookie: theme=dark; lang=en"],
  ["authorization prose", "Authorization: required for this endpoint"],
  ["bearer prose", "Bearer token authentication is described below"],
  ["key value short", "token: abc"],
  ["masked value", 'password: "********"'],
  ["empty value", 'password = ""'],
  ["path-like with slashes", "src/components/features/session/analysis/summary-panel"],
  ["rtl and unicode", "Zażółć gęślą jaźń — 日本語のテキスト"],
  ["code with colon", "const x: Record<string, number> = { a: 1 };"],
  ["private key mention", "rotate the private key regularly"],
  ["relative home mention", "~/projects/app/src/index.ts"],
];

describe("redact: negative samples", () => {
  test("corpus size", () => {
    expect(NEGATIVES.length).toBeGreaterThanOrEqual(30);
  });

  test.each(NEGATIVES)("%s", (_name, text) => {
    expect(redact(text)).toEqual({ text, count: 0 });
  });

  test("hex with context is redacted, without context it is not", () => {
    const h = body(40, 83, HEXCH);
    expect(redact(`commit ${h}`).text).toBe(`commit ${h}`);
    expect(redact(`secret = ${h}`).text).not.toContain(h);
  });

  test("uuid is not redacted next to a secret word, only as the value of a secret key", () => {
    const u = "3f2b8c1e-9d4a-4b7e-8a61-2c5d7e9f0a1b";
    expect(redact(`api key ${u}`).text).toContain(u);
    expect(redact(`request_id=${u}`).text).toContain(u);
    // npm automation tokens and some client secrets are UUIDs (review 2026-10-26, F7)
    expect(redact(`secret: ${u}`).text).not.toContain(u);
  });

  test("escaped code keeps its backslashes when it hides no secret", () => {
    const code = 'const s = "say \\"hi\\"" + "\\u0041";';
    expect(redact(code)).toEqual({ text: code, count: 0 });
  });

  test("short or prose-like auth values stay", () => {
    for (const text of ["Bearer authentication-required-header is described", "pytest --password abc", "Authorization: Bearer"]) {
      expect(redact(text).text).toBe(text);
    }
  });

  test("data url payload is never redacted", () => {
    const d = "data:image/png;base64," + body(300, 84, ALNUM + "+/");
    expect(redact(`<img src="${d}">`).text).toBe(`<img src="${d}">`);
  });
});

describe("redact: PEM blocks", () => {
  const key = (n: number) => ["-----BEGIN " + "RSA PRIVATE KEY-----", ...Array.from({ length: n }, (_, i) => body(64, 90 + i, B64URL)), "-----END " + "RSA PRIVATE KEY-----"].join("\n");

  test("whole block, line count preserved", () => {
    const k = key(5);
    const r = redact(`before\n${k}\nafter`);
    expect(r.text.split("\n").length).toBe(`before\n${k}\nafter`.split("\n").length);
    expect(r.text.startsWith("before\n[redacted:private-key]\n[redacted]")).toBe(true);
    expect(r.text.endsWith("\nafter")).toBe(true);
    expect(r.text).not.toContain("BEGIN");
    expect(r.count).toBe(1);
  });

  test("block at the very start and very end", () => {
    const k = key(2);
    expect(redact(k).text.split("\n")).toEqual(["[redacted:private-key]", "[redacted]", "[redacted]", "[redacted]"]);
    expect(redact(`x ${k}`).text.startsWith("x [redacted:private-key]")).toBe(true);
  });

  test("diff-prefixed lines stay one block", () => {
    const k = key(3)
      .split("\n")
      .map((l) => "+" + l)
      .join("\n");
    const r = redact(k);
    expect(r.text).not.toContain("BEGIN");
    expect(r.text).not.toContain(body(64, 90, B64URL));
    expect(r.text.split("\n").length).toBe(k.split("\n").length);
  });

  test("multiple blocks", () => {
    const r = redact(`${key(1)}\nmiddle\n${key(2)}`);
    expect(r.count).toBe(2);
    expect(r.text).toContain("\nmiddle\n");
    expect(r.text).not.toContain("BEGIN");
  });

  test("unterminated BEGIN redacts to the end of the text", () => {
    const text = "intro\n-----BEGIN " + "OPENSSH PRIVATE KEY-----\n" + body(64, 95, B64URL) + "\nmore text";
    const r = redact(text);
    expect(r.text).toBe("intro\n[redacted:private-key]\n[redacted]\n[redacted]");
    expect(r.count).toBe(1);
  });

  test("header split across the text is not a block; footer without header is untouched", () => {
    expect(redact("-----BEGIN " + "\nRSA PRIVATE KEY-----").count).toBe(0);
    expect(redact("-----END " + "RSA PRIVATE KEY-----").text).toBe("-----END " + "RSA PRIVATE KEY-----");
  });

  test("non private labels use the pem kind", () => {
    const r = redact("-----BEGIN " + "CERTIFICATE-----\nAAAA\n-----END " + "CERTIFICATE-----");
    expect(r.text.startsWith("[redacted:pem]")).toBe(true);
  });

  test("terminator farther than 100 KB: redacted to the end", () => {
    const text = "-----BEGIN " + "PRIVATE KEY-----\n" + "A".repeat(150_000) + "\n-----END " + "PRIVATE KEY-----\ntail";
    expect(redact(text).text).toBe("[redacted:private-key]\n[redacted]\n[redacted]\n[redacted]");
  });
});

describe("redact: identity", () => {
  test("home directories", () => {
    expect(redact("/home/jack/git/app/src/a.ts").text).toBe("~/git/app/src/a.ts");
    expect(redact("open /Users/alice/Library/x and /Users/alice").text).toBe("open ~/Library/x and ~");
    expect(redact("cd /root/work && ls /root").text).toBe("cd ~/work && ls ~");
    expect(redact("C:\\Users\\Bob\\proj\\a.txt").text).toBe("~\\proj\\a.txt");
    expect(redact("see src/home/page.ts and /rootfs/x").text).toBe("see src/home/page.ts and /rootfs/x");
  });

  test("user names jack, root, admin", () => {
    const opts = { usernames: ["jack", "root", "admin", "ab", "jack"] };
    expect(redact("hello jack, jack-of-all-trades, jackson, Jack", opts).text).toBe("hello <user>, <user>-of-all-trades, jackson, Jack");
    expect(redact("root and admin stay", opts).text).toBe("root and admin stay");
    expect(redact("ab stays", opts).text).toBe("ab stays");
    expect(redact("-home-jack-git-proj", opts).text).toBe("-home-<user>-git-proj");
  });

  test("home path rules still apply to generic names", () => {
    const opts = { usernames: ["root", "admin"] };
    expect(redact("/home/admin/x /root/y", opts).text).toBe("~/x ~/y");
  });

  test("repo dir is rewritten to <repo>", () => {
    const opts = { repoDir: "/home/jack/git/lgtm-review", usernames: ["jack"] };
    expect(redact("edit /home/jack/git/lgtm-review/src/a.ts and /home/jack/git/lgtm-review", opts).text).toBe("edit <repo>/src/a.ts and <repo>");
    expect(redact("/home/jack/git/lgtm-review-other/x", opts).text).toBe("~/git/lgtm-review-other/x");
    expect(redact("file:///home/jack/git/lgtm-review/x", { repoDir: "/home/jack/git/lgtm-review/" }).text).toBe("file://<repo>/x");
  });

  test("repo dir root or dot is ignored", () => {
    expect(redact("read /src/a.ts in /", { repoDir: "/" }).text).toBe("read /src/a.ts in /");
    expect(redact("read ./src/a.ts in .", { repoDir: "." }).text).toBe("read ./src/a.ts in .");
  });

  test("e-mail addresses", () => {
    expect(redact("mail bob.smith+tag@example.co.uk now").text).toBe("mail [redacted:email] now");
    expect(redact("Co-Authored-By: A <a@example.test>").text).toBe("Co-Authored-By: A <[redacted:email]>");
  });
});

describe("redact: properties", () => {
  const all = [...POSITIVES.map((s) => s.text), ...NEGATIVES.map(([, t]) => t)];
  const opts = { usernames: ["jack", "root"], repoDir: "/home/jack/git/app" };

  test("deterministic", () => {
    for (const t of all) expect(redact(t, opts)).toEqual(redact(t, opts));
  });

  test("idempotent per sample", () => {
    for (const t of all) {
      const once = redact(t, opts);
      const twice = redact(once.text, opts);
      expect(twice.text, t).toBe(once.text);
      expect(twice.count, t).toBe(0);
    }
  });

  test("idempotent on a mixed document, env mode and PEM", () => {
    const doc = [
      "FOO=bar",
      "token: " + b(30, 100),
      "-----BEGIN " + "PRIVATE KEY-----",
      b(64, 101, B64URL),
      "-----END " + "PRIVATE KEY-----",
      "mail jack@example.test from /home/jack/git/app/src/x.ts by jack",
      "Cookie: session=" + b(20, 102),
      "postgres://u:" + b(12, 103) + "@h/db",
    ].join("\n");
    for (const o of [opts, { ...opts, envFile: true }]) {
      const once = redact(doc, o);
      expect(redact(once.text, o)).toEqual({ text: once.text, count: 0 });
    }
  });

  test("idempotent on random fragment soup (deterministic fuzz)", () => {
    const frags = [
      "token=", "password: ", "sk-", "ant-", "Bearer ", "Authorization: ", "eyJ", ".", "/home/jack/", "jack", "@", "example.com", " ", "\n",
      "-----BEGIN X-----", "-----END X-----", "abcdefghijklmnop", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0", "://", "u:p@", '"', "'",
      "Cookie: ", "session=", "; ", "[redacted:secret]", "<user>", "~", "=", "==", "api_key", "0123456789abcdef0123456789abcdef", "--token ",
      "x", "&", "data:image/png;base64,", "/", "-", "_",
    ];
    let x = 987654;
    const rnd = (n: number): number => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return (x >>> 8) % n;
    };
    const bad: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      let s = "";
      for (let j = 2 + rnd(14); j > 0; j--) s += frags[rnd(frags.length)];
      const o = { usernames: ["jack"], repoDir: "/home/jack/app", envFile: i % 3 === 0 };
      const once = redact(s, o);
      if (redact(once.text, o).text !== once.text) bad.push(JSON.stringify(s));
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test("a user name equal to a placeholder word cannot corrupt the output", () => {
    const o = { usernames: ["redacted", "email"] };
    const once = redact("bob@example.test", o);
    expect(once.text).toBe("[redacted:email]");
  });
});

