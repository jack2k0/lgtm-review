/**
 * Best-effort secret and identity redaction for text taken from a session log.
 *
 * Node-free: the caller supplies the OS user names and the repository directory.
 * `redact` is pure, deterministic, idempotent (`redact(redact(x).text).text === redact(x).text`) and linear in the
 * input size: every regular expression below is either anchored by a literal prefix plus a lookbehind that stops
 * restarts inside a character run, or uses bounded quantifiers; the PEM scan and the entropy scan are manual
 * single-pass scanners. Placeholders are `[redacted:<kind>]`, `~`, `<user>` and `<repo>`; none of them can match a
 * rule again.
 *
 * `count` is the total number of replacements made (one per redacted secret, path prefix, user name or e-mail).
 *
 * Callers must run `redact` on the raw string first and HTML-escape afterwards, never the other way round.
 */

export interface RedactOptions {
  /** OS user names (from `os.userInfo()`, `USER`, ...); replaced by `<user>` in free text. Names shorter than 3 characters and the generic `root`, `user`, `admin` are ignored. */
  usernames?: readonly string[];
  /** Absolute repository directory; rewritten to `<repo>`. */
  repoDir?: string;
  /** The text is the content of an `.env*` file: every `KEY=value` value is redacted. */
  envFile?: boolean;
}

export interface RedactResult {
  text: string;
  /** Total number of replacements. */
  count: number;
}

/** True for `.env`, `.env.local`, `production.env`-style paths (any directory). */
export function isEnvFilePath(path: string): boolean {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

interface State {
  count: number;
}

type Groups = (string | undefined)[];

/** Replaces every match; `fn` returns the replacement or `null` to leave the match untouched (not counted). */
function pass(text: string, st: State, re: RegExp, gate: readonly string[], ci: boolean, fn: (g: Groups) => string | null): string {
  const hay = ci ? text.toLowerCase() : text;
  if (!gate.some((needle) => hay.includes(needle))) return text;
  return text.replace(re, (...a: unknown[]) => {
    const g = a.slice(0, -2) as Groups;
    const r = fn(g);
    if (r === null) return g[0] as string;
    st.count++;
    return r;
  });
}

const ph = (kind: string): string => `[redacted:${kind}]`;
const isPlaceholder = (s: string): boolean => s.startsWith("[redacted");

// ---------------------------------------------------------------- PEM blocks

const PEM_MAX = 100_000;

function isLabelChar(c: number): boolean {
  return c === 32 || (c >= 65 && c <= 90);
}

/** `-----BEGIN X-----` ... `-----END X-----` as one block (bounded to 100 KB; unterminated: to the end of the text). Line count is preserved. */
function redactPem(text: string, st: State): string {
  const n = text.length;
  let pos = 0;
  let from = 0;
  let out = "";
  for (;;) {
    const b = text.indexOf("-----BEGIN ", pos);
    if (b < 0) break;
    let k = b + 11;
    while (k < n && k - b < 100 && isLabelChar(text.charCodeAt(k))) k++;
    if (k === b + 11 || !text.startsWith("-----", k)) {
      pos = b + 11;
      continue;
    }
    const label = text.slice(b + 11, k);
    let end = -1;
    let e = k + 5;
    for (;;) {
      const f = text.indexOf("-----END ", e);
      if (f < 0) break;
      let m = f + 9;
      while (m < n && m - f < 110 && isLabelChar(text.charCodeAt(m))) m++;
      if (m > f + 9 && text.startsWith("-----", m)) {
        end = m + 5;
        break;
      }
      e = f + 9;
    }
    if (end < 0 || end - b > PEM_MAX) end = n;
    let lines = 0;
    for (let i = text.indexOf("\n", b); i >= 0 && i < end; i = text.indexOf("\n", i + 1)) lines++;
    out += text.slice(from, b) + ph(label.includes("PRIVATE") ? "private-key" : "pem") + "\n[redacted]".repeat(lines);
    st.count++;
    from = end;
    pos = end;
  }
  return from === 0 ? text : out + text.slice(from);
}

// ---------------------------------------------------------------- token formats

/** `[prefix pattern, kind, optional guard]`; all anchored by a lookbehind so a run is scanned once. */
const NB = "(?<![A-Za-z0-9_-])";
const TOKEN_PATTERNS: { re: RegExp; gate: string[]; kind: string; guard?: (m: string) => boolean }[] = [
  { re: new RegExp(`${NB}sk-ant-[A-Za-z0-9_-]{10,}`, "g"), gate: ["sk-ant-"], kind: "anthropic-key" },
  { re: new RegExp(`${NB}sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`, "g"), gate: ["sk-"], kind: "openai-key", guard: (m) => /\d/.test(m) },
  { re: new RegExp(`${NB}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, "g"), gate: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"], kind: "github-token" },
  { re: new RegExp(`${NB}glpat-[A-Za-z0-9_-]{20,}`, "g"), gate: ["glpat-"], kind: "gitlab-token" },
  { re: new RegExp(`${NB}npm_[A-Za-z0-9]{30,}`, "g"), gate: ["npm_"], kind: "npm-token" },
  { re: new RegExp(`${NB}hf_[A-Za-z0-9]{30,}`, "g"), gate: ["hf_"], kind: "huggingface-token" },
  { re: new RegExp(`${NB}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`, "g"), gate: ["SG."], kind: "sendgrid-key" },
  { re: new RegExp(`${NB}(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}(?![A-Za-z0-9])`, "g"), gate: ["AKIA", "ASIA", "AGPA", "AIDA", "AROA", "ANPA"], kind: "aws-key-id" },
  { re: new RegExp(`${NB}AIza[0-9A-Za-z_-]{35}`, "g"), gate: ["AIza"], kind: "google-key" },
  { re: new RegExp(`${NB}ya29\\.[A-Za-z0-9_-]{20,}`, "g"), gate: ["ya29."], kind: "google-oauth" },
  { re: new RegExp(`${NB}(?:xox(?:[abprscd]-|e\\.xoxp-)[A-Za-z0-9._-]{10,}|xapp-[0-9]-[A-Za-z0-9_-]{10,})`, "g"), gate: ["xox", "xapp-"], kind: "slack-token" },
  { re: new RegExp(`${NB}[sr]k_(?:live|test)_[A-Za-z0-9]{10,}`, "g"), gate: ["k_live_", "k_test_"], kind: "stripe-key" },
  { re: new RegExp(`${NB}whsec_[A-Za-z0-9]{10,}`, "g"), gate: ["whsec_"], kind: "stripe-webhook" },
  { re: new RegExp(`${NB}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*`, "g"), gate: ["eyJ"], kind: "jwt" },
  { re: new RegExp(`${NB}xai-[A-Za-z0-9_-]{20,}`, "g"), gate: ["xai-"], kind: "xai-key" },
  { re: new RegExp(`${NB}gsk_[A-Za-z0-9_-]{20,}`, "g"), gate: ["gsk_"], kind: "groq-key" },
  { re: new RegExp(`${NB}dop_v1_[A-Za-z0-9_-]{20,}`, "g"), gate: ["dop_v1_"], kind: "digitalocean-token" },
  { re: /(?:https?:\/\/)?hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/g, gate: ["hooks.slack.com/services/"], kind: "slack-webhook" },
];

const TOKEN_PREFIXES: readonly string[] = Array.from(
  new Set(
    TOKEN_PATTERNS.flatMap((p) =>
      p.gate.flatMap((g) => {
        if (g === "k_live_" || g === "k_test_") return [`sk_${g.slice(2)}`, `rk_${g.slice(2)}`];
        if (g.startsWith("hooks.slack.com")) return [g, `https://${g}`, `http://${g}`];
        return [g];
      })
    )
  )
);

