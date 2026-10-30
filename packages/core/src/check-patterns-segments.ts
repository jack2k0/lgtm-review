export interface Segment {
  text: string;
  /** Operator that follows this segment: "&&", "||", "|", ";", "&", "\n" or "" at the end. */
  op: string;
  /** Unquoted "(" in the raw segment: a subshell starts before its command. */
  opens: number;
  /** Unquoted ")" in the raw segment: a subshell closes after its command. */
  closes: number;
}

/** A heredoc start on one line: `dash` for `<<-`, `delim` after quote removal, `quoted` when any quoting char was present (literal body). */
export interface HeredocStart {
  delim: string;
  quoted: boolean;
  dash: boolean;
}

/** Whether `#` at index `i` begins an unescaped comment (preceded by start of input or unescaped whitespace / `;&|()`). */
function isUnescapedCommentStart(text: string, i: number): boolean {
  if (text[i] !== "#") return false;
  if (i === 0) return true;
  const prev = text[i - 1] as string;
  if (!/[\s;&|()]/.test(prev)) return false;
  let bs = 0;
  for (let j = i - 2; j >= 0 && text[j] === "\\"; j--) bs++;
  return bs % 2 === 0;
}

/** Scans forward from `start` for the closing `)` of depth 1, returning the index of the closing `)` of `))` if matched, or -1. */
export function scanParenPairEnd(input: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let j = start; j < input.length; j++) {
    const c = input[j] as string;
    if (quote !== null) {
      if (quote === "'") {
        if (c === "'") quote = null;
      } else if (quote === '"') {
        if (c === "\\" && j + 1 < input.length) j++;
        else if (c === '"') quote = null;
      } else if (quote === "$'") {
        if (c === "\\" && j + 1 < input.length) j++;
        else if (c === "'") quote = null;
      }
      continue;
    }
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "$" && j + 1 < input.length && input[j + 1] === "'") {
      quote = "$'";
      j++;
      continue;
    }
    // Backticks are not skipped: splitSegments does not track them either, so both stay in step.
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return j + 1 < input.length && input[j + 1] === ")" ? j + 1 : -1;
      }
    }
  }
  return -1;
}

