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
  { re: new RegExp(`${NB}(?:xox[abprse]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9_-]{10,})`, "g"), gate: ["xox", "xapp-"], kind: "slack-token" },
  { re: new RegExp(`${NB}[sr]k_(?:live|test)_[A-Za-z0-9]{10,}`, "g"), gate: ["k_live_", "k_test_"], kind: "stripe-key" },
  { re: new RegExp(`${NB}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*`, "g"), gate: ["eyJ"], kind: "jwt" },
];

// ---------------------------------------------------------------- headers, URLs, cookies

const URL_CREDS = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/@:"'<>]{1,200}):([^\s/@"'<>]{1,200})@/gi;

const AUTH_HEADER = /(?<![A-Za-z0-9])(authorization["']?[ \t]{0,3}[:=][ \t]{0,3}["']?(?:(?:bearer|basic|token|digest|negotiate)[ \t]{1,8})?)([A-Za-z0-9._~+/=-]{8,})/gi;
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

// ---------------------------------------------------------------- key = value assignments

const ASSIGN =
  /(?<![A-Za-z0-9_.-])(["']?)(-{0,2}[A-Za-z_][A-Za-z0-9_.-]{0,60})\1([ \t]{0,3}(?::=|[:=])[ \t]{0,8})(?:"([^"\r\n]{1,300})"|'([^'\r\n]{1,300})'|((?:[^\s"',;)}\]]|;(?=\S)){6,300}))/gi;
const SECRET_WORD = /token(?!s|iz)|secret|passw(?:or)?d|api[_-]?key|credential|private[_-]?key/;
const NOT_SECRET_SUFFIX = /[_.-](?:file|path|dir|name|url|uri|type|count|limit|length|len|id|ttl|usage|budget|expires?|expiry)$/;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_STOPLIST = new Set([
  "string", "number", "boolean", "bool", "int", "integer", "float", "object", "array", "any", "unknown", "undefined", "null", "none", "nil",
  "true", "false", "required", "optional", "secret", "password", "token", "redacted", "masked", "hidden", "empty", "string[]",
]);

function isSecretKey(ident: string): boolean {
  const k = ident.toLowerCase();
  return SECRET_WORD.test(k) && !NOT_SECRET_SUFFIX.test(k);
}

/** Values that are references, types or masks rather than literals. */
function isNonLiteral(v: string, quoted: boolean): boolean {
  if (isPlaceholder(v) || UUID_VALUE.test(v)) return true;
  if (VALUE_STOPLIST.has(v.toLowerCase())) return true;
  if (/^[*x\u2022.]+$/i.test(v)) return true;
  if (/^(?:\$|%|<|\{\{|\{|\()/.test(v)) return true;
  if (quoted) return /\s/.test(v) && v.length > 40;
  if (/[([{]/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return true;
  if (/^[A-Z][A-Z_]*_[A-Z_]*$/.test(v)) return true;
  return false;
}

function redactAssign(g: Groups): string | null {
  if (!isSecretKey(g[2] as string)) return null;
  const q = g[1] as string;
  const head = q + (g[2] as string) + q + (g[3] as string);
  if (g[4] !== undefined) return isNonLiteral(g[4], true) || g[4].length < 3 ? null : `${head}"${ph("secret")}"`;
  if (g[5] !== undefined) return isNonLiteral(g[5], true) || g[5].length < 3 ? null : `${head}'${ph("secret")}'`;
  const v = g[6] as string;
  return isNonLiteral(v, false) ? null : head + ph("secret");
}

/** `--password hunter2xyz` style flags (space separated). */
const CLI_FLAG = /(?<![A-Za-z0-9-])(--?[A-Za-z][A-Za-z-]{0,30}[ \t]+)(?:"([^"\r\n]{4,300})"|'([^'\r\n]{4,300})'|([^\s"'\-/.~$<(\[{][^\s"']{7,200}))/g;

function redactFlag(g: Groups): string | null {
  const flag = (g[1] as string).trim();
  if (!isSecretKey(flag.replace(/^-+/, ""))) return null;
  const v = g[2] ?? g[3] ?? (g[4] as string);
  if (isNonLiteral(v, g[4] === undefined)) return null;
  const q = g[2] !== undefined ? '"' : g[3] !== undefined ? "'" : "";
  return `${g[1]}${q}${ph("secret")}${q}`;
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

export function redact(input: string, opts: RedactOptions = {}): RedactResult {
  // A later rule can create the context an earlier one needs (e.g. `<user>` becoming a flag value), so the
  // pipeline is repeated until the text is stable; this is what makes the function idempotent. The normal case is
  // one productive round plus one that finds nothing.
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

  t = pass(t, st, AUTH_HEADER, ["authorization"], true, (g) => (isPlaceholder(g[2] as string) || /^[a-z]+$/.test(g[2] as string) ? null : `${g[1]}${ph("auth-header")}`));
  t = pass(t, st, BEARER, ["bearer"], true, (g) => (/\d/.test(g[2] as string) ? `${g[1]}${ph("bearer")}` : null));
  t = pass(t, st, AZURE_KEY, ["accountkey", "sharedaccesskey"], true, (g) => `${g[1]}${ph("azure-key")}`);

  t = pass(t, st, COOKIE, ["cookie"], true, (g) => redactCookie(g, st));

  if (opts.envFile) {
    t = redactEnvLines(t, st);
  }

  t = pass(t, st, ASSIGN, [":", "="], false, redactAssign);
  t = pass(t, st, CLI_FLAG, ["--", " -"], false, redactFlag);

  t = pass(t, st, EMAIL, ["@"], false, redactEmail);

  if (opts.repoDir) t = replaceRepoDir(t, opts.repoDir, st);
  t = pass(t, st, HOME_UNIX, ["/home/", "/users/"], true, () => "~");
  t = pass(t, st, HOME_WIN, [":\\users", ":/users"], true, () => "~");
  t = pass(t, st, HOME_ROOT, ["/root"], false, () => "~");

  const names = [...new Set((opts.usernames ?? []).filter((u) => u.length >= 3 && !GENERIC_NAMES.has(u.toLowerCase())))].sort();
  for (const name of names) t = replaceWord(t, name, "<user>", st);

  return redactEntropy(t, st);
}