// ---------------------------------------------------------------- headers, URLs, cookies

const URL_CREDS = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/@:"'<>]{0,200}):([^\s"'<>]{1,200})@(?=[^\s/?#]+(?:[:/?#]|$))/gi;

const AUTH_HEADER = /(?<![A-Za-z0-9])(authorization["']?[ \t]{0,3}[:=][ \t]{0,3}["']?)([^\r\n]{1,4096})/gi;
const BEARER = /(?<![A-Za-z0-9])(bearer[ \t]{1,8})([A-Za-z0-9._~+/=-]{16,})/gi;
const AZURE_KEY = /(?<![A-Za-z0-9])((?:Account|SharedAccess)Key[ \t]{0,3}=[ \t]{0,3})([A-Za-z0-9+/]{20,}={0,2})/g;

const COOKIE = /(?<![A-Za-z0-9-])((?:set-)?cookie["']?[ \t]{0,3}:[ \t]{0,3})([^\r\n"']{1,4096})/gi;
const COOKIE_SECRET_NAME = /session|sess|sid|token|auth|jwt|csrf|xsrf|secret|key|login|remember|passw/i;

function redactCookie(g: Groups, st: State): string | null {
  const parts = (g[2] as string).split(";");
  let n = 0;
  const out = parts.map((seg) => {
    const eq = seg.indexOf("=");
    if (eq < 0) return seg;
    const name = seg.slice(0, eq);
    const value = seg.slice(eq + 1);
    if (value.trim() === "" || isPlaceholder(value.trim()) || !COOKIE_SECRET_NAME.test(name)) return seg;
    n++;
    return `${name}=${ph("cookie")}`;
  });
  if (n === 0) return null;
  st.count += n - 1; // `pass` adds the last one
  return (g[1] as string) + out.join(";");
}

const AUTH_SCHEMES = new Set(["bearer", "basic", "token", "digest", "negotiate", "bot"]);
const AUTH_SCHEME = /^([A-Za-z][A-Za-z0-9_-]{0,31})[ \t]+([\s\S]*)$/;
const AUTH_TOKEN = /^[A-Za-z0-9._~+/=-]{8,}/;

/**
 * Redacts one `Authorization` header value. The whole value is credential material, but a value that is prose
 * (`Authorization: required for this endpoint`) must stay; a recognized scheme followed by a token-like run is
 * treated as a credential. Digest carries named parameters, so its whole value is replaced.
 */
function redactAuthHeader(g: Groups): string | null {
  const raw = g[2] as string;
  const value = raw.trimStart();
  if (value === "" || isPlaceholder(value)) return null;

  const scheme = AUTH_SCHEME.exec(value);
  if (scheme !== null) {
    const name = scheme[1]!.toLowerCase();
    const rest = scheme[2]!;
    if (isPlaceholder(rest)) return null;
    const prefix = value.slice(0, value.length - rest.length);
    if (name === "digest") {
      const quote = (g[1] as string).endsWith('"') && raw.endsWith('"') ? '"' : "";
      return `${g[1]}${prefix}${ph("auth-header")}${quote}`;
    }
    const token = AUTH_TOKEN.exec(rest);
    if (token === null) return null;
    const t = token[0];
    if (/^[a-z]+$/.test(t) && t.length < 16) return null;
    if (!AUTH_SCHEMES.has(name) && t.length < 16 && !/[0-9]/.test(t) && !/[A-Z]/.test(t)) return null;
    return `${g[1]}${prefix}${ph("auth-header")}${rest.slice(t.length)}`;
  }

  // No scheme: preserve the old guard that keeps ordinary lowercase prose such as `Authorization: required` intact.
  const token = AUTH_TOKEN.exec(value);
  if (token === null || /^[a-z]+$/.test(token[0])) return null;
  const t = token[0];
  if (t.length < 16 && !/[0-9]/.test(t) && !/[A-Z]/.test(t)) return null;
  return `${g[1]}${ph("auth-header")}${value.slice(t.length)}`;
}

// ---------------------------------------------------------------- key = value assignments

const ASSIGN =
  /(?<![A-Za-z0-9_.-])(["']?)(-{0,2}[A-Za-z_][A-Za-z0-9_.-]{0,60})\1([ \t]{0,3}(?::=|[:=])[ \t]{0,8})(?:"([^"\r\n]{1,300})"|'([^'\r\n]{1,300})'|((?:[^\s"',;)}\]]|;(?=\S)){3,300}))/gi;
