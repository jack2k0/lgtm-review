import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createAnalyzer } from "@lgtm/core";
import type { FileDiff, PromptDetail, SessionAnalysis } from "@lgtm/core";
import { buildExportInput } from "./export.js";
import { EXPORT_CSP, EXPORT_CSS, escapeHtml, renderExport, type ExportInput, type ExportOptions } from "./export-html.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../core/fixtures");
const sessionsDir = join(fixturesRoot, "sessions");
const REDACT = { usernames: ["jack"], repoDir: "/home/user/project" } as const;
const BASE: ExportOptions = { titles: true, diffs: true, exportedAt: "2026-10-23", redact: REDACT };

function fixtureInput(name: string, diffs = true): ExportInput {
  const a = createAnalyzer({ detail: true, sessionId: `${name}-0000`, file: `${name}.jsonl` });
  for (const l of readFileSync(join(sessionsDir, `${name}.jsonl`), "utf8").split("\n").filter((x) => x !== "")) a.push(l);
  return buildExportInput(a.finish(), a, { diffs }).input;
}

const GOLDEN = ["hints-test-edits", "failing-check", "steps-mixed"];

describe("golden exports (synthetic fixtures)", () => {
  test.each(GOLDEN)("%s with diffs", async (name) => {
    const r = renderExport(fixtureInput(name), BASE);
    expect(renderExport(fixtureInput(name), BASE).html).toBe(r.html);
    await expect(r.html).toMatchFileSnapshot(join(sessionsDir, "__golden__", `${name}.export.html`));
  });

  test.each(GOLDEN)("%s with --no-diffs --no-titles", async (name) => {
    const r = renderExport(fixtureInput(name, false), { ...BASE, diffs: false, titles: false });
    expect(r.html).not.toContain('class="diff"');
    await expect(r.html).toMatchFileSnapshot(join(sessionsDir, "__golden__", `${name}.nodiffs.export.html`));
  });
});

describe("inherited prompts", () => {
  const marked = (from: number[], to = "0123456789abcdef") => {
    const input = fixtureInput("steps-mixed");
    const prompts = input.analysis.prompts.map((p, i) => (from.includes(i) ? { ...p, inheritedFrom: to } : p));
    return { ...input, analysis: { ...input.analysis, prompts } };
  };
  test("rows are left out, a note says how many", () => {
    const n = fixtureInput("steps-mixed").analysis.prompts.length;
    const html = renderExport(marked([0]), BASE).html;
    expect(html).toContain("1 prompt inherited from 01234567 omitted.");
    expect(html).not.toContain('id="p1"');
    expect(html).toContain(`id="p${n}"`);
  });
  test("all inherited: only the note, no table", () => {
    const n = fixtureInput("steps-mixed").analysis.prompts.length;
    const html = renderExport(marked([...Array(n).keys()]), BASE).html;
    expect(html).toContain(`All ${n} prompts inherited from 01234567. No prompts to review.`);
    expect(html).not.toContain("<table");
    expect(html).not.toContain('class="prompt"');
  });
});

// ------------------------------------------------------------------ structure helpers

const ALLOWED_TAGS = new Set(["html", "head", "meta", "title", "style", "body", "header", "main", "h1", "h2", "h3", "h4", "dl", "dt", "dd", "p", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "span", "div", "section", "ul", "ol", "li", "details", "summary", "pre", "blockquote", "br"]);
const ALLOWED_ATTRS = new Set(["lang", "charset", "http-equiv", "content", "name", "class", "id", "href", "style", "role", "aria-label", "aria-hidden", "tabindex"]);
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z][A-Za-z-]*(?:="[^"]*")?)*)\s*\/?>/g;
const ATTR_RE = /\s+([A-Za-z][A-Za-z-]*)(?:="([^"]*)")?/g;

interface Parsed {
  tags: { name: string; attrs: [string, string][] }[];
  text: string;
  css: string;
}

