export type TokenKind = "plain" | "keyword" | "string" | "number" | "comment";

export interface Token {
  kind: TokenKind;
  text: string;
}

export type Language = "ts" | "py" | "json" | "plain";

const TS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const PY_EXTENSIONS = new Set(["py", "pyi", "pyw"]);
const JSON_EXTENSIONS = new Set(["json"]);

export function detectLanguage(path: string): Language {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "plain";
  const ext = path.slice(dot + 1).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) return "ts";
  if (PY_EXTENSIONS.has(ext)) return "py";
  if (JSON_EXTENSIONS.has(ext)) return "json";
  return "plain";
}

const TS_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "from", "function", "get", "if", "implements", "import",
  "in", "instanceof", "interface", "is", "let", "new", "null", "of", "package",
  "private", "protected", "public", "readonly", "return", "set", "static", "super",
  "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var",
  "void", "while", "with", "yield",
]);

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally", "for",
  "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
  "pass", "raise", "return", "try", "while", "with", "yield",
]);

const JSON_KEYWORDS = new Set(["false", "null", "true"]);

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

function pushToken(tokens: Token[], kind: TokenKind, text: string): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    tokens.push({ kind, text });
  }
}

function tokenizeTs(line: string): Token[] {
  const tokens: Token[] = [];
  const len = line.length;
  let i = 0;

  while (i < len) {
    const c = line[i]!;

    // Comments
    if (c === "/" && i + 1 < len) {
      const next = line[i + 1];
      if (next === "/") {
        pushToken(tokens, "comment", line.slice(i));
        break;
      }
      if (next === "*") {
        const end = line.indexOf("*/", i + 2);
        const chunk = end === -1 ? line.slice(i) : line.slice(i, end + 2);
        pushToken(tokens, "comment", chunk);
        i += chunk.length;
        continue;
      }
    }

    // Strings
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
        } else if (line[j] === c) {
          j++;
          break;
        } else {
          j++;
        }
      }
      pushToken(tokens, "string", line.slice(i, Math.min(j, len)));
      i = Math.min(j, len);
      continue;
    }

    // Numbers
    const prev = i > 0 ? line[i - 1] : " ";
    if (!isIdentPart(prev!) && ((c >= "0" && c <= "9") || (c === "." && i + 1 < len && line[i + 1]! >= "0" && line[i + 1]! <= "9"))) {
      let j = i;
      if (line[j] === "0" && j + 1 < len && (line[j + 1] === "x" || line[j + 1] === "X" || line[j + 1] === "b" || line[j + 1] === "B" || line[j + 1] === "o" || line[j + 1] === "O")) {
        j += 2;
        while (j < len && ((line[j]! >= "0" && line[j]! <= "9") || (line[j]! >= "a" && line[j]! <= "f") || (line[j]! >= "A" && line[j]! <= "F") || line[j] === "_")) j++;
      } else {
        while (j < len && ((line[j]! >= "0" && line[j]! <= "9") || line[j] === "." || line[j] === "_")) j++;
        if (j < len && (line[j] === "e" || line[j] === "E")) {
          j++;
          if (j < len && (line[j] === "+" || line[j] === "-")) j++;
          while (j < len && (line[j]! >= "0" && line[j]! <= "9")) j++;
        }
      }
      pushToken(tokens, "number", line.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers & Keywords
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdentPart(line[j]!)) j++;
      const word = line.slice(i, j);
      if (TS_KEYWORDS.has(word)) {
        pushToken(tokens, "keyword", word);
      } else {
        pushToken(tokens, "plain", word);
      }
      i = j;
      continue;
    }

    // Operators, punctuation, whitespace
    pushToken(tokens, "plain", c);
    i++;
  }

  return tokens;
}

