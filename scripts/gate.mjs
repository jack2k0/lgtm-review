#!/usr/bin/env node
// Deterministic pre-merge gate: mechanical checks on a branch plus a risk tier, printed as a short evidence block.
//
//   node scripts/gate.mjs [--base main] [--head <ref>] [--plan <plan.md>] [--run-check] [--merge [--findings <findings.md>]]
//   With --merge the worktree must be clean (everything committed), since the merge takes only commits.
//   node scripts/gate.mjs --tiers        (print the tier table; REVIEW.md points here)
//
// Run from a worktree. Without --head the working tree is compared (committed + uncommitted + untracked).
// Exit 0 = pass, 1 = hard fail, 2 = pass but needs a human look. Git is only called read-only with fixed args (no shell).
//
// A plan may carry a fenced block (language `gate`); keys: allow (regex, repeatable), goldens (regex),
// labels (new-only | none), deps (yes | no), schema (yes | no):
//   ```gate
//   allow: ^packages/core/src/(check-patterns|scope)(\.test)?\.ts$
//   goldens: scoped-checks\.
//   ```
//
// --merge adds the pre-merge review check (REVIEW.md): Low needs no reviewer, Medium one, High two. The ledger is
// --findings, default <plan dir>/reviews/findings.md, with a `reviewers: a, b` line and a Markdown table whose
// Verdict column is fixed | rejected | deferred for every row. A missing ledger, too few reviewers or an
// unanswered finding is a hard fail.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Risk tier table. First match wins, High before Low before Medium; no match = Medium. Edit here only. */
export const TIERS = {
  High: [
    /^packages\/core\/src\/(analyze|check-patterns|shell-edits|parse|subagents|redact|schema|inherit|hints|scope)\.ts$/,
    /^packages\/cli\/src\/(server|security|export|export-html|summary|api)\.ts$/,
    /^packages\/core\/src\/node\/(git|archive|read|subagents)\.ts$/,
    /^packages\/web\/src\/token\.ts$/,
    /\.labels\.json$/,
    /^\.github\//,
    /(^|\/)package\.json$/,
    /^pnpm-lock\.yaml$/,
    /^scripts\/(smoke-pack|build-demo|gate)\.mjs$/,
    /^(REVIEW|AGENTS|CLAUDE)\.md$/,
  ],
  Low: [/\.md$/, /^context\//, /^docs\//, /\.test\.tsx?$/, /(^|\/)__golden__\//],
  Medium: [/^packages\/[^/]+\/src\//, /^scripts\//],
};
const RANK = { Low: 0, Medium: 1, High: 2 };
/** Distinct pre-merge reviewers required per tier (REVIEW.md). */
export const REVIEWERS = { Low: 0, Medium: 1, High: 2 };
const VERDICTS = ["fixed", "rejected", "deferred"];
const LIST_CAP = 15;
const LABELS_RE = /^packages\/core\/fixtures\/sessions\/[^/]+\.labels\.json$/;
const DEP_RE = /(^|\/)package\.json$|^pnpm-lock\.yaml$/;
const SCHEMA = "packages/core/src/schema.ts";
const EXPECT_RE = /expect\(|assert| it\(|test\(|^\s*\[/;

export function tierOf(file) {
  for (const t of ["High", "Low", "Medium"]) if (TIERS[t].some((re) => re.test(file))) return t;
  return "Medium";
}

/** Parse the first fenced `gate` block of a plan; null when there is none. */
export function parseGateBlock(text) {
  const m = /^```gate[ \t]*\r?\n([\s\S]*?)^```/m.exec(text);
  if (!m) return null;
  const g = { allow: [], goldens: null, labels: "new-only", deps: "no", schema: "no" };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([a-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === "allow") g.allow.push(new RegExp(v));
    else if (k === "goldens") g.goldens = new RegExp(v);
    else if (k === "labels" || k === "deps" || k === "schema") g[k] = v;
  }
  return g;
}

/**
 * Cells of one markdown table row. A `|` inside a backtick code span, or escaped as `\|`, is not a separator.
 * One leading and one trailing separator pipe are the row border (rows may omit them).
 */
function splitCells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  const cuts = [];
  let inCode = false;
  let fence = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inCode) {
      if (ch !== "`") continue;
      let j = i;
      while (j < t.length && t[j] === "`") j++;
      if (j - i === fence) inCode = false;
      i = j - 1;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (j < t.length && t[j] === "`") j++;
      inCode = true;
      fence = j - i;
      i = j - 1;
      continue;
    }
    if (ch === "|") cuts.push(i);
  }
  if (cuts.length && cuts[cuts.length - 1] === t.length - 1) {
    cuts.pop();
    t = t.slice(0, -1);
  }
  const cells = [];
  let prev = 0;
  for (const c of cuts) {
    cells.push(t.slice(prev, c).trim());
    prev = c + 1;
  }
  cells.push(t.slice(prev).trim());
  return cells;
}

/**
 * Parse a findings ledger: reviewer names, and one { line, verdict } per table row. Fails closed (verdict "" =
 * unanswered): a row in a table without a Verdict column, a header not followed by a separator row (so a row
 * after a blank line is not taken as a header). A `|` inside backticks or written as `\|` is not a separator.
 * A row with fewer cells than its header is malformed; a row with more cells is unanswered (verdict "").
 * Only a bare name or @handle counts as a reviewer (not `<a>`).
 */
export function parseLedger(text) {
  const rv = /^reviewers\s*:\s*(.*)$/im.exec(text);
  const names = (rv?.[1] ?? "").split(",").map((r) => r.trim().toLowerCase().replace(/^@/, ""));
  const reviewers = [...new Set(names.filter((r) => /^[a-z0-9][\w.+-]*$/.test(r) && r !== "none"))];
  const rows = [];
  const SEP = (cells) => cells.every((c) => /^:?-+:?$/.test(c));
  const word = (cell) => {
    const cleaned = cell.toLowerCase().replace(/[*_`~]/g, "");
    return /^([a-z]+)(?=$|[\s(:,;])/.exec(cleaned)?.[1] ?? cleaned;
  };
  let head = null; // { line, cells, col, confirmed } of the current table; null = outside a table
  let fence = false;
  const endTable = () => {
    if (head && !head.confirmed) rows.push({ line: head.line, verdict: "" });
    head = null;
  };
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const t = line.trim();
    if (fence || !/(^|[^\\])\|/.test(t)) return endTable();
    const cells = splitCells(t);
    if (!head) return void (head = { line: i + 1, cells, col: cells.findIndex((c) => /^verdict\b/i.test(c)), confirmed: false });
    if (!head.confirmed) {
      if (SEP(cells)) return void (head.confirmed = true);
      rows.push({ line: head.line, verdict: "" });
      head.confirmed = true;
      head.col = -1;
    }
    if (SEP(cells)) return;
    // A short row is malformed; a long row (an unescaped pipe somewhere) is unanswered: reading by position could
    // take Evidence text as the verdict (fail open).
    if (head.col >= 0 && cells.length < head.cells.length) return void rows.push({ line: i + 1, verdict: "", malformed: true });
    const cell = head.col < 0 || cells.length !== head.cells.length ? "" : cells[head.col];
    rows.push({ line: i + 1, verdict: word(cell) });
  });
  endTable();
  return { reviewers, rows, none: /^findings\s*:\s*none\s*$/im.test(text) };
}

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

const EACH_CALL_RE = /\b(test|it|describe)(?:\s*\.\s*[a-zA-Z0-9_$]+)*\s*\.\s*each(?:\s*<[^;{}()]*>)?\s*$/;
const EACH_TAGGED_RE = /\b(test|it|describe)(?:\s*\.\s*[a-zA-Z0-9_$]+)*\s*\.\s*each\s*$/;
const TEST_BLOCK_RE = /(?:^|[^\w$.])(?:test|it)(?:\s*\.\s*(?:only|skip|concurrent|todo))?\s*$/;

function peekNextNonWs(content, idx) {
  let p = idx;
  const len = content.length;
  while (p < len) {
    const c = content[p];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      p++;
      continue;
    }
    if (c === "/" && content[p + 1] === "/") {
      p += 2;
      while (p < len && content[p] !== "\n") p++;
      continue;
    }
    if (c === "/" && content[p + 1] === "*") {
      p += 2;
      while (p < len && !(content[p] === "*" && content[p + 1] === "/")) p++;
      p += 2;
      continue;
    }
    return { char: c, pos: p };
  }
  return { char: null, pos: p };
}

function skipEscape(content, pos, curLine) {
  if (content[pos] === "\\") {
    if (content[pos + 1] === "\r" && content[pos + 2] === "\n") {
      return { pos: pos + 3, curLine: curLine + 1 };
    }
    if (content[pos + 1] === "\n" || content[pos + 1] === "\r") {
      return { pos: pos + 2, curLine: curLine + 1 };
    }
    return { pos: pos + 2, curLine };
  }
  return { pos: pos + 1, curLine };
}

function extractStringAt(content, pos) {
  const quote = content[pos];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  let p = pos + 1;
  const len = content.length;
  let s = "";
  while (p < len) {
    if (content[p] === "\\") {
      s += content[p + 1];
      p += 2;
      continue;
    }
    if (content[p] === quote) {
      return { text: s, endPos: p + 1 };
    }
    s += content[p];
    p++;
  }
  return null;
}

function resolveArrayVar(content, varName) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${varName}\\b`, "g");
  let m;
  while ((m = re.exec(content)) !== null) {
    let pos = m.index + m[0].length;
    while (pos < content.length && /\s/.test(content[pos])) pos++;
    if (content[pos] === ":") {
      pos++;
      let depthParen = 0, depthBracket = 0, depthAngle = 0, depthBrace = 0;
      while (pos < content.length) {
        const c = content[pos];
        if (c === "(") depthParen++;
        else if (c === ")") depthParen--;
        else if (c === "[") depthBracket++;
        else if (c === "]") depthBracket--;
        else if (c === "<") depthAngle++;
        else if (c === ">" && depthAngle > 0) depthAngle--;
        else if (c === "{") depthBrace++;
        else if (c === "}") depthBrace--;
        else if (c === "=" && content[pos + 1] !== ">" && depthParen === 0 && depthBracket === 0 && depthAngle === 0 && depthBrace === 0) {
          pos++;
          break;
        }
        pos++;
      }
    } else if (content[pos] === "=") {
      pos++;
    } else {
      continue;
    }
    const peek = peekNextNonWs(content, pos);
    if (peek.char === "[") {
      let bracketPos = peek.pos + 1;
      let depth = 1;
      let line = 1;
      for (let i = 0; i < peek.pos; i++) if (content[i] === "\n") line++;
      const startLine = line;
      while (bracketPos < content.length && depth > 0) {
        const c = content[bracketPos];
        if (c === "\n") { line++; bracketPos++; continue; }
        if (c === "\\") {
          const esc = skipEscape(content, bracketPos, line);
          bracketPos = esc.pos;
          line = esc.curLine;
          continue;
        }
        if (c === "'" || c === '"' || c === "`") {
          const quote = c;
          bracketPos++;
          while (bracketPos < content.length && content[bracketPos] !== quote) {
            if (content[bracketPos] === "\\") {
              const esc = skipEscape(content, bracketPos, line);
              bracketPos = esc.pos;
              line = esc.curLine;
            } else {
              if (content[bracketPos] === "\n") line++;
              bracketPos++;
            }
          }
          if (bracketPos < content.length) bracketPos++;
          continue;
        }
        if (c === "/" && content[bracketPos + 1] === "/") {
          bracketPos += 2;
          while (bracketPos < content.length && content[bracketPos] !== "\n") bracketPos++;
          continue;
        }
        if (c === "/" && content[bracketPos + 1] === "*") {
          bracketPos += 2;
          while (bracketPos < content.length && !(content[bracketPos] === "*" && content[bracketPos + 1] === "/")) {
            if (content[bracketPos] === "\n") line++;
            bracketPos++;
          }
          bracketPos += 2;
          continue;
        }
        if (c === "[") depth++;
        else if (c === "]") depth--;
        bracketPos++;
      }
      if (depth === 0) {
        return { startLine, endLine: line };
      }
    }
  }
  return null;
}

/** Find line numbers (1-based) belonging to parameter tables of test.each / it.each / describe.each. */
export function findTableLines(content) {
  const lines = new Set();
  const units = new Map();
  let unsure = false;

  let pos = 0;
  const len = content.length;
  let curLine = 1;

  const bracketStack = [];
  const templateStack = [];
  let codeBuffer = "";
  let nextArrayIsTable = false;

  const titleCounts = new Map();
  function allocUnit(prefix, title) {
    const key = `${prefix}:${title}`;
    const idx = titleCounts.get(key) || 0;
    titleCounts.set(key, idx + 1);
    return `${key}#${idx}`;
  }

  while (pos < len) {
    const ch = content[pos];

    if (ch === "\n") {
      curLine++;
      pos++;
      continue;
    }

    // Inside template literal (not inside an expression ${...})
    if (templateStack.length > 0 && bracketStack.length === templateStack[templateStack.length - 1].braceDepth) {
      if (ch === "\\") {
        const esc = skipEscape(content, pos, curLine);
        pos = esc.pos;
        curLine = esc.curLine;
        continue;
      }
      if (ch === "`") {
        templateStack.pop();
        pos++;
        codeBuffer += "`";
        continue;
      }
      if (ch === "$" && content[pos + 1] === "{") {
        bracketStack.push({ char: "${", line: curLine });
        pos += 2;
        codeBuffer += "${";
        continue;
      }
      pos++;
      continue;
    }

    // Comments
    if (ch === "/" && content[pos + 1] === "/") {
      pos += 2;
      while (pos < len && content[pos] !== "\n") pos++;
      continue;
    }
    if (ch === "/" && content[pos + 1] === "*") {
      pos += 2;
      while (pos < len && !(content[pos] === "*" && content[pos + 1] === "/")) {
        if (content[pos] === "\n") curLine++;
        pos++;
      }
      if (pos >= len) {
        unsure = true;
        break;
      }
      pos += 2;
      continue;
    }

    // Strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      pos++;
      while (pos < len && content[pos] !== quote) {
        if (content[pos] === "\\") {
          const esc = skipEscape(content, pos, curLine);
          pos = esc.pos;
          curLine = esc.curLine;
        } else {
          if (content[pos] === "\n") curLine++;
          pos++;
        }
      }
      if (pos >= len) {
        unsure = true;
        break;
      }
      pos++;
      codeBuffer += quote + quote;
      continue;
    }

    // Tagged template or normal template literal
    if (ch === "`") {
      if (EACH_TAGGED_RE.test(codeBuffer)) {
        const tableStartLine = curLine;
        pos++;
        let tmplDepth = 0;
        let closed = false;
        while (pos < len) {
          if (content[pos] === "\n") curLine++;
          if (content[pos] === "\\") {
            const esc = skipEscape(content, pos, curLine);
            pos = esc.pos;
            curLine = esc.curLine;
            continue;
          }
          if (content[pos] === "`" && tmplDepth === 0) {
            closed = true;
            pos++;
            break;
          }
          if (content[pos] === "$" && content[pos + 1] === "{") {
            tmplDepth++;
            pos += 2;
            continue;
          }
          if (content[pos] === "}" && tmplDepth > 0) {
            tmplDepth--;
            pos++;
            continue;
          }
          pos++;
        }
        if (!closed) {
          unsure = true;
          break;
        }
        const peek = peekNextNonWs(content, pos);
        let title = "tagged";
        if (peek.char === "(") {
          const inner = peekNextNonWs(content, peek.pos + 1);
          const str = extractStringAt(content, inner.pos);
          if (str) title = str.text;
        }
        const unitName = allocUnit("table", title);
        for (let l = tableStartLine; l <= curLine; l++) {
          lines.add(l);
          units.set(l, unitName);
        }
        codeBuffer += "`";
        continue;
      }

      templateStack.push({ braceDepth: bracketStack.length, line: curLine });
      pos++;
      codeBuffer += "`";
      continue;
    }

    // Regex literal check: if / follows operator/punctuation (and not /> or /=)
    if (ch === "/" && content[pos + 1] !== ">" && content[pos + 1] !== "=") {
      const trimmed = codeBuffer.trim();
      const last = trimmed[trimmed.length - 1];
      const isRegex = !last || /[([{},;=:!?&|+*^%~<>-]/.test(last) || /(?:return|typeof|throw|yield|await|case|delete|void)$/.test(trimmed);
      if (isRegex) {
        pos++;
        let inClass = false;
        let closed = false;
        while (pos < len) {
          if (content[pos] === "\\") {
            const esc = skipEscape(content, pos, curLine);
            pos = esc.pos;
            curLine = esc.curLine;
            continue;
          }
          if (content[pos] === "\n") break;
          if (content[pos] === "[" && !inClass) inClass = true;
          else if (content[pos] === "]" && inClass) inClass = false;
          else if (content[pos] === "/" && !inClass) {
            closed = true;
            pos++;
            break;
          }
          pos++;
        }
        if (closed) {
          codeBuffer += "/r/";
          continue;
        }
      }
    }

    // Brackets
    if (ch === "(" || ch === "[" || ch === "{") {
      if (ch === "(") {
        if (EACH_CALL_RE.test(codeBuffer)) {
          const next = peekNextNonWs(content, pos + 1);
          if (next.char === "[") {
            nextArrayIsTable = true;
          } else {
            // F1: Check if it is an identifier or anything else
            const idMatch = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(content.slice(next.pos));
            if (idMatch) {
              const varName = idMatch[0];
              const afterId = content.slice(next.pos + varName.length);
              const isValidArg = /^\s*(?:as\s+const\s*)?\)/.test(afterId);
              if (isValidArg) {
                const resolved = resolveArrayVar(content, varName);
                if (resolved) {
                  const closeParenIdx = content.indexOf(")", next.pos + varName.length);
                  let title = varName;
                  if (closeParenIdx !== -1) {
                    const peekTitle = peekNextNonWs(content, closeParenIdx + 1);
                    if (peekTitle.char === "(") {
                      const inner = peekNextNonWs(content, peekTitle.pos + 1);
                      const str = extractStringAt(content, inner.pos);
                      if (str) title = str.text;
                    }
                  }
                  const unitName = allocUnit("table", title);
                  for (let l = resolved.startLine; l <= resolved.endLine; l++) {
                    lines.add(l);
                    units.set(l, unitName);
                  }
                } else {
                  unsure = true;
                }
              } else {
                unsure = true;
              }
            } else {
              unsure = true;
            }
          }
          bracketStack.push({ char: "(", line: curLine });
        } else if (TEST_BLOCK_RE.test(codeBuffer)) {
          const next = peekNextNonWs(content, pos + 1);
          const str = extractStringAt(content, next.pos);
          const title = str ? str.text : "anon";
          bracketStack.push({ char: "(", line: curLine, isTest: true, title });
        } else {
          bracketStack.push({ char: "(", line: curLine });
        }
      } else if (ch === "[") {
        const isTable = nextArrayIsTable;
        nextArrayIsTable = false;
        bracketStack.push({ char: "[", line: curLine, isTable, startLine: curLine });
      } else {
        bracketStack.push({ char: "{", line: curLine });
      }
      codeBuffer += ch;
      pos++;
      continue;
    }

    if (ch === ")" || ch === "]" || ch === "}") {
      const expected = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      if (bracketStack.length === 0) {
        unsure = true;
      } else {
        const top = bracketStack.pop();
        if (ch === "}" && top.char === "${") {
          // Exited template expression
        } else if (top.char !== expected) {
          unsure = true;
        } else if (ch === "]" && top.isTable) {
          const peek = peekNextNonWs(content, pos + 1);
          let title = "table";
          if (peek.char === "(") {
            const inner = peekNextNonWs(content, peek.pos + 1);
            const str = extractStringAt(content, inner.pos);
            if (str) title = str.text;
          }
          const unitName = allocUnit("table", title);
          for (let l = top.startLine; l <= curLine; l++) {
            lines.add(l);
            units.set(l, unitName);
          }
        } else if (ch === ")" && top.isTest) {
          const unitName = allocUnit("test", top.title);
          for (let l = top.line; l <= curLine; l++) {
            if (!units.has(l)) {
              units.set(l, unitName);
            }
          }
        }
      }
      codeBuffer += ch;
      pos++;
      continue;
    }

    codeBuffer += ch;
    pos++;
  }

  if (bracketStack.length > 0 || templateStack.length > 0) {
    unsure = true;
  }

  return { lines, units, unsure };
}

function applyDiff(oldText, hunks) {
  const lines = oldText.split("\n");
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const h of sorted) {
    const idx = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    lines.splice(idx, h.oldCount, ...h.added);
  }
  return lines.join("\n");
}

/** Removed lines of test files as "file:oldLine: text" (old-side line numbers). */
export function removedLines(diff, getOldFile) {
  const out = [];

  const fileSections = [];
  const rawLines = diff.split("\n");
  let curSection = null;
  let inHunk = false;

  for (const line of rawLines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      curSection = { file: null, hunks: [] };
      fileSections.push(curSection);
      continue;
    }
    if (!curSection) {
      if (line.startsWith("--- a/")) {
        curSection = { file: line.slice(6), hunks: [] };
        fileSections.push(curSection);
        inHunk = false;
        continue;
      }
      if (line.startsWith("--- /dev/null")) {
        curSection = { file: null, hunks: [] };
        fileSections.push(curSection);
        inHunk = false;
        continue;
      }
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("--- a/")) {
        curSection.file = line.slice(6);
        continue;
      }
      if (line.startsWith("--- /dev/null")) {
        curSection.file = null;
        continue;
      }
      if (line.startsWith("@@")) {
        inHunk = true;
      }
    }
    if (inHunk) {
      if (line.startsWith("@@")) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (m) {
          const oldStart = Number(m[1]);
          const oldCount = m[2] !== undefined ? Number(m[2]) : 1;
          const newStart = Number(m[3]);
          const newCount = m[4] !== undefined ? Number(m[4]) : 1;
          curSection.hunks.push({ oldStart, oldCount, newStart, newCount, lines: [], added: [] });
          continue;
        }
      }
      if (curSection.hunks.length > 0) {
        const curHunk = curSection.hunks[curSection.hunks.length - 1];
        curHunk.lines.push(line);
        if (line.startsWith("+")) {
          curHunk.added.push(line.slice(1));
        }
      }
    }
  }

  for (const sec of fileSections) {
    if (!sec.file) continue;
    const file = sec.file;

    let oldContent = null;
    let unsure = false;
    if (getOldFile) {
      try {
        oldContent = getOldFile(file);
        if (oldContent == null) unsure = true;
      } catch {
        unsure = true;
      }
    } else {
      unsure = true;
    }

    let tableLines = new Set();
    let oldUnits = new Map();
    if (!unsure && oldContent != null) {
      const res = findTableLines(oldContent);
      tableLines = res.lines;
      oldUnits = res.units;
      if (res.unsure) unsure = true;
    }

    let newUnits = new Map();
    if (!unsure && oldContent != null) {
      try {
        const newContent = applyDiff(oldContent, sec.hunks);
        const newRes = findTableLines(newContent);
        newUnits = newRes.units;
      } catch {
        // diff apply error: newUnits stays empty
      }
    }

    // First pass: collect added lines per enclosing unit (F2 multiset)
    const unitAddedCounts = new Map();
    for (const h of sec.hunks) {
      let curNew = h.newStart;
      for (const line of h.lines) {
        if (line.startsWith("+")) {
          const newLine = curNew++;
          const t = line.slice(1).trim();
          if (t !== "") {
            const unit = newUnits.get(newLine);
            if (unit) {
              const k = `${unit}\0${t}`;
              unitAddedCounts.set(k, (unitAddedCounts.get(k) || 0) + 1);
            }
          }
        } else if (line.startsWith(" ")) {
          curNew++;
        }
      }
    }

    // Second pass: scan removed lines in each hunk
    for (const h of sec.hunks) {
      let curOld = h.oldStart;
      for (const line of h.lines) {
        if (line.startsWith("-")) {
          const oldLine = curOld++;
          const raw = line.slice(1);
          const t = raw.trim();
          if (t === "") continue;

          // E3 move check (F2: only within same enclosing unit)
          const oldUnit = oldUnits.get(oldLine);
          if (oldUnit) {
            const k = `${oldUnit}\0${t}`;
            if ((unitAddedCounts.get(k) || 0) > 0) {
              unitAddedCounts.set(k, unitAddedCounts.get(k) - 1);
              continue; // excused move!
            }
          }

          // F5: restore reporting a removed // expect(...) line
          if (EXPECT_RE.test(raw)) {
            out.push(`${file}:${oldLine}: ${t.slice(0, 80)}`);
            continue;
          }

          // In detected table: F3 never skips comments in table
          if (!unsure && tableLines.has(oldLine)) {
            out.push(`${file}:${oldLine}: ${t.slice(0, 80)}`);
            continue;
          }

          // E2 fail closed path: F3 comment skip applies only on E2 path
          if (unsure) {
            if (/^\s*(?:\/\/|\/\*|\*)/.test(raw)) continue;
            out.push(`${file}:${oldLine}: ${t.slice(0, 80)}`);
            continue;
          }
        } else if (line.startsWith(" ")) {
          curOld++;
        }
      }
    }
  }

  return out;
}

function parseStatus(text) {
  return text.split("\n").filter(Boolean).map((l) => {
    const [s, ...p] = l.split("\t");
    return { status: s[0], path: p.join("\t") };
  });
}

function short(sha) {
  return sha.slice(0, 10);
}

export function run(argv, env = process.env, out = (s) => process.stdout.write(s)) {
  const { values } = parseArgs({ args: argv, options: { base: { type: "string", default: "main" }, head: { type: "string" }, plan: { type: "string" }, "run-check": { type: "boolean", default: false }, merge: { type: "boolean", default: false }, findings: { type: "string" }, tiers: { type: "boolean", default: false } } });
  if (values.tiers) {
    const lines = ["tier   reviewers  paths (first match wins: High, Low, Medium; no match = Medium)"];
    for (const t of ["High", "Low", "Medium"]) for (const re of TIERS[t]) lines.push(`${t.padEnd(7)}${String(REVIEWERS[t]).padEnd(11)}${re.source}`);
    out(`${lines.join("\n")}\n`);
    return 0;
  }
  const head = values.head ?? "HEAD";
  const baseSha = git(["rev-parse", "--verify", `${values.base}^{commit}`]).trim();
  const headSha = git(["rev-parse", "--verify", `${head}^{commit}`]).trim();
  const mb = git(["merge-base", headSha, baseSha]).trim();
  const gate = values.plan ? parseGateBlock(readFileSync(values.plan, "utf8")) : null;

  // Files changed since the merge-base. Renames are split into delete + add so a moved file counts on both sides.
  const target = values.head ? [mb, headSha] : [mb];
  const files = parseStatus(git(["diff", "--name-status", "--no-renames", ...target]));
  if (!values.head) {
    for (const p of git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) files.push({ status: "A", path: p });
  }
  const paths = files.map((f) => f.path);

  const results = []; // { name, verdict: PASS|FAIL|EYES|SKIP, reason, items }
  const add = (name, verdict, reason, items = []) => results.push({ name, verdict, reason, items });
  const bad = (name, list, reason, verdict = "FAIL") => (list.length ? add(name, verdict, `${list.length} ${reason}`, list) : null);

  // 0. Committed: a merge takes the branch commits, so with --merge the worktree must hold nothing uncommitted.
  if (values.merge && !values.head) {
    const dirty = git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]).split("\n").filter(Boolean).map((l) => l.slice(3));
    if (!bad("committed", dirty, "uncommitted or untracked file(s); a merge would leave them out")) add("committed", "PASS", "worktree clean");
  }

  // 1. Up to date
  if (mb === baseSha) add("up-to-date", "PASS", `merge-base is ${values.base} head`);
  else add("up-to-date", "EYES", `merge ${values.base} first (merge-base ${short(mb)} != ${short(baseSha)})`);

  // 2. Scope
  if (!gate || gate.allow.length === 0) add("scope", "SKIP", values.plan ? "no gate block with allow in the plan" : "no --plan given");
  else {
    const out = paths.filter((p) => !gate.allow.some((re) => re.test(p)));
    if (!bad("scope", out, "file(s) outside the allowlist")) add("scope", "PASS", "all files match allow");
  }

  // 3. Ground truth
  const labels = files.filter((f) => LABELS_RE.test(f.path));
  const touched = labels.filter((f) => f.status !== "A").map((f) => `${f.status} ${f.path}`);
  const added = labels.filter((f) => f.status === "A").map((f) => `A ${f.path}`);
  const labelsMode = gate?.labels ?? "new-only";
  if (touched.length) add("ground-truth", "FAIL", `${touched.length} existing label file(s) modified/deleted (a label change means the rule is wrong)`, touched);
  else if (added.length && labelsMode !== "new-only") add("ground-truth", "FAIL", `${added.length} new label file(s) but labels: ${labelsMode}`, added);
  else add("ground-truth", "PASS", added.length ? `${added.length} new label file(s) only` : "no label changes", added);

  // 4. Goldens
  const goldens = paths.filter((p) => /(^|\/)__golden__\//.test(p));
  if (!goldens.length) add("goldens", "PASS", "no golden changes");
  else if (!gate) add("goldens", "EYES", `${goldens.length} golden file(s) changed, no gate block`, goldens);
  else {
    const out = goldens.filter((p) => !(gate.goldens && gate.goldens.test(p)));
    if (!bad("goldens", out, "golden file(s) outside the goldens pattern")) add("goldens", "PASS", `${goldens.length} golden file(s), all match goldens`, goldens);
  }

  // 5. Removed expectations
  const testPaths = paths.filter((p) => /\.test\.tsx?$/.test(p));
  const removed = testPaths.length
    ? removedLines(
        git(["diff", "-U0", "--no-renames", ...target, "--", "*.test.ts", "*.test.tsx"]),
        (p) => {
          try {
            return git(["show", `${mb}:${p}`]);
          } catch {
            return null;
          }
        }
      )
    : [];
  if (!bad("removed-expectations", removed, "removed test line(s) with expectations", "EYES")) add("removed-expectations", "PASS", "none removed");

  // 6. Dependencies
  const deps = paths.filter((p) => DEP_RE.test(p));
  const depsMode = gate?.deps ?? "no";
  let forceHigh = false;
  if (!deps.length) add("dependencies", "PASS", "no manifest/lockfile changes");
  else if (depsMode === "yes") {
    forceHigh = true;
    add("dependencies", "EYES", `${deps.length} manifest/lockfile change(s) allowed by plan (tier High)`, deps);
  } else add("dependencies", "FAIL", `${deps.length} manifest/lockfile change(s) but deps: ${depsMode}`, deps);

  // 7. Schema
  if (!paths.includes(SCHEMA)) add("schema", "PASS", "schema.ts unchanged");
  else if (gate?.schema === "yes") add("schema", "PASS", "schema.ts changed, allowed by plan");
  else add("schema", "FAIL", "schema.ts changed without schema: yes", [SCHEMA]);

  // 8. Check
  let tail = null;
  if (values["run-check"]) {
    const cmd = env.GATE_CHECK_CMD;
    const r = cmd ? spawnSync(cmd, { shell: true, encoding: "utf8", env }) : spawnSync("pnpm", ["check"], { encoding: "utf8", env });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n");
    tail = text.slice(-5);
    add("check", r.status === 0 ? "PASS" : "FAIL", r.status === 0 ? "check exited 0" : `check exited ${r.status ?? r.signal ?? "with an error"}`);
  } else add("check", "SKIP", "not run (no --run-check)");

  // 9. Tier
  let tier = "Low";
  for (const p of paths) if (RANK[tierOf(p)] > RANK[tier]) tier = tierOf(p);
  if (forceHigh) tier = "High";

  // 10. Pre-merge review (only with --merge; workers run the gate before review exists)
  const need = REVIEWERS[tier];
  const ledgerPath = values.findings ?? (values.plan ? join(dirname(values.plan), "reviews", "findings.md") : null);
  if (!values.merge) add("review", "SKIP", "not checked (no --merge)");
  else if (need === 0) add("review", "PASS", "tier Low: no reviewer required");
  else if (!ledgerPath || !existsSync(ledgerPath)) add("review", "FAIL", `tier ${tier} needs ${need} reviewer(s); no findings ledger${ledgerPath ? ` at ${ledgerPath}` : " (--findings or --plan)"}`);
  else {
    const { reviewers, rows, none } = parseLedger(readFileSync(ledgerPath, "utf8"));
    const malformed = rows.filter((r) => r.malformed).map((r) => `${ledgerPath}:${r.line}: malformed`);
    const open = rows.filter((r) => !r.malformed && !VERDICTS.includes(r.verdict)).map((r) => `${ledgerPath}:${r.line}: verdict "${r.verdict}"`);
    const tally = VERDICTS.map((v) => `${rows.filter((r) => r.verdict === v).length} ${v}`).join(", ");
    if (reviewers.length < need) add("review", "FAIL", `tier ${tier} needs ${need} reviewer(s), ledger names ${reviewers.length}`);
    else if (rows.length === 0 && !none) add("review", "FAIL", "no findings table rows; write `findings: none` when the reviewers found nothing");
    else if (rows.length > 0 && none) add("review", "FAIL", `\`findings: none\` but ${rows.length} finding row(s)`);
    else if (!bad("review", malformed, "malformed ledger row(s)") && !bad("review", open, "unanswered finding(s) (verdict must be fixed | rejected | deferred)")) add("review", "PASS", `${reviewers.join(" + ")}; ${rows.length} finding(s): ${tally}`);
  }

  const lines = ["## Merge gate", `base ${values.base} ${short(baseSha)} / head ${values.head ?? "worktree"} ${short(headSha)}`, `changed files: ${paths.length}`, `tier: ${tier}`];
  for (const r of results) {
    lines.push(`- ${r.verdict} ${r.name}: ${r.reason}`);
    for (const it of r.items.slice(0, LIST_CAP)) lines.push(`    ${it}`);
    if (r.items.length > LIST_CAP) lines.push(`    … ${r.items.length - LIST_CAP} more`);
  }
  if (tail) lines.push("check output (last 5 lines):", "```", ...tail, "```");
  const code = results.some((r) => r.verdict === "FAIL") ? 1 : results.some((r) => r.verdict === "EYES") ? 2 : 0;
  if (values.merge && tier === "High") lines.push("owner: read this block before push (tier High)");
  lines.push(`result: ${["PASS", "FAIL", "NEEDS-EYES"][code]} (exit ${code})`);
  out(`${lines.join("\n")}\n`);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`gate: ${e instanceof Error ? e.message.split("\n")[0] : e}\n`);
    process.exitCode = 1;
  }
}