const SECRET_WORD =
  /token(?!s|iz)|secret|passw(?:or)?d|pass[_-]?phrase|access[_-]?key|auth[_-]?key|api[_-]?key|credential|private[_-]?key|(?:stripe|webhook|signing)[_-]?(?:key|secret|token|signature)|(?:^|[_.-])(?:pass|pwd|passwd)(?=$|[_.-])/;
const NOT_SECRET_SUFFIX = /[_.-](?:file|path|dir|name|url|uri|type|count|limit|length|len|id|ttl|usage|budget|expires?|expiry)$/;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_STOPLIST = new Set([
  "string", "number", "boolean", "bool", "int", "integer", "float", "object", "array", "any", "unknown", "undefined", "null", "none", "nil",
  "true", "false", "required", "optional", "secret", "password", "token", "redacted", "masked", "hidden", "empty", "string[]",
]);

function isSecretKey(ident: string): boolean {
  const k = ident.toLowerCase().replace(/^-+/, "");
  return SECRET_WORD.test(k) && !NOT_SECRET_SUFFIX.test(k);
}

const SPECIAL_PREV_WORDS = new Set(["bearer", "basic", "-p", "-u", "--user"]);
const SEPARATOR_WORDS = new Set([":", "=", ":="]);

function isSecretAssignRun(r: string): boolean {
  const m = /^["']?(-{0,2}[A-Za-z_][A-Za-z0-9_.-]{0,60})(?::=|[:=])/.exec(r);
  if (!m) return false;
  return isSecretKey(m[1]!);
}

/**
 * Trims a trailing whitespace-delimited run that looks like the start of a secret cut mid-token:
 * - starts with a known token prefix;
 * - is a URL with credentials cut inside the password;
 * - is `key=value` or `key:value` (optionally quoted) where `isSecretKey(key)` is true;
 * - preceded by a secret flag/key (`isSecretKey` after stripping dashes/colons/equals) or Bearer/Basic/-p/-u/--user,
 *   including when separated by a spaced `:` or `=` or `:=`.
 * Otherwise returns `cut` unchanged. Linear in the length of `cut`.
 */
export function trimPartialSecret(cut: string): string {
  if (cut.length === 0 || /\s/.test(cut[cut.length - 1]!)) return cut;

  let runStart = cut.length - 1;
  while (runStart > 0 && !/\s/.test(cut[runStart - 1]!)) {
    runStart--;
  }
  const run = cut.slice(runStart);

  let wsStart = runStart;
  while (wsStart > 0 && /\s/.test(cut[wsStart - 1]!)) {
    wsStart--;
  }

  let prevWord = "";
  if (wsStart > 0) {
    let prevStart = wsStart - 1;
    while (prevStart > 0 && !/\s/.test(cut[prevStart - 1]!)) {
      prevStart--;
    }
    prevWord = cut.slice(prevStart, wsStart);

    if (SEPARATOR_WORDS.has(prevWord)) {
      let sepWsStart = prevStart;
      while (sepWsStart > 0 && /\s/.test(cut[sepWsStart - 1]!)) {
        sepWsStart--;
      }
      let sepWordStart = sepWsStart;
      while (sepWordStart > 0 && !/\s/.test(cut[sepWordStart - 1]!)) {
        sepWordStart--;
      }
      prevWord = cut.slice(sepWordStart, sepWsStart);
    }
  }

  const unquotedRun = run.replace(/^["']/, "");
  const hasTokenPrefix = TOKEN_PREFIXES.some((prefix) => unquotedRun.startsWith(prefix));
  const isUrlCreds = /^["']?[a-z][a-z0-9+.-]{1,20}:\/\/[^\s\/@:]*:/i.exec(run);
  const isUrlCredsCut = isUrlCreds !== null && !run.slice(isUrlCreds[0].length).includes("/");
  const isAssign = isSecretAssignRun(run);

  let isPrevSecret = false;
  if (prevWord !== "") {
    const noBracket = prevWord.replace(/^[{\[(]+/, "").replace(/[}\])]+$/, "");
    const colonStripped = noBracket.replace(/[:=]+$/, "");
    const quoteStripped = colonStripped.replace(/^["'`]+|["'`]+$/g, "");
    const lower = quoteStripped.toLowerCase();
    if (SPECIAL_PREV_WORDS.has(lower) || SPECIAL_PREV_WORDS.has(quoteStripped)) {
      isPrevSecret = true;
    } else {
      const cleaned = quoteStripped.replace(/^-+/, "");
      isPrevSecret = isSecretKey(cleaned);
    }
  }

  if (hasTokenPrefix || isUrlCredsCut || isAssign || isPrevSecret) {
    return cut.slice(0, wsStart);
  }
  return cut;
}

/** Values that are references, types or masks rather than literals. A secret-like key disables the UUID and quoted-prose exemptions. */
function isNonLiteral(v: string, quoted: boolean, secretContext = false): boolean {
  if (isPlaceholder(v)) return true;
  if (!secretContext && UUID_VALUE.test(v)) return true;
  if (VALUE_STOPLIST.has(v.toLowerCase())) return true;
  if (/^[*x\u2022.]+$/i.test(v)) return true;
  if (/^(?:\$|%|<|\{\{|\{|\()/.test(v)) return true;
  if (quoted && !secretContext) return /\s/.test(v) && v.length > 40;
  if (/[([{]/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return true;
  if (/^[A-Z][A-Z_]*_[A-Z_]*$/.test(v)) return true;
  return false;
}

/**
 * A value that belongs to a harmless key can itself hold an assignment (`cmd = "PASSWORD=..."`); the outer match has
 * consumed it, so the inner text is scanned again here (values are at most 300 characters, so this stays cheap).
 */
function redactInner(g: Groups, st: State): string | null {
  const q = g[4] !== undefined ? '"' : g[5] !== undefined ? "'" : "";
  const v = (g[4] ?? g[5] ?? g[6]) as string;
  if (!v.includes("=") && !v.includes(":")) return null;
  const inner: State = { count: 0 };
  const r = pass(v, inner, ASSIGN, [":", "="], false, (h) => redactAssign(h, inner));
  if (inner.count === 0) return null;
  st.count += inner.count - 1; // the caller counts the replacement itself once
  return `${g[1]}${g[2]}${g[1]}${g[3]}${q}${r}${q}`;
}

function redactAssign(g: Groups, st: State): string | null {
  const ident = g[2] as string;
  if (!isSecretKey(ident)) return redactInner(g, st);
  const k = ident.toLowerCase().replace(/^-+/, "");
  const rawVal = (g[4] ?? g[5] ?? g[6]) as string;
  if (k === "pwd" && /^[.~/]/.test(rawVal)) return null;
  const q = g[1] as string;
  const head = q + ident + q + (g[3] as string);
  if (g[4] !== undefined) return isNonLiteral(g[4], true, true) || g[4].length < 3 ? null : `${head}"${ph("secret")}"`;
  if (g[5] !== undefined) return isNonLiteral(g[5], true, true) || g[5].length < 3 ? null : `${head}'${ph("secret")}'`;
  const v = g[6] as string;
  const sep = g[3] as string;
  const kClean = k.replace(/-/g, "");
  const isPassLike =
    kClean.includes("password") ||
    kClean.includes("passwd") ||
    kClean.includes("passphrase") ||
    kClean === "pass" ||
    kClean === "pwd" ||
    kClean === "secret";
  const minLen = sep.includes("=") ? 3 : isPassLike ? 3 : 4;
  if (v.length < minLen || isNonLiteral(v, false, true)) return null;
  return head + ph("secret");
}

/** `--password hunter2xyz` style flags (space separated). */
const CLI_FLAG = /(?<![A-Za-z0-9-])(--?[A-Za-z][A-Za-z-]{0,30}[ \t]+)(?:"([^"\r\n]{4,300})"|'([^'\r\n]{4,300})'|([^\s"'\-/.~$<(\[{][^\s"']{3,200}))/g;

function redactFlag(g: Groups): string | null {
  const flag = (g[1] as string).trim();
  if (!isSecretKey(flag.replace(/^-+/, ""))) return null;
  const v = g[2] ?? g[3] ?? (g[4] as string);
  if (isNonLiteral(v, g[4] === undefined, true)) return null;
  const q = g[2] !== undefined ? '"' : g[3] !== undefined ? "'" : "";
  return `${g[1]}${q}${ph("secret")}${q}`;
}

/** `mysql -u root -phunter2xyz` style attached password flag (case-sensitive flag `-p`). */
const MYSQL_ATTACHED_P =
  /(?<![A-Za-z0-9_.-])([mM][yY][sS][qQ][lL](?:[dD][uU][mM][pP])?|[mM][aA][rR][iI][aA][dD][bB])(?:\.exe)?\b([^\r\n;|&]{0,500}?[ \t]+-p)(?:\\"([^"\r\n]{1,300})\\"|\\'([^'\r\n]{1,300})\\'|"([^"\r\n]{1,300})"|'([^'\r\n]{1,300})'|([^\s"'\-][^\s"';&|]{0,300}))/g;

function redactMysql(text: string, st: State): string {
  const hay = text.toLowerCase();
  if (!text.includes("-p") || (!hay.includes("mysql") && !hay.includes("mariadb"))) return text;
  return pass(text, st, MYSQL_ATTACHED_P, ["-p"], false, (g) => {
    const v = (g[3] ?? g[4] ?? g[5] ?? g[6] ?? g[7]) as string;
    if (isPlaceholder(v) || isNonLiteral(v, g[7] === undefined, true)) return null;
    const q = g[3] !== undefined ? '\\"' : g[4] !== undefined ? "\\'" : g[5] !== undefined ? '"' : g[6] !== undefined ? "'" : "";
    return `${g[1]}${g[2]}${q}${ph("secret")}${q}`;
  });
}

/** `sshpass -p hunter2xyz` style password flag. */
const SSHPASS =
  /(?<![A-Za-z0-9_.-])sshpass(?:\.exe)?\b((?:(?!\b(?:ssh|scp|sftp|rsync)\b)[^\r\n;|&]){0,500}?[ \t]+-p[ \t]*)(?:\\"([^"\r\n]{1,300})\\"|\\'([^'\r\n]{1,300})\\'|"([^"\r\n]{1,300})"|'([^'\r\n]{1,300})'|([^\s"'\-][^\s"';&|]{0,300}))/gi;

function redactSshpass(text: string, st: State): string {
  if (!text.toLowerCase().includes("sshpass")) return text;
  return pass(text, st, SSHPASS, ["sshpass"], true, (g) => {
    const prefix = g[1] as string;
    if (/-[efd]\b/.test(prefix)) return null;
    const v = (g[2] ?? g[3] ?? g[4] ?? g[5] ?? g[6]) as string;
    if (isPlaceholder(v) || isNonLiteral(v, g[6] === undefined, true)) return null;
    const q = g[2] !== undefined ? '\\"' : g[3] !== undefined ? "\\'" : g[4] !== undefined ? '"' : g[5] !== undefined ? "'" : "";
    return `sshpass${prefix}${q}${ph("secret")}${q}`;
  });
}

/** `curl -u user:password` and `wget --user=user:password` flags. */
const CURL_USER =
  /(?<![A-Za-z0-9_.-])(curl|wget)(?:\.exe)?\b([^\r\n;|&]{0,500}?[ \t]+(?:-[A-Za-z0-9]*u[ \t]*|--user[ \t]+|--user=))(?:\\"(.*?):(.*?)\\"|"([^":\r\n]{0,100}):([^"\r\n]{1,300})"|'([^':\r\n]{0,100}):([^'\r\n]{1,300})'|(?:\\"([^":\r\n]{0,100})\\"|"([^":\r\n]{0,100})"|'([^':\r\n]{0,100})'|([^\s"':;&|]{0,100})):(?:\\"([^"\r\n]{1,300})\\"|"([^"\r\n]{1,300})"|'([^'\r\n]{1,300})'|([^\s"';&|]{1,300})))/gi;

