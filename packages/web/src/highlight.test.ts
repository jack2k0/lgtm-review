import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { detectLanguage, highlightLine } from "./highlight";
import type { Token } from "./highlight";

describe("highlightLine tokenizer", () => {
  test("unknown extension returns plain text", () => {
    const line = "const x = 123; // comment";
    expect(detectLanguage("file.txt")).toBe("plain");
    expect(detectLanguage("Makefile")).toBe("plain");
    expect(detectLanguage("src/file.unknown")).toBe("plain");
    expect(highlightLine(line, "file.txt")).toEqual([{ kind: "plain", text: line }]);
  });

  test("lines over 2000 characters stay plain", () => {
    const longLine = "const x = " + "a".repeat(2005);
    const tokens = highlightLine(longLine, "app.ts");
    expect(tokens).toEqual([{ kind: "plain", text: longLine }]);
  });

  test("detects languages correctly", () => {
    expect(detectLanguage("src/app.ts")).toBe("ts");
    expect(detectLanguage("src/app.tsx")).toBe("ts");
    expect(detectLanguage("lib/index.js")).toBe("ts");
    expect(detectLanguage("lib/index.mjs")).toBe("ts");
    expect(detectLanguage("lib/index.cjs")).toBe("ts");
    expect(detectLanguage("main.py")).toBe("py");
    expect(detectLanguage("pkg/stub.pyi")).toBe("py");
    expect(detectLanguage("data/config.json")).toBe("json");
  });

  test("tokenizes TypeScript / JavaScript features", () => {
    const tokens = highlightLine("const value = 42; // answer", "script.ts");
    expect(tokens.map((t) => t.text).join("")).toBe("const value = 42; // answer");
    expect(tokens).toEqual([
      { kind: "keyword", text: "const" },
      { kind: "plain", text: " value = " },
      { kind: "number", text: "42" },
      { kind: "plain", text: "; " },
      { kind: "comment", text: "// answer" },
    ]);

    const strTokens = highlightLine("const s = 'hello \"world\"' + `template ${1}`;", "script.js");
    expect(strTokens.map((t) => t.text).join("")).toBe("const s = 'hello \"world\"' + `template ${1}`;");
    expect(strTokens.some((t) => t.kind === "string" && t.text === "'hello \"world\"'")).toBe(true);

    const blockComment = highlightLine("/* inline block */ return true;", "file.ts");
    expect(blockComment.map((t) => t.text).join("")).toBe("/* inline block */ return true;");
    expect(blockComment[0]).toEqual({ kind: "comment", text: "/* inline block */" });
    expect(blockComment.some((t) => t.kind === "keyword" && t.text === "return")).toBe(true);
    expect(blockComment.some((t) => t.kind === "keyword" && t.text === "true")).toBe(true);
  });

  test("tokenizes Python features", () => {
    const tokens = highlightLine("def compute(x=10): # helper", "code.py");
    expect(tokens.map((t) => t.text).join("")).toBe("def compute(x=10): # helper");
    expect(tokens).toEqual([
      { kind: "keyword", text: "def" },
      { kind: "plain", text: " compute(x=" },
      { kind: "number", text: "10" },
      { kind: "plain", text: "): " },
      { kind: "comment", text: "# helper" },
    ]);

    const tripleStr = highlightLine('msg = """multi line string""" + None', "code.py");
    expect(tripleStr.map((t) => t.text).join("")).toBe('msg = """multi line string""" + None');
    expect(tripleStr.some((t) => t.kind === "string" && t.text === '"""multi line string"""')).toBe(true);
    expect(tripleStr.some((t) => t.kind === "keyword" && t.text === "None")).toBe(true);
  });

  test("tokenizes JSON features", () => {
    const tokens = highlightLine('  "enabled": true, "count": -12.5, "extra": null', "package.json");
    expect(tokens.map((t) => t.text).join("")).toBe('  "enabled": true, "count": -12.5, "extra": null');
    expect(tokens.filter((t) => t.kind === "string").map((t) => t.text)).toEqual(['"enabled"', '"count"', '"extra"']);
    expect(tokens.filter((t) => t.kind === "keyword").map((t) => t.text)).toEqual(["true", "null"]);
    expect(tokens.filter((t) => t.kind === "number").map((t) => t.text)).toEqual(["-12.5"]);
  });

  test("round-trip property on odd input", () => {
    const oddInputs = [
      "",
      "    ",
      "//",
      "/*",
      "*/",
      '"""',
      "'''",
      '"unclosed string',
      "'unclosed single quote",
      "`unclosed template",
      "escaped backslash at end \\",
      "multiple \\\\ backslashes",
      "x.y.z",
      "0x123_456 0b1010 0o777 1e-10 3.14159",
      "<script>alert('xss')</script>",
      `function foo() { return "<img src=x onerror=boom()>"; }`,
      "123abc_not_a_number_prefix",
      "emoji 🚀 💥 and unicode: こんにちは",
    ];

    for (const ext of ["ts", "js", "py", "json", "unknown"]) {
      const path = `test.${ext}`;
      for (const input of oddInputs) {
        const tokens = highlightLine(input, path);
        const concatenated = tokens.map((t) => t.text).join("");
        expect(concatenated).toBe(input);
      }
    }
  });

  test("a log line holding <script> renders as text node, never markup", () => {
    const evilLine = `<script>alert("pwned")</script>`;
    const tokens = highlightLine(evilLine, "app.ts");
    expect(tokens.map((t) => t.text).join("")).toBe(evilLine);

    // Render with React to HTML string
    const element = React.createElement(
      "span",
      null,
      tokens.map((tok: Token, idx: number) =>
        tok.kind === "plain"
          ? tok.text
          : React.createElement("span", { key: idx, className: `tok-${tok.kind}` }, tok.text),
      ),
    );
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