/** Scans forward from `start` for the closing `]` of depth 1, returning the index of the `]`, or -1. */
export function scanBracketPairEnd(input: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let j = start; j < input.length; j++) {
    const c = input[j] as string;
    if (quote !== null) {
      if (quote === "'") {
        if (c === "'") quote = null;
      } else if (quote === '"') {
        if (c === "\\" && j + 1 < input.length) j++;
        else if (c === '"') quote = null;
      } else if (quote === "$'") {
        if (c === "\\" && j + 1 < input.length) j++;
        else if (c === "'") quote = null;
      }
      continue;
    }
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "$" && j + 1 < input.length && input[j + 1] === "'") {
      quote = "$'";
      j++;
      continue;
    }
    // Backticks are not skipped: splitSegments does not track them either, so both stay in step.
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Whether the command text preceding `((` is in command-start position (start of input, subshell/brace, or control keywords). */
export function isArithmeticCommandStart(cur: string): boolean {
  // `!` is not a word character, so it cannot take `\b`.
  return /^(?:[\s({!]|(?:if|then|else|elif|while|until|do|time)\b)*$/.test(cur);
}

/**
 * Checks whether index `pos` in `input` is an arithmetic opener:
 * - `$((`: arithmetic only if its inner level closes with `))`
 * - `$[`: arithmetic only if it closes with `]`
 * - `((`: command-start only, and only if its inner level closes with `))`
 * Returns the opener token if valid and closed; null if it falls back or is unclosed.
 */
export function checkArithmeticOpener(
  input: string,
  pos: number,
  isCommandStart: boolean,
): "$((" | "$[" | "((" | null {
  if (input.slice(pos, pos + 3) === "$((") {
    return scanParenPairEnd(input, pos + 3) >= 0 ? "$((" : null;
  }
  if (input.slice(pos, pos + 2) === "$[") {
    return scanBracketPairEnd(input, pos + 2) >= 0 ? "$[" : null;
  }
  if (isCommandStart && input.slice(pos, pos + 2) === "((") {
    return scanParenPairEnd(input, pos + 2) >= 0 ? "((" : null;
  }
  return null;
}

/** Whether the text before `index` (the position of `<<`) in `line` puts it in a quote, comment or arithmetic context (`$((..))`, `((..))`, `$[..]`). */
function inCommentOrArithmetic(line: string, index: number, lookahead = line): boolean {
  let quote: string | null = null;
  let cmdStart = 0;
  const stack: string[] = [];

  for (let i = 0; i < index; i++) {
    const c = line[i] as string;

    if (quote !== null) {
      if (quote === "'") {
        if (c === "'") quote = null;
      } else if (quote === '"') {
        if (c === "\\" && i + 1 < line.length) i++;
        else if (c === '"') quote = null;
      } else if (quote === "$'") {
        if (c === "\\" && i + 1 < line.length) i++;
        else if (c === "'") quote = null;
      }
      continue;
    }

    if (c === "\\") {
      if (i + 1 < line.length) i++;
      continue;
    }

    if (c === "$" && i + 1 < line.length && line[i + 1] === "'") {
      quote = "$'";
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }

    if (stack.length > 0) {
      if (c === "(") {
        stack.push("(");
      } else if (c === "[") {
        stack.push("[");
      } else if (c === ")") {
        const top = stack[stack.length - 1];
        if (top === "(") {
          stack.pop();
        } else if ((top === "$((" || top === "((") && i + 1 < line.length && line[i + 1] === ")") {
          stack.pop();
          i++;
        }
      } else if (c === "]") {
        const top = stack[stack.length - 1];
        if (top === "[" || top === "$[") {
          stack.pop();
        }
      }
      continue;
    }

    if (isUnescapedCommentStart(line, i)) {
      return true;
    }

    const isCommandStart = isArithmeticCommandStart(line.slice(cmdStart, i));
    const arith = checkArithmeticOpener(lookahead, i, isCommandStart);
    if (arith !== null) {
      stack.push(arith);
      i += arith.length - 1;
      continue;
    }

    if (/[;&|\n]/.test(c)) {
      cmdStart = i + 1;
    }
  }

  if (quote !== null) return true;
  if (stack.length > 0) return true;
  return false;
}

/**
 * Heredoc starts in a line, in order. The delimiter is the whole shell word up to an unquoted metacharacter
 * (space, tab, `;`, `&`, `|`, `<`, `>`, `(`, `)`), with quote removal: `E'-'1` is `E-1`.
 * An unterminated quote or an empty word is not a heredoc start.
 */
export function parseHeredocStarts(line: string, prefix = "", lookahead = prefix + line): HeredocStart[] {
  const starts: HeredocStart[] = [];
  const full = prefix + line;
  const re = /(?<!<)<<(-?)/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (line[m.index + 2] === "=") continue;
    let bs = 0;
    while (m.index - 1 - bs >= 0 && line[m.index - 1 - bs] === "\\") bs++;
    if (bs % 2 === 1) continue;
    if (inCommentOrArithmetic(full, prefix.length + m.index, lookahead)) continue;
    let i = m.index + m[0].length;
    while (i < line.length && /\s/.test(line[i] as string)) i++;
    let delim = "";
    let quoted = false;
    let ok = true;
    let any = false;
    while (i < line.length && ok) {
      const c = line[i] as string;
      if (/[\s;&|<>()]/.test(c)) break;
      any = true;
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) ok = false;
        else {
          delim += line.slice(i + 1, end);
          i = end + 1;
          quoted = true;
        }
      } else if (c === '"') {
        i++;
        let closed = false;
        while (i < line.length) {
          const d = line[i] as string;
          if (d === '"') {
            closed = true;
            i++;
            break;
          }
          if (d === "\\" && i + 1 < line.length && /[$`"\\]/.test(line[i + 1] as string)) i++;
          delim += line[i];
          i++;
        }
        if (!closed) ok = false;
        quoted = true;
      } else if (c === "\\") {
        if (i + 1 >= line.length) ok = false;
        else {
          delim += line[i + 1];
          i += 2;
          quoted = true;
        }
      } else if (c === "$" && line[i + 1] === '"') {
        // `$"E"`: the `$` is dropped and the rest is double-quoted.
        i++;
      } else if (c === "$" && line[i + 1] === "'") {
        i += 2;
        let closed = false;
        while (i < line.length) {
          const d = line[i] as string;
          if (d === "'") {
            closed = true;
            i++;
            break;
          }
          if (d === "\\" && i + 1 < line.length) {
            const esc = line[i + 1] as string;
            if (esc === "n") delim += "\n";
            else if (esc === "t") delim += "\t";
            else if (esc === "r") delim += "\r";
            else if (esc === "a") delim += "\x07";
            else if (esc === "b") delim += "\b";
            else if (esc === "e" || esc === "E") delim += "\x1b";
            else if (esc === "f") delim += "\f";
            else if (esc === "v") delim += "\v";
            else if (esc === "\\") delim += "\\";
            else if (esc === "'") delim += "'";
            else if (esc === '"') delim += '"';
            else if (esc === "x") {
              const m = /^[0-9a-fA-F]{1,2}/.exec(line.slice(i + 2));
              if (m) {
                delim += String.fromCharCode(parseInt(m[0], 16));
                i += 2 + m[0].length;
                continue;
              } else {
                delim += "\\x";
                i += 2;
                continue;
              }
            } else if (esc === "u") {
              const m = /^[0-9a-fA-F]{1,4}/.exec(line.slice(i + 2));
              if (m) {
                try {
                  delim += String.fromCodePoint(parseInt(m[0], 16));
                } catch {
                  // invalid codepoint
                }
                i += 2 + m[0].length;
                continue;
              } else {
                delim += "\\u";
                i += 2;
                continue;
              }
            } else if (esc === "U") {
              const m = /^[0-9a-fA-F]{1,8}/.exec(line.slice(i + 2));
              if (m) {
                try {
                  delim += String.fromCodePoint(parseInt(m[0], 16));
                } catch {
                  // invalid codepoint
                }
                i += 2 + m[0].length;
                continue;
              } else {
                delim += "\\U";
                i += 2;
                continue;
              }
            } else if (/[0-7]/.test(esc)) {
              const m = /^[0-7]{1,3}/.exec(line.slice(i + 1));
              if (m) {
                delim += String.fromCharCode(parseInt(m[0], 8) & 0xff);
                i += 1 + m[0].length;
                continue;
              }
            } else if (esc === "c") {
              if (i + 2 < line.length && line[i + 2] !== "'") {
                const char = line[i + 2] as string;
                delim += char === "?" ? "\x7f" : String.fromCharCode(char.charCodeAt(0) & 0x1f);
                i += 3;
                continue;
              } else {
                delim += "\\c";
                i += 2;
                continue;
              }
            } else delim += "\\" + esc;
            i += 2;
            continue;
          }
          delim += d;
          i++;
        }
        if (!closed) ok = false;
        quoted = true;
      } else {
        delim += c;
        i++;
      }
    }
    if (ok && any && (delim !== "" || quoted)) {
      starts.push({ delim, quoted, dash: m[1] === "-" });
      re.lastIndex = i;
    }
  }
  return starts;
}

/** Whether a heredoc line ends the body: exactly the delimiter; `<<-` also allows leading tabs. */
export function heredocEnds(line: string, delim: string, dash: boolean): boolean {
  // A CRLF log line closes on `EOF\r` like bash does with a carriage return in the delimiter word.
  const l = line.endsWith("\r") ? line.slice(0, -1) : line;
  return (dash ? l.replace(/^\t+/, "") : l) === delim;
}

export function stripHeredocs(cmd: string): string {
  if (!cmd.includes("<<")) return cmd;
  const out: string[] = [];
  const queue: HeredocStart[] = [];
  let prefix = "";
  let cmdOffset = 0;
  for (const line of cmd.split("\n")) {
    const lineLen = line.length + 1;
    if (queue.length > 0) {
      const cur = queue[0] as HeredocStart;
      if (heredocEnds(line, cur.delim, cur.dash)) queue.shift();
      if (queue.length === 0) prefix = "";
      cmdOffset += lineLen;
      continue;
    }
    out.push(line);
    const lookahead = prefix + cmd.slice(cmdOffset);
    const starts = parseHeredocStarts(line, prefix, lookahead);
    if (starts.length > 0) queue.push(...starts);
    const full = prefix + line;
    if (inCommentOrArithmetic(full, full.length, lookahead)) {
      prefix = full + "\n";
    } else {
      prefix = "";
    }
    cmdOffset += lineLen;
  }
  return out.join("\n");
}

/** A grouping `( … )`, not `$(…)`, `<(…)`, `>(…)`, `name()`, or `name=(…)`. */
export function isGroupingSubshellOpen(text: string, i: number): boolean {
  if (i > 0) {
    const prev = text[i - 1] as string;
    if (prev === "$" || prev === "<" || prev === ">" || prev === "=") {
      let bs = 0;
      let j = i - 2;
      while (j >= 0 && text[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return false;
    }
  }
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j] as string)) j--;
  if (j >= 0 && /[A-Za-z0-9_]/.test(text[j] as string)) {
    let k = i + 1;
    while (k < text.length && /\s/.test(text[k] as string)) k++;
    if (k < text.length && text[k] === ")") return false;
  }
  return true;
}

/** Whether a string consists solely of shell redirections (e.g. `2>&1 > results.txt` or `> out.txt`). */
function isOnlyRedirects(s: string): boolean {
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i] as string)) i++;
    if (i >= n) break;
    const re = /(\d+|&)?(>>|>&|>\||>|<<<|<<-?|<&|<)/y;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return false;
    i = re.lastIndex;
    while (i < n && /\s/.test(s[i] as string)) i++;
    if (i >= n) return false;
    let any = false;
    while (i < n && !/\s/.test(s[i] as string)) {
      const c = s[i] as string;
      if (c === "<" || c === ">") break;
      any = true;
      if (c === "'") {
        const j = s.indexOf("'", i + 1);
        if (j < 0) return false;
        i = j + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < n && s[j] !== '"') {
          if (s[j] === "\\" && j + 1 < n) j += 2;
          else j++;
        }
        if (j >= n) return false;
        i = j + 1;
        continue;
      }
      i++;
    }
    if (!any) return false;
  }
  return true;
}

function trimTrailingCompoundBraces(text: string): string {
  let s = text;
  while (s.endsWith("}")) {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < s.length - 1; i++) {
      const ch = s[i] as string;
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (!inSingle) {
        if (ch === "$" && s[i + 1] === "{") {
          depth++;
          i++;
        } else if (ch === "}" && depth > 0) {
          depth--;
        }
      }
    }
    if (depth > 0) break;
    const before = s.slice(0, -1);
    if (before === "" || /\s$/.test(before) || /;\s*$/.test(before)) {
      s = before.trimEnd();
    } else {
      break;
    }
  }
  return s;
}

/** Quote-aware split on `&&`, `||`, `|`, `;`, `&` and newlines. */
export function splitSegments(cmd: string): Segment[] {
  const segs: Segment[] = [];
  let cur = "";
  let quote: string | null = null;
  let opens = 0;
  let closes = 0;
  const arithStack: string[] = [];

  const end = (op: string): void => {
    let text = cur.trim();
    const segOpens = opens;
    const segCloses = closes;
    cur = "";
    opens = 0;
    closes = 0;

    // A segment consisting only of a compound closing delimiter `}` or `)` followed by redirections
    // belongs to the preceding compound command; attach its redirections to the previous segment.
    const mClose = /^\s*([})])(?:\s+(.*)|\s*)$/.exec(text);
    if (mClose && segs.length > 0 && isOnlyRedirects(mClose[2] ?? "")) {
      const last = segs[segs.length - 1] as Segment;
      const redirs = (mClose[2] ?? "").trim();
      if (redirs !== "") last.text += " " + redirs;
      last.op = op;
      if (mClose[1] === ")" || segCloses > 0) last.closes += Math.max(1, segCloses);
      return;
    }

    if (closes > 0 || segCloses > 0) {
      let excess = Math.max(0, (closes || segCloses) - (opens || segOpens));
      if (excess === 0 && (text.startsWith("(") || text.startsWith("! ("))) {
        excess = 1;
      }
      while (excess > 0) {
        let idx = -1;
        let inSingle = false;
        let inDouble = false;
        for (let i = text.length - 1; i >= 0; i--) {
          const ch = text[i] as string;
          if (ch === "'" && !inDouble) inSingle = !inSingle;
          else if (ch === '"' && !inSingle) inDouble = !inDouble;
          else if (!inSingle && !inDouble && ch === ")") {
            const suffix = text.slice(i + 1);
            if (isOnlyRedirects(suffix)) {
              idx = i;
              break;
            }
          }
        }
        if (idx >= 0) {
          const sep = idx > 0 && text[idx - 1] !== " " && idx + 1 < text.length && text[idx + 1] !== " " ? " " : "";
          text = (text.slice(0, idx) + sep + text.slice(idx + 1)).trim();
          excess--;
        } else {
          break;
        }
      }
    }
    text = trimTrailingCompoundBraces(text);
    if (text === "") {
      // An operator after an empty segment (e.g. "a;\n") keeps the earlier operator.
      // A segment that held only closing parens still closes the preceding subshell.
      if (segCloses > 0 && segs.length > 0) (segs[segs.length - 1] as Segment).closes += segCloses;
      return;
    }
    segs.push({ text, op, opens: segOpens, closes: segCloses });
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    const next = cmd[i + 1];
    if (quote !== null) {
      cur += c;
      if (quote === "'") {
        if (c === "'") quote = null;
      } else if (quote === '"') {
        if (c === "\\" && next !== undefined) {
          cur += next;
          i++;
        } else if (c === '"') {
          quote = null;
        }
      } else if (quote === "$'") {
        if (c === "\\" && next !== undefined) {
          cur += next;
          i++;
        } else if (c === "'") {
          quote = null;
        }
      }
      continue;
    }
    if (c === "\\") {
      cur += c + (next ?? "");
      i++;
      continue;
    }
    if (c === "$" && next === "'") {
      quote = "$'";
      cur += "$'";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (arithStack.length > 0) {
      cur += c;
      if (c === "(") {
        arithStack.push("(");
      } else if (c === "[") {
        arithStack.push("[");
      } else if (c === ")") {
        const top = arithStack[arithStack.length - 1];
        if (top === "(") {
          arithStack.pop();
        } else if ((top === "$((" || top === "((") && next === ")") {
          arithStack.pop();
          cur += ")";
          i++;
        }
      } else if (c === "]") {
        const top = arithStack[arithStack.length - 1];
        if (top === "[" || top === "$[") {
          arithStack.pop();
        }
      }
      continue;
    }
    if (isUnescapedCommentStart(cmd, i)) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    const isCommandStart = isArithmeticCommandStart(cur);
    const arith = checkArithmeticOpener(cmd, i, isCommandStart);
    if (arith !== null) {
      arithStack.push(arith);
      cur += arith;
      i += arith.length - 1;
      continue;
    }
    if (c === "&" && next === "&") {
      end("&&");
      i++;
    } else if (c === "|" && next === "|") {
      end("||");
      i++;
    } else if (c === "|") {
      let bs = 0;
      let j = i - 2;
      while (j >= 0 && cmd[j] === "\\") {
        bs++;
        j--;
      }
      if (cmd[i - 1] === ">" && bs % 2 === 0) {
        cur += c;
      } else {
        end("|");
        if (next === "&") i++;
      }
    } else if (c === ";") {
      end(";");
    } else if (c === "\n") {
      end("\n");
    } else if (c === "&") {
      const prev = cmd[i - 1];
      if (prev === ">" || prev === "<" || next === ">") cur += c;
      else end("&");
    } else if (c === "(") {
      opens++;
      cur += c;
    } else if (c === ")") {
      closes++;
      cur += c;
    } else {
      cur += c;
    }
  }
  end("");
  return segs;
}