/** Splits a generated document into tags and text. Every `<` of the text is escaped, so a `<` that is not a well-formed tag is a failure. */
function parse(html: string): Parsed {
  const m = /<style>\n([\s\S]*?)<\/style>/.exec(html)!;
  const rest = html.replace(m[0], "<style></style>").replace(/^<!doctype html>\n/, "");
  const tags: Parsed["tags"] = [];
  const text = rest.replace(TAG_RE, (_all, close: string, name: string, attrs: string) => {
    if (close === "") {
      const list: [string, string][] = [];
      for (const a of attrs.matchAll(ATTR_RE)) list.push([a[1]!, a[2] ?? ""]);
      tags.push({ name: name.toLowerCase(), attrs: list });
    } else tags.push({ name: `/${name.toLowerCase()}`, attrs: [] });
    return "\u0001";
  });
  expect(text, "a '<' outside a well-formed tag").not.toContain("<");
  return { tags, text, css: m[1]! };
}

function assertSafe(html: string): Parsed {
  const p = parse(html);
  expect(p.css).toBe(EXPORT_CSS);
  expect(EXPORT_CSS).not.toMatch(/url\(|@import|https?:|expression\(|javascript:/i);
  expect(html).not.toMatch(/<script/i);
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`);
  expect(EXPORT_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  for (const t of p.tags) {
    expect(ALLOWED_TAGS.has(t.name.replace("/", "")), `tag ${t.name}`).toBe(true);
    for (const [n, v] of t.attrs) {
      expect(ALLOWED_ATTRS.has(n), `attribute ${n}`).toBe(true);
      expect(n.startsWith("on")).toBe(false);
      if (t.name !== "meta") expect(v, `${n} value`).not.toMatch(/https?:\/\/|javascript:|data:|[<>`]/i);
      if (n === "href") expect(v).toMatch(/^#p\d+$/);
      if (n === "id") expect(v).toMatch(/^p\d+$/);
      if (n === "style") expect(v).toMatch(/^width:\d{1,3}(\.\d{1,2})?%$/);
      if (n === "class") expect(v).toMatch(/^[A-Za-z0-9 _-]+$/);
      if (n === "aria-label") expect(v).toMatch(/^[A-Za-z ]+$/);
      if (t.name !== "meta" && n !== "href") expect(v, `${t.name} ${n}`).toMatch(/^[A-Za-z0-9 _.%:-]*$/);
    }
  }
  return p;
}

// ------------------------------------------------------------------ safety on real fixtures