function tokenizePy(line: string): Token[] {
  const tokens: Token[] = [];
  const len = line.length;
  let i = 0;

  while (i < len) {
    const c = line[i]!;

    // Comment
    if (c === "#") {
      pushToken(tokens, "comment", line.slice(i));
      break;
    }

    // Triple-quoted strings
    if ((c === '"' || c === "'") && i + 2 < len && line[i + 1] === c && line[i + 2] === c) {
      const q = line.slice(i, i + 3);
      let j = i + 3;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
        } else if (line.slice(j, j + 3) === q) {
          j += 3;
          break;
        } else {
          j++;
        }
      }
      pushToken(tokens, "string", line.slice(i, Math.min(j, len)));
      i = Math.min(j, len);
      continue;
    }

    // Single/double quoted strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
        } else if (line[j] === c) {
          j++;
          break;
        } else {
          j++;
        }
      }
      pushToken(tokens, "string", line.slice(i, Math.min(j, len)));
      i = Math.min(j, len);
      continue;
    }

    // Numbers
    const prev = i > 0 ? line[i - 1] : " ";
    if (!isIdentPart(prev!) && ((c >= "0" && c <= "9") || (c === "." && i + 1 < len && line[i + 1]! >= "0" && line[i + 1]! <= "9"))) {
      let j = i;
      if (line[j] === "0" && j + 1 < len && (line[j + 1] === "x" || line[j + 1] === "X" || line[j + 1] === "b" || line[j + 1] === "B" || line[j + 1] === "o" || line[j + 1] === "O")) {
        j += 2;
        while (j < len && ((line[j]! >= "0" && line[j]! <= "9") || (line[j]! >= "a" && line[j]! <= "f") || (line[j]! >= "A" && line[j]! <= "F") || line[j] === "_")) j++;
      } else {
        while (j < len && ((line[j]! >= "0" && line[j]! <= "9") || line[j] === "." || line[j] === "_")) j++;
        if (j < len && (line[j] === "e" || line[j] === "E")) {
          j++;
          if (j < len && (line[j] === "+" || line[j] === "-")) j++;
          while (j < len && (line[j]! >= "0" && line[j]! <= "9")) j++;
        }
      }
      pushToken(tokens, "number", line.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers & Keywords
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdentPart(line[j]!)) j++;
      const word = line.slice(i, j);
      if (PY_KEYWORDS.has(word)) {
        pushToken(tokens, "keyword", word);
      } else {
        pushToken(tokens, "plain", word);
      }
      i = j;
      continue;
    }

    pushToken(tokens, "plain", c);
    i++;
  }

  return tokens;
}

function tokenizeJson(line: string): Token[] {
  const tokens: Token[] = [];
  const len = line.length;
  let i = 0;

  while (i < len) {
    const c = line[i]!;

    // Strings
    if (c === '"') {
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
        } else if (line[j] === '"') {
          j++;
          break;
        } else {
          j++;
        }
      }
      pushToken(tokens, "string", line.slice(i, Math.min(j, len)));
      i = Math.min(j, len);
      continue;
    }

    // Numbers: optional minus, digits, optional fraction, optional exponent
    const prev = i > 0 ? line[i - 1] : " ";
    if (!isIdentPart(prev!) && ((c >= "0" && c <= "9") || (c === "-" && i + 1 < len && line[i + 1]! >= "0" && line[i + 1]! <= "9"))) {
      let j = i;
      if (line[j] === "-") j++;
      while (j < len && (line[j]! >= "0" && line[j]! <= "9")) j++;
      if (j < len && line[j] === ".") {
        j++;
        while (j < len && (line[j]! >= "0" && line[j]! <= "9")) j++;
      }
      if (j < len && (line[j] === "e" || line[j] === "E")) {
        j++;
        if (j < len && (line[j] === "+" || line[j] === "-")) j++;
        while (j < len && (line[j]! >= "0" && line[j]! <= "9")) j++;
      }
      pushToken(tokens, "number", line.slice(i, j));
      i = j;
      continue;
    }

    // Literals: true, false, null
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdentPart(line[j]!)) j++;
      const word = line.slice(i, j);
      if (JSON_KEYWORDS.has(word)) {
        pushToken(tokens, "keyword", word);
      } else {
        pushToken(tokens, "plain", word);
      }
      i = j;
      continue;
    }

    pushToken(tokens, "plain", c);
    i++;
  }

  return tokens;
}

export function highlightLine(line: string, path: string): Token[] {
  if (line.length === 0) return [];
  if (line.length > 2000) return [{ kind: "plain", text: line }];

  const lang = detectLanguage(path);
  switch (lang) {
    case "ts":
      return tokenizeTs(line);
    case "py":
      return tokenizePy(line);
    case "json":
      return tokenizeJson(line);
    default:
      return [{ kind: "plain", text: line }];
  }
}
