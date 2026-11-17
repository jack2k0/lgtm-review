import { describe, expect, test } from "vitest";
import { redact } from "./redact.js";

// Table of contexts x secret shapes. Every secret is assembled at test time from fragments and a deterministic
// body, so that no file of the repository contains a complete realistic secret (fixture secret scan).

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B64URL = ALNUM + "-_";
const UPPER_DIGIT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function body(n: number, seed: number, alphabet = ALNUM): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  let s = "";
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    s += alphabet[(x >>> 8) % alphabet.length];
  }
  return "7" + s.slice(1, n - 1) + "Q";
}

const SHAPES: Array<[string, string]> = [
  ["aws access key id", "AK" + "IA" + body(16, 1, UPPER_DIGIT)],
  ["github pat", "gh" + "p_" + body(36, 2)],
  ["vault token", "hvs" + "." + body(24, 3)],
  ["discord bot token", "MTA4NjQ5ODc2NTQzMjEwOTg3Ng" + "." + "GxYz12" + "." + "AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
  ["jwt", "ey" + "J" + body(30, 4, B64URL) + "." + "ey" + "J" + body(50, 5, B64URL) + "." + body(43, 6, B64URL)],
  ["random 20-char mixed", body(20, 7)],
  ["password with dollar signs", "$" + "uper$" + "ecret99"],
];

// URL passwords cannot hold a bare `/`, `@` or space; none of the shapes does. A `$`-leading value is a literal there too.
const CONTEXTS: Array<[string, (s: string) => string, string[]?]> = [
  ["key=value", (s) => `export API_TOKEN=${s}`],
  ["yaml", (s) => `password: ${s}`],
  ["json", (s) => `{"client_secret": "${s}"}`],
  ["cli flag", (s) => `deploy --password ${s} --env prod`],
  ["url", (s) => `postgres://admin:${s}@db.internal:5432/app`],
  // A bearer token never starts with `$`; the dollar shape is covered by the API-key header.
  ["header bearer", (s) => `Authorization: Bearer ${s}`, ["password with dollar signs"]],
  ["header x-api-key", (s) => `X-Api-Key: ${s}`],
  ["xml", (s) => `<password>${s}</password>`],
  ["netrc", (s) => `machine example.test login deploy password ${s}`],
  ["fat arrow", (s) => `'password' => '${s}',`],
  ["fat arrow symbol", (s) => `config[:token] = { :token => "${s}" }`],
  ["default after ||", (s) => `const t = process.env.API_TOKEN || "${s}";`],
  ["default after ??", (s) => `const t = process.env.API_TOKEN ?? "${s}";`],
  ["default getenv", (s) => `token = getenv("API_TOKEN", "${s}")`],
  ["default os.environ.get", (s) => `password = os.environ.get("DB_PASSWORD", "${s}")`],
  ["docker login", (s) => `docker login -u deploy -p ${s} registry.example.test`],
  ["redis-cli", (s) => `redis-cli -h cache.internal -a ${s} ping`],
  ["sshpass", (s) => `sshpass -p ${s} ssh host.internal`],
];

export const CORPUS: Array<{ name: string; text: string; secret: string }> = CONTEXTS.flatMap(([cn, wrap, skip]) =>
  SHAPES.filter(([sn]) => !skip?.includes(sn)).map(([sn, secret]) => ({ name: `${cn} / ${sn}`, text: wrap(secret), secret })),
);

describe("redact corpus (context x shape)", () => {
  test.each(CORPUS)("$name", ({ text, secret }) => {
    const r = redact(text);
    expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThan(0);
    // idempotent: a second pass over redacted text changes nothing
    expect(redact(r.text).text).toBe(r.text);
  });
});

describe("redact corpus: single tools and contexts", () => {
  test.each([
    ["mysql -p glued", "mysql -u root -pHunter2Secret9 mydb", "Hunter2Secret9"],
    ["netrc multi-line", "machine h\nlogin u\npassword Zq8Lm2Nx7Rt4\n", "Zq8Lm2Nx7Rt4"],
    ["xml apiKey", "<apiKey>Zq8Lm2Nx7Rt4Wv</apiKey>", "Zq8Lm2Nx7Rt4Wv"],
    ["xml secret with attribute", '<secret type="text">Zq8Lm2Nx7Rt4Wv</secret>', "Zq8Lm2Nx7Rt4Wv"],
    ["xml token", "<token>Zq8Lm2Nx7Rt4Wv</token>", "Zq8Lm2Nx7Rt4Wv"],
    ["fat arrow double quotes", '"api_key" => "Zq8Lm2Nx7Rt4Wv"', "Zq8Lm2Nx7Rt4Wv"],
    ["default, single quotes", "const k = process.env.SECRET_KEY || 'Zq8Lm2Nx7Rt4Wv';", "Zq8Lm2Nx7Rt4Wv"],
    ["default, python environ.get", 'os.environ.get("API_KEY", "Zq8Lm2Nx7Rt4Wv")', "Zq8Lm2Nx7Rt4Wv"],
    ["default, ruby fetch", 'ENV.fetch("API_TOKEN", "Zq8Lm2Nx7Rt4Wv")', "Zq8Lm2Nx7Rt4Wv"],
  ])("redacts: %s", (_n, text, secret) => {
    const r = redact(text);
    expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThan(0);
  });
});

describe("redact corpus: ordinary text stays unchanged", () => {
  test.each([
    "Reset your password from the account settings page.",
    "The password must be at least 12 characters long.",
    "We rotate the token every 90 days and store it in the vault.",
    "<password>YOUR_PASSWORD</password>",
    "<secret>CHANGE_ME</secret>",
    "<token>${API_TOKEN}</token>",
    "<apiKey>your-api-key</apiKey>",
    "<password></password>",
    "<password>[redacted:secret]</password>",
    "'password' => env('DB_PASSWORD'),",
    "'password' => $password,",
    ":token => ENV['API_TOKEN']",
    "const t = process.env.API_TOKEN || undefined;",
    "const t = process.env.API_TOKEN ?? null;",
    "const t = process.env.API_TOKEN || process.env.FALLBACK_TOKEN;",
    'token = getenv("API_TOKEN", "")',
    'password = os.environ.get("DB_PASSWORD", None)',
    'const port = process.env.PORT || "3000";',
    'const name = process.env.APP_NAME ?? "lgtm-review";',
    'host = os.environ.get("DB_HOST", "localhost")',
    'level = getenv("LOG_LEVEL", "info")',
    "docker login -u deploy --password-stdin registry.example.test",
    "docker run -p 8080:80 nginx",
    "redis-cli -h cache.internal -p 6379 ping",
    "sshpass -p $SSH_PASSWORD ssh host.internal",
    "docker login -u deploy -p ${REGISTRY_PASSWORD} registry.example.test",
    "machine example.test login deploy password ${NETRC_PASSWORD}",
    "machine example.test login deploy",
    "the login password prompt appears after the machine boots",
    "<name>demo</name>",
    "<div class=\"password\">Enter your password</div>",
    "'password.required' => 'The password field is required.',",
    "'password' => 'password',",
    "const user = users.find((u) => token => token.value);",
    "const f = (password) => password.length > 8;",
    "$name = $_ENV['APP_NAME'] ?? 'lgtm-review';",
    'const key = process.env.API_KEY_FILE || "/etc/app/key.pem";',
    "machine learning models, login password reset flow",
    "docker login registry.example.test",
    "docker build -p . -t app",
    "redis-cli -a",
    "<title>Reset your password</title>",
    "<password>CHANGE_ME</password>",
    "<secret>changeme</secret>",
    "<password>********</password>",
  ])("unchanged: %s", (text) => {
    expect(redact(text)).toEqual({ text, count: 0 });
  });
});

describe("review round 1", () => {
  const HUNTER = "Hunter2SecretPw9";
  const LONG = "A1b2C3d4".repeat(75);

  test.each([
    "<passwordPolicy>strict</passwordPolicy>",
    "<passwordHint>Use your birthday</passwordHint>",
    "<tokenType>Bearer</tokenType>",
    "<secretName>db-main</secretName>",
    "<tokenExpiresIn>3600</tokenExpiresIn>",
    "<passwordMinLength>128</passwordMinLength>",
    "<token_type>bearer-x</token_type>",
    "'password' => 'The password field is required.',",
    "'password' => 'Your password is incorrect.',",
    "'token' => 'Token has expired',",
    "'password' => 'The password must be at least :min characters.',",
    "password: Config.PasswordMaxLength256",
    "<password>replace-with-a-strong-password</password>",
    "<apiKey>your_api_key_here</apiKey>",
    "postgres://admin:${DB_PASSWORD}@localhost/app",
    "postgres://admin:%DB_PASSWORD%@localhost/app",
    "postgres://admin:$(cat /run/pw)@localhost/app".replace(" ", ""),
    "postgres://admin:{{db_password}}@localhost/app",
  ])("unchanged: %s", (text) => {
    expect(redact(text)).toEqual({ text, count: 0 });
  });

  test.each([
    ["xml: secret word ends the tag (camelCase)", `<dbPassword>${HUNTER}</dbPassword>`],
    ["xml: client_secret", `<client_secret>${HUNTER}</client_secret>`],
    ["xml: apiToken", `<apiToken>${HUNTER}</apiToken>`],
    ["doc placeholder prefix with a literal after it", "<password>example.Hunter2xyzABC</password>"],
    ["doc placeholder prefix, underscore", "<secret>sample_9fA2xQ7mLpWv4NbYz</secret>"],
    ["xml value on the following lines", `<password>\n${HUNTER}\n</password>`],
    ["xml value above the old cap", `<token>${LONG}</token>`],
    ["xml cdata over lines", `<secret><![CDATA[\n${HUNTER}\n]]></secret>`],
    ["netrc default", "default login bob password hunter2xyz"],
    ["netrc default, new lines", "default\nlogin bob\npassword hunter2xyz"],
    ["url, unclosed ${", `postgres://admin:\${${HUNTER}@localhost/app`],
    ["url, unclosed {{", `postgres://admin:{{${HUNTER}@localhost/app`],
    ["url, unclosed $(", `postgres://admin:$(${HUNTER}@localhost/app`],
    ["url, percent word", `postgres://admin:%${HUNTER}%@localhost/app`],
    ["fat arrow passphrase of lowercase words", "'password' => 'correct horse battery staple',"],
    ["fat arrow sentence-like value with digits", "'password' => 'Pa55 word 9 here',"],
    ["dotted value, token-like segment", "password: hvs." + "CAESIJ7xk2mQpLr9tWv4NbYz"],
  ])("redacts: %s", (_n, text) => {
    const r = redact(text);
    expect(r.count).toBeGreaterThan(0);
    expect(r.text).not.toContain(HUNTER);
    expect(r.text).not.toContain(LONG);
    expect(r.text).not.toContain("hunter2xyz");
    expect(r.text).not.toMatch(/example\.Hunter|sample_9fA|correct horse|Pa55 word|CAESIJ7/);
    expect(redact(r.text).text).toBe(r.text);
  });

  test("xml: line count is kept when a multi-line value is redacted", () => {
    const r = redact(`<password>\n${HUNTER}\n</password>`);
    expect(r.text.split("\n").length).toBe(3);
  });
});