describe("safety properties of the fixture exports", () => {
  const all = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
  test.each(all)("%s: structure, CSP, no script, no external URL", (name) => {
    for (const diffs of [true, false]) {
      const { html } = renderExport(fixtureInput(name, diffs), { ...BASE, diffs });
      const p = assertSafe(html);
      expect(p.tags.some((t) => t.name === "script")).toBe(false);
    }
  });

  test("status is text, hints and time bar are present", () => {
    const html = renderExport(fixtureInput("hints-test-edits"), BASE).html;
    for (const w of ["Checked", "Read flagged", "assertions-removed", "Approximate time split", "<details", "heuristic", "best-effort"]) expect(html).toContain(w);
    expect(html).toMatch(/class="dot dot-checked" aria-hidden="true"><\/span>Checked/);
  });

  test("the secret scan patterns of the fixtures do not match the golden exports", () => {
    const patterns: RegExp[] = [/sk-ant-/, /sk-[A-Za-z0-9]{20,}/, /ghp_|github_pat_/, /AKIA[0-9A-Z]{16}/, /-----BEGIN .*PRIVATE KEY-----/, /(token|secret|password)\s*[=:]\s*\S{8,}/i, /\/Users\//, /\/home\/(?!user\/)/];
    const goldenDir = join(sessionsDir, "__golden__");
    const files = readdirSync(goldenDir).filter((f) => f.endsWith(".export.html"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(goldenDir, f), "utf8").split("\n").forEach((line, i) => {
        for (const re of patterns) if (re.test(line)) hits.push(`${relative(fixturesRoot, join(goldenDir, f))}:${i + 1}: ${re}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("--no-titles leaves prompt text and the session title out", () => {
    const html = renderExport(fixtureInput("hints-test-edits", false), { ...BASE, diffs: false, titles: false }).html;
    expect(html).not.toContain("Fix the add function");
    expect(html).not.toContain("Skip the flaky retry test");
    expect(html).toContain("<title>Review export</title>");
    expect(html).toContain("<h3>Prompt 2</h3>");
  });
});

// ------------------------------------------------------------------ hostile and secret-bearing content

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function body(n: number, seed: number): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  let s = "";
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    s += ALNUM[(x >>> 8) % ALNUM.length];
  }
  return "7" + s.slice(1, n - 1) + "Q";
}

// Assembled at test time from fragments so that no file of the repository holds a complete realistic secret.
const SECRETS: string[] = [
  "sk-" + "ant-" + "api03-" + body(60, 101),
  "sk-" + body(48, 102),
  "gh" + "p_" + body(36, 103),
  "github" + "_pat_" + body(22, 104) + "_" + body(40, 105),
  "AK" + "IA" + body(16, 106).toUpperCase(),
  "AI" + "za" + body(35, 107),
  "xo" + "xb-" + "1234567890-" + body(24, 108),
  "sk" + "_live_" + body(24, 109),
  "ey" + "J" + body(30, 110) + "." + "ey" + "J" + body(50, 111) + "." + body(43, 112),
  "Authorization: Bearer " + body(40, 113),
  "postgres://admin:" + "s3" + "cr3t" + body(10, 114) + "@db.example.test:5432/app",
  "PASSWORD=ab&" + body(10, 115),
  "Set-Cookie: session_id=" + body(32, 116) + "; Path=/",
  "export OPENAI_API_KEY=" + body(30, 117),
  "client_secret: " + body(26, 118),
  "aws_secret_access_key=" + "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCY" + body(8, 119),
];
/** The part of each sample that must not survive. */
const LEAKS = SECRETS.map((s) => s.replace(/^(Authorization: Bearer |PASSWORD=|Set-Cookie: session_id=|export OPENAI_API_KEY=|client_secret: |aws_secret_access_key=)/, "").replace(/^postgres:\/\/admin:/, "").replace(/@db\.example\.test.*$/, "").replace(/; Path=\/$/, ""));
const PEM = ["-----BEGIN " + "RSA PRIVATE KEY-----", body(64, 120), body(64, 121), body(30, 122), "-----END " + "RSA PRIVATE KEY-----"];

const PAYLOADS = [
  "</style><img src=x onerror=alert(1)>",
  "javascript:alert(1)",
  '" onmouseover="alert(1)',
  "' onfocus='alert(1)",
  "<script>alert(1)</script>",
  "</title><script>x</script><!--",
  "&lt;b&gt; &amp; &#60;",
  "`tick`",
  "\u0000\u0001\u0008\r\u007f\u0085 nul",
  "‮ rtl ⁦",
];

function hostile(tag: string): string {
  return `${PAYLOADS.join(" ~ ")} CANARY-${tag}\n${SECRETS.join("\n")}`;
}

function hostileInput(): ExportInput {
  const hint = (tag: string) => ({ rule: hostile(`hr-${tag}`) as never, severity: "high" as const, path: hostile(`hp-${tag}`), reason: hostile(`hz-${tag}`) });
  const prompt = (i: number): SessionAnalysis["prompts"][number] => ({
    index: i,
    uuid: "u",
    text: hostile(`text${i}`),
    status: "failing",
    reason: hostile(`reason${i}`),
    files: [
      { path: hostile(`dpath${i}`), kind: "M", added: 1, removed: 2, maybeIncomplete: true },
      { path: "/home/user/project/.env.local", kind: "A", added: 2, removed: 0, maybeIncomplete: false },
    ],
    partial: true,
    timeSplit: { readMs: 1000, writeMs: 2000, checkMs: 3000, fixMs: 4000 },
    activeMs: 10000,
    headline: hostile(`headline${i}`),
    hints: [hint(String(i))],
    recommendation: "read-all",
  });
  const analysis: SessionAnalysis = {
    sessionId: hostile("sid"),
    title: hostile("title"),
    branch: hostile("branch"),
    startedAt: hostile("started"),
    prompts: [prompt(0), prompt(1)],
    warnings: [{ file: hostile("wfile"), line: 3, reason: hostile("wreason") }],
  };
  const details: PromptDetail[] = analysis.prompts.map((p) => ({
    index: p.index,
    text: p.text,
    status: p.status,
    reason: p.reason,
    headline: p.headline,
    startedAt: hostile("dstarted"),
    activeMs: 1,
    truncated: true,
    hints: p.hints,
    recommendation: p.recommendation,
    steps: [
      {
        n: 1,
        phase: "check",
        title: hostile(`stitle${p.index}`),
        startedAt: hostile("sstarted"),
        durationMs: 1234,
        check: { command: hostile(`cmd${p.index}`), exitCode: 1, passed: false, excerpt: hostile(`excerpt${p.index}`) },
        quotes: [hostile(`quote${p.index}`)],
        actions: [{ tool: hostile(`tool${p.index}`), summary: hostile(`asum${p.index}`), ok: false, ts: hostile("ats") }],
        files: [hostile(`sfile${p.index}`)],
      },
    ],
  }));
  const pemLines = PEM.map((s) => ({ t: "+" as const, s }));
  const diffs = new Map<number, FileDiff[]>(
    analysis.prompts.map((p) => [
      p.index,
      [
        {
          path: hostile(`dpath${p.index}`),
          kind: "A",
          truncated: true,
          maybeIncomplete: true,
          hunks: [
            {
              header: hostile(`hdr${p.index}`),
              lines: [
                ...SECRETS.flatMap((s) => [
                  { t: "+" as const, s: `x = "${s}"` },
                  { t: "-" as const, s },
                  { t: " " as const, s: `${PAYLOADS[0]} ${s}` },
                ]),
                { t: " ", s: "before" },
                ...pemLines,
                { t: " ", s: "after" },
              ],
            },
          ],
        },
        {
          path: `/home/user/project/.env.local`,
          kind: "A",
          truncated: false,
          maybeIncomplete: false,
          hunks: [{ header: "@@ -0,0 +1,2 @@", lines: [{ t: "+", s: "API_URL=plain-value-for-env-check" }, { t: "+", s: "NAME=another-env-value-9" }] }],
        },
      ],
    ]),
  );
  return { analysis, details, diffs };
}

describe("hostile and secret-bearing content", () => {
  const opts: ExportOptions = { ...BASE, redact: { usernames: ["jack"], repoDir: "/home/user/project" } };
  const { html, redactions } = renderExport(hostileInput(), opts);

  test("the document stays well formed and inert", () => {
    const p = assertSafe(html);
    // every payload is inert text: no tag, attribute or script came out of it
    expect(p.tags.filter((t) => t.name === "img" || t.name === "script")).toEqual([]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("</style><");
    expect(html.split("</style>").length).toBe(2);
    expect(html.split("</title>").length).toBe(2);
    expect(html).toContain("&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    expect(html).toContain("&#39; onfocus=&#39;alert(1)");
    expect(html).toContain("&#96;tick&#96;");
  });

  test("entity-looking input is escaped once more, control and bidi characters are dropped", () => {
    expect(html).toContain("&amp;lt;b&amp;gt; &amp;amp; &amp;#60;");
    expect(html).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
    expect(html).toContain(" nul");
  });

  test("no sample secret survives in any field, escaped or not", () => {
    for (const leak of [...SECRETS, ...LEAKS, ...PEM.slice(1, 4)]) {
      expect(html.includes(leak), `leaked ${leak.slice(0, 12)}…`).toBe(false);
      expect(html.includes(escapeHtml(leak)), `leaked (escaped) ${leak.slice(0, 12)}…`).toBe(false);
    }
    expect(html).not.toContain("plain-value-for-env-check");
    expect(html).not.toContain("another-env-value-9");
    expect(redactions).toBeGreaterThan(SECRETS.length * 10);
  });

  test("a secret containing & is redacted as a whole", () => {
    const part = SECRETS[11]!.slice("PASSWORD=".length);
    expect(part).toContain("&");
    const value = part.slice(part.indexOf("&") + 1);
    expect(value.length).toBeGreaterThan(8);
    for (const frag of [value, part, escapeHtml(part), "ab&amp;" + value.slice(0, 6)]) expect(html.includes(frag), frag).toBe(false);
  });

  test("home paths, user names and the repository are rewritten", () => {
    const r = renderExport(
      {
        analysis: { ...hostileInput().analysis, title: "t", prompts: [{ ...hostileInput().analysis.prompts[0]!, text: "see /home/jack/work/x.ts and /Users/jack/y and /home/user/project/src/a.ts as jack", files: [] }] },
        details: [],
        diffs: new Map(),
      },
      opts,
    );
    expect(r.html).toContain("see ~/work/x.ts and ~/y and &lt;repo&gt;/src/a.ts as &lt;user&gt;");
  });

  test("a PEM block in a diff keeps the number of lines", () => {
    const rows = (html.match(/class="dl dl-/g) ?? []).length;
    const input = hostileInput();
    const expected = [...input.diffs.values()].flat().reduce((a, d) => a + d.hunks.reduce((b, h) => b + 1 + h.lines.length, 0), 0);
    expect(rows).toBe(expected);
    expect(html).toContain("[redacted:private-key]");
  });

  test("another run gives the same bytes", () => {
    expect(renderExport(hostileInput(), opts).html).toBe(html);
  });
});

describe("escapeHtml", () => {
  test("escapes the five characters and the backtick, drops control characters except newline and tab", () => {
    expect(escapeHtml(`&<>"'\`a\tb\nc\u0000\u0007\r\u007f\u009f‮`)).toBe("&amp;&lt;&gt;&quot;&#39;&#96;a\tb\nc");
  });
});

// ------------------------------------------------------------------ size cap

describe("diff size cap", () => {
  test("diffs past the cap are left out and the document says so", () => {
    const name = "hints-test-edits";
    const a = createAnalyzer({ detail: true, sessionId: name, file: `${name}.jsonl` });
    for (const l of readFileSync(join(sessionsDir, `${name}.jsonl`), "utf8").split("\n").filter((x) => x !== "")) a.push(l);
    const analysis = a.finish();
    const all = buildExportInput(analysis, a, { diffs: true });
    expect(all.capped).toBe(false);
    const few = buildExportInput(analysis, a, { diffs: true, capChars: 300 });
    expect(few.capped).toBe(true);
    const count = (m: Map<number, FileDiff[]>) => [...m.values()].reduce((n, l) => n + l.length, 0);
    expect(count(few.input.diffs)).toBeLessThan(count(all.input.diffs));
    const html = renderExport(few.input, { ...BASE, diffsCapped: true }).html;
    expect(html).toContain("Diffs omitted (size cap)");
    const none = buildExportInput(analysis, a, { diffs: false });
    expect(count(none.input.diffs)).toBe(0);
  });
});

// ------------------------------------------------------------------ contrast

describe("export stylesheet contrast", () => {
  const vars = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]));
  const light = vars(/:root\s*\{([^}]*)\}/.exec(EXPORT_CSS)![1]!);
  const darkOnly = vars(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(EXPORT_CSS)![1]!);
  const dark = { ...light, ...darkOnly };
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const pairs: [string, string, number][] = [
    ["text", "bg", 4.5], ["text", "surface", 4.5], ["muted", "bg", 4.5], ["muted", "surface", 4.5], ["link", "bg", 4.5], ["error", "bg", 4.5], ["error", "surface", 4.5],
    ["focus", "bg", 3], ["marker-text", "marker-bg", 4.5], ["pass", "bg", 4.5], ["pass", "surface", 4.5],
    ["dot-checked", "bg", 3], ["dot-unchecked", "bg", 3], ["dot-failing", "bg", 3], ["dot-no-changes", "bg", 3],
    ["badge-read", "bg", 4.5], ["badge-write", "bg", 4.5], ["badge-check", "bg", 4.5], ["badge-fix", "bg", 4.5],
    ["text", "add-bg", 4.5], ["text", "del-bg", 4.5], ["muted", "hunk-bg", 4.5], ["add-fg", "add-bg", 4.5], ["del-fg", "del-bg", 4.5],
    ["hint-text", "hint-bg", 4.5], ["sev-high", "bg", 4.5], ["sev-warn", "bg", 4.5], ["sev-info", "bg", 4.5],
    ["sev-high", "surface", 4.5], ["sev-warn", "surface", 4.5], ["sev-info", "surface", 4.5],
    ["rec-all", "bg", 4.5], ["rec-flagged", "bg", 4.5], ["rec-skim", "bg", 4.5],
    ["seg-read", "surface", 3], ["seg-write", "surface", 3], ["seg-check", "surface", 3], ["seg-fix", "surface", 3],
  ];
  describe.each([["light", light], ["dark", dark]] as const)("%s theme", (_n, theme) => {
    test.each(pairs)("%s on %s >= %f", (fg, bg, min) => {
      expect(theme[fg], fg).toBeDefined();
      expect(theme[bg], bg).toBeDefined();
      expect(contrast(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(min);
    });
  });
  test("dark theme overrides every token and printing stays light", () => {
    expect(Object.keys(darkOnly).sort()).toEqual(Object.keys(light).sort());
    expect(EXPORT_CSS).toContain("@media screen and (prefers-color-scheme: dark)");
    expect(EXPORT_CSS).toContain("@media print");
  });
});