function redactCurl(text: string, st: State): string {
  const hay = text.toLowerCase();
  if (!hay.includes("curl") && !hay.includes("wget")) return text;
  return pass(text, st, CURL_USER, ["curl", "wget"], true, (g) => {
    const cmd = g[1] as string;
    const flag = g[2] as string;
    if (g[4] !== undefined) {
      if (isPlaceholder(g[4])) return null;
      return `${cmd}${flag}\\"${g[3]}:${ph("secret")}\\"`;
    }
    if (g[6] !== undefined) {
      if (isPlaceholder(g[6])) return null;
      return `${cmd}${flag}"${g[5]}:${ph("secret")}"`;
    }
    if (g[8] !== undefined) {
      if (isPlaceholder(g[8])) return null;
      return `${cmd}${flag}'${g[7]}:${ph("secret")}'`;
    }
    const uStr = g[9] !== undefined ? `\\"${g[9]}\\"` : g[10] !== undefined ? `"${g[10]}"` : g[11] !== undefined ? `'${g[11]}'` : (g[12] ?? "");
    const passVal = (g[13] ?? g[14] ?? g[15] ?? g[16]) as string;
    if (isPlaceholder(passVal) || isNonLiteral(passVal, g[16] === undefined, true)) return null;
    const pStr = g[13] !== undefined ? `\\"${ph("secret")}\\"` : g[14] !== undefined ? `"${ph("secret")}"` : g[15] !== undefined ? `'${ph("secret")}'` : ph("secret");
    return `${cmd}${flag}${uStr}:${pStr}`;
  });
}

/** `KEY=value` lines of an `.env` file (also diff lines starting with `+`, `-` or a space). */
const ENV_LINE = /^([+\- ]?[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.]{0,100}[ \t]*=[ \t]*)(?!\[redacted)[^\r\n]*[^\s][^\r\n]*$/gm;
const ENV_MARK = "[redacted:env-value]";

function countOccurrences(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Plain string replacement (no per-match callback); the count is the growth in placeholders. */
function redactEnvLines(text: string, st: State): string {
  if (!text.includes("=")) return text;
  const before = countOccurrences(text, ENV_MARK);
  const out = text.replace(ENV_LINE, `$1${ENV_MARK}`);
  st.count += countOccurrences(out, ENV_MARK) - before;
  return out;
}

// ---------------------------------------------------------------- e-mail

const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24})(?![A-Za-z0-9-])/g;

function redactEmail(g: Groups): string | null {
  if ((g[1] as string).toLowerCase() === "git") return null;
  const labels = (g[2] as string).split(".");
  if (labels.slice(0, -1).every((l) => /^[0-9]+$/.test(l))) return null;
  return ph("email");
}

// ---------------------------------------------------------------- paths and user names

const HOME_UNIX = /(?<![A-Za-z0-9_.~-])\/(?:home|Users)\/[^\s/"'`<>:;,)\]\\|]{1,64}/g;
const HOME_WIN = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]Users[\\/][^\s\\/"'`<>:;,)\]|]{1,64}/g;
const HOME_ROOT = /(?<![A-Za-z0-9_.~-])\/root(?=\/|[\s"'`)\]:;,]|$)/g;

const GENERIC_NAMES = new Set(["root", "user", "admin", "redacted", "email", "repo"]);
const isWordChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/** Whole-word, case-sensitive replacement of `word` (manual scan, linear). */
function replaceWord(text: string, word: string, repl: string, st: State): string {
  let pos = 0;
  let from = 0;
  let out = "";
  for (;;) {
    const i = text.indexOf(word, pos);
    if (i < 0) break;
    const e = i + word.length;
    pos = i + 1;
    if (i > 0 && isWordChar(text.charCodeAt(i - 1))) continue;
    if (e < text.length && isWordChar(text.charCodeAt(e))) continue;
    out += text.slice(from, i) + repl;
    st.count++;
    from = e;
    pos = e;
  }
  return from === 0 ? text : out + text.slice(from);
}

function replaceRepoDir(text: string, dirIn: string, st: State): string {
  const dir = dirIn.length > 1 ? dirIn.replace(/[\\/]+$/, "") : dirIn;
  if (dir.length < 2 || dir === "." || !text.includes(dir)) return text;
  const pathChar = (c: number): boolean => isWordChar(c) || c === 46 || c === 45; // [A-Za-z0-9_.-]
  let pos = 0;
  let from = 0;
  let out = "";
  for (;;) {
    const i = text.indexOf(dir, pos);
    if (i < 0) break;
    const e = i + dir.length;
    pos = i + 1;
    if (i > 0 && (pathChar(text.charCodeAt(i - 1)) || text.charCodeAt(i - 1) === 126)) continue;
    if (e < text.length && pathChar(text.charCodeAt(e))) continue;
    out += text.slice(from, i) + "<repo>";
    st.count++;
    from = e;
    pos = e;
  }
  return from === 0 ? text : out + text.slice(from);
}

// ---------------------------------------------------------------- entropy tokenizer

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-fA-F]+$/;
const CTX_WORDS = "(?:token|secret|passw(?:or)?d|api[ _-]?key|access[ _-]?key|credentials?|private[ _-]?key|bearer|authorization)";
const CONTEXT = new RegExp(`${CTX_WORDS}[A-Za-z0-9_.-]{0,20}["']?[ \\t:=]{0,6}(?:(?:is|was|=>)[ \\t:]{1,3})?["'\`(<]{0,2}$`, "i");
const ENT_MIN_CTX = 16;
const ENT_MIN_FREE = 40;

/** Characters of a candidate token: base64 / base64url alphabet; `=` only as trailing padding. */
function isTokenChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 95 || c === 45;
}

function charClass(c: number): number {
  if (c >= 97 && c <= 122) return 0;
  if (c >= 65 && c <= 90) return 1;
  if (c >= 48 && c <= 57) return 2;
  return 3;
}

function shannon(s: string): number {
  const freq = new Map<number, number>();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  let h = 0;
  for (const f of freq.values()) {
    const p = f / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function hasSecretContext(text: string, start: number): boolean {
  let before = text.slice(Math.max(0, start - 64), start);
  const nl = before.lastIndexOf("\n");
  if (nl >= 0) before = before.slice(nl + 1);
  return CONTEXT.test(before);
}

/** Looks like `a/b/c`: several lowercase-ish segments. */
function isPathLike(token: string): boolean {
  if (!token.includes("/")) return false;
  if (token.startsWith("/") || token.includes("//")) return true;
  const segs = token.split("/").filter((s) => s !== "");
  if (segs.length < 3) return false;
  const words = segs.filter((s) => /^[A-Za-z][a-z0-9_-]*$/.test(s)).length;
  return words * 2 >= segs.length;
}

/** Returns the redaction kind for a run `text[start, end)` or null. `end` excludes padding, `padEnd` includes it. */
function classifyRun(text: string, start: number, end: number): string | null {
  const len = end - start;
  if (len < ENT_MIN_CTX) return null;
  const prev = start > 0 ? text.charCodeAt(start - 1) : 0;
  if (prev === 46 || prev === 126 || prev === 37 || prev === 36) return null; // . ~ % $
  if (end < text.length && text.charCodeAt(end) === 46 && end + 1 < text.length && isWordChar(text.charCodeAt(end + 1))) return null;
  const token = text.slice(start, end);
  if (UUID.test(token)) return null;
  if (/^sha(?:1|256|384|512)-/i.test(token)) return null;
  if (prev === 44 || prev === 58) {
    // data:<mime>;base64,<payload>
    let b = start - 1;
    while (b > 0 && start - b < 200 && !/[\s"'`()<>]/.test(text[b - 1] as string)) b--;
    if (/^data:/i.test(text.slice(b, start))) return null;
  }
  if (isPathLike(token)) return null;
  const ctx = hasSecretContext(text, start);
  if (HEX.test(token)) return ctx && len >= 32 ? "secret" : null;
  let letters = 0;
  let digits = 0;
  let upper = 0;
  let lower = 0;
  let trans = 0;
  let last = -1;
  for (let i = 0; i < token.length; i++) {
    const cls = charClass(token.charCodeAt(i));
    if (cls === 0) (lower++, letters++);
    else if (cls === 1) (upper++, letters++);
    else if (cls === 2) digits++;
    if (last >= 0 && cls !== last) trans++;
    last = cls;
  }
  const h = shannon(token);
  if (ctx) {
    return h >= 3.0 && (digits > 0 || (upper > 0 && lower > 0)) ? "secret" : null;
  }
  if (len < ENT_MIN_FREE || h < 4.0 || letters === 0 || digits === 0) return null;
  if (trans < 0.45 * len) return null;
  return "high-entropy";
}

function redactEntropy(text: string, st: State): string {
  const n = text.length;
  let out = "";
  let from = 0;
  let i = 0;
  while (i < n) {
    if (!isTokenChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isTokenChar(text.charCodeAt(j))) j++;
    let padEnd = j;
    while (padEnd < n && padEnd - j < 2 && text.charCodeAt(padEnd) === 61) padEnd++;
    if (padEnd < n && padEnd > j && isTokenChar(text.charCodeAt(padEnd))) padEnd = j;
    if (j - i >= ENT_MIN_CTX) {
      const kind = classifyRun(text, i, j);
      if (kind !== null) {
        out += text.slice(from, i) + ph(kind);
        from = padEnd;
        st.count++;
      }
    }
    i = padEnd;
  }
  return from === 0 ? text : out + text.slice(from);
}

// ---------------------------------------------------------------- entry point

/**
 * JSON escaping hides secrets from every rule (`\"`, `\u0022`, `\u005f`). Decodes the printable-ASCII JSON escapes in
 * one linear pass; control escapes such as `\n` and `\r` stay so line structure is preserved. Used only on a copy:
 * `redact` keeps the original spelling unless the decoded copy reveals more secrets.
 */
const JSON_PRINTABLE_ESCAPE = /\\(?:u00([2-7][0-9a-f])|(["\/]))/gi;

function normalizeJsonEscapes(text: string): string {
  if (!text.includes("\\")) return text;
  return text.replace(JSON_PRINTABLE_ESCAPE, (m, hex: string | undefined, chr: string | undefined) => {
    if (hex === undefined) return chr as string;
    const code = parseInt(hex, 16);
    return code <= 0x7e ? String.fromCharCode(code) : m;
  });
}

export function redact(input: string, opts: RedactOptions = {}): RedactResult {
  // A later rule can create the context an earlier one needs (e.g. `<user>` becoming a flag value), so the
  // pipeline is repeated until the text is stable; this is what makes the function idempotent. The normal case is
  // one productive round plus one that finds nothing.
  const plain = redactStable(input, opts);
  // Escaped text (`{\"password\": \"x\"}`) is redacted in decoded form, but only when decoding reveals a secret the
  // escaped spelling hid; otherwise code such as `"say \"hi\""` keeps its backslashes.
  const decoded = normalizeJsonEscapes(plain.text);
  if (decoded === plain.text) return plain;
  const again = redactStable(decoded, opts);
  return again.count > 0 ? { text: again.text, count: plain.count + again.count } : plain;
}

function redactStable(input: string, opts: RedactOptions): RedactResult {
  const st: State = { count: 0 };
  let t = input;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = redactOnce(t, opts, st);
    if (next === t) break;
    t = next;
  }
  return { text: t, count: st.count };
}

const MAX_ROUNDS = 6;

function redactOnce(input: string, opts: RedactOptions, st: State): string {
  let t = input;

  t = redactPem(t, st);

  t = pass(t, st, URL_CREDS, ["://"], false, (g) => (isPlaceholder(g[2] as string) || /^[$%{]/.test(g[3] as string) ? null : `${g[1]}${ph("url-credentials")}@`));

  for (const p of TOKEN_PATTERNS) {
    t = pass(t, st, p.re, p.gate, false, (g) => (p.guard && !p.guard(g[0] as string) ? null : ph(p.kind)));
  }

  t = pass(t, st, AUTH_HEADER, ["authorization"], true, redactAuthHeader);
  t = pass(t, st, BEARER, ["bearer"], true, (g) => (/\d/.test(g[2] as string) ? `${g[1]}${ph("bearer")}` : null));
  t = pass(t, st, AZURE_KEY, ["accountkey", "sharedaccesskey"], true, (g) => `${g[1]}${ph("azure-key")}`);

  t = pass(t, st, COOKIE, ["cookie"], true, (g) => redactCookie(g, st));

  if (opts.envFile) {
    t = redactEnvLines(t, st);
  }

  t = pass(t, st, ASSIGN, [":", "="], false, (g) => redactAssign(g, st));
  t = pass(t, st, CLI_FLAG, ["--", " -"], false, redactFlag);
  t = redactMysql(t, st);
  t = redactSshpass(t, st);
  t = redactCurl(t, st);

  t = pass(t, st, EMAIL, ["@"], false, redactEmail);

  if (opts.repoDir) t = replaceRepoDir(t, opts.repoDir, st);
  t = pass(t, st, HOME_UNIX, ["/home/", "/users/"], true, () => "~");
  t = pass(t, st, HOME_WIN, [":\\users", ":/users"], true, () => "~");
  t = pass(t, st, HOME_ROOT, ["/root"], false, () => "~");

  const names = [...new Set((opts.usernames ?? []).filter((u) => u.length >= 3 && !GENERIC_NAMES.has(u.toLowerCase())))].sort();
  for (const name of names) t = replaceWord(t, name, "<user>", st);

  return redactEntropy(t, st);
}
