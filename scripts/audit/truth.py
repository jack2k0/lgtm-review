#!/usr/bin/env python3
"""Independent ground-truth status audit for lgtm-review (truth side).

Reads a Claude Code projects directory (raw JSONL) and derives, for every real user prompt, the status
(checked / unchecked / failing / no-changes) and a reason class from the PRD rules ONLY. It shares no code
with packages/core. Run with `python3 -I scripts/audit/truth.py --projects-dir ~/.claude/projects --out <file>`.

Privacy: the output (JSON) holds ids, statuses and boolean flags, never prompt text, commands or paths, but it is
still derived from private logs: write it outside the repository and never commit it. Stdout prints counts only.

Rules implemented (see context/foundation/prd.md: FR-002, FR-015, S-11, S-16, S-20 and the subagent / background / fork decisions):
  prompt     a real user message: not a tool result, not sidechain, not meta, origin human or absent, not a task
             notification, local-command output or system reminder. Slash-command turns are prompts (except /clear,
             /exit, /compact).
  edit       Edit/Write/MultiEdit/NotebookEdit (not is_error) and Bash commands that write files (redirects, tee,
             sed -i, perl -i, cp/mv/rm, in-place formatters, git apply, interpreter one-liners that write, git operations).
             Class of a file: doc (FR-015 patterns) > scratch (S-20) > code. Git-only edits ("gitop") never move the status.
  check      test / typecheck / lint / build / verification commands, package-manager scripts, gh run watch.
             Exit from the tool result (is_error, "Exit code N"); masked exits (pipe, `;`, `||` after the check) with exit 0
             are failing only on textual evidence ("N failed", BUILD FAILURE, EXIT=N ...). Background checks are resolved
             by their task notification (exit code in the summary); unresolved = did not complete.
  order      by position of the tool result in the file; inside one Bash command by segment index.
  subagents  <session>/subagents/agent-*.jsonl (meta.toolUseId -> spawning prompt, recursive); merged by timestamp.
  status     code edits (class code; strict variant also git merge/rebase/pull/...) decide: none -> no-changes; check
             (completed) after the last code edit: last one passed -> checked, failed -> failing; else unchecked.
"""
import argparse
import glob
import json
import os
import posixpath
import re
import shlex
import sys
import time
from collections import Counter, defaultdict

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
AGENT_TOOLS = {"Agent", "Task"}
SKIP_SLASH = {"/clear", "/exit", "/compact"}
HOME = os.path.expanduser("~")

# ---------------------------------------------------------------------------------------------------------------------
# Paths: documentation, scratch
# ---------------------------------------------------------------------------------------------------------------------
DOC_EXT = {".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".rst", ".adoc", ".asciidoc"}
DOC_NAMES = {"readme", "license", "licence", "copying", "notice", "authors", "contributors", "changelog", "changes", "history"}
TEMP_ROOTS = ("/tmp/", "/var/tmp/", "/dev/shm/", "/private/tmp/")
SCRATCH_VARS = {"S", "SP", "SCRATCH", "SCRATCHPAD", "TMP", "TMPDIR", "T", "TEMP", "TMPD"}
IGNORED_RM = {"node_modules", "dist", "build", ".next", ".turbo", "coverage", "__pycache__", ".pytest_cache", ".cache", ".venv", "venv", ".mypy_cache", ".ruff_cache", "target"}


def is_doc(path):
    base = posixpath.basename(path).lower()
    stem, ext = posixpath.splitext(base)
    if ext in DOC_EXT:
        return True
    if base in DOC_NAMES:
        return True
    return ext == ".txt" and stem in DOC_NAMES


class Ctx:
    """Per-session constants for classifying paths."""

    def __init__(self, root):
        self.root = root or "/"

    def classify(self, path, call_cwd, var_scratch=(), unk_scratch=False):
        """Return 'doc' | 'scratch' | 'code' | 'ignore'."""
        if not path:
            return "code"
        p = path
        m = re.match(r"^\$\{?(\w+)\}?(/.*)?$", p)
        if m:
            if m.group(1) in SCRATCH_VARS or m.group(1) in var_scratch:
                return "scratch"
            if m.group(1) == "HOME":
                p = HOME + (m.group(2) or "")
            else:
                # unresolved variable: scratch when the command works under a scratch root, else assume repo code
                return "doc" if is_doc(p) else "scratch" if unk_scratch else "code"
        if p.startswith("~"):
            p = HOME + p[1:]
        if p.startswith("-") or p in ("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"):
            return "ignore"
        if not p.startswith("/"):
            p = posixpath.join(call_cwd or self.root, p)
        p = posixpath.normpath(p)
        if p.startswith("/dev/"):
            return "ignore"
        if is_doc(p):
            return "doc"
        if p.endswith((".log", ".patch", ".diff", ".tmp", ".bak", ".orig", ".rej", ".swp")):
            return "scratch"  # logs, patches and backups are working files, not code
        inside = lambda base: base and (p == base or p.startswith(base.rstrip("/") + "/"))
        if inside(call_cwd) or inside(self.root) or "/.claude/worktrees/" in p:
            return "code"
        if p.startswith(TEMP_ROOTS) or any(part.startswith("scratch") for part in p.split("/")):
            return "scratch"
        return "code"


# ---------------------------------------------------------------------------------------------------------------------
# Shell command analysis
# ---------------------------------------------------------------------------------------------------------------------
HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][\w]*)\1")


def split_heredocs(cmd):
    """Remove heredoc bodies. Returns (command without bodies, {line_index: body text})."""
    out, bodies = [], {}
    lines = cmd.split("\n")
    pending, i = [], 0
    cur_line_idx = -1
    for line in lines:
        if pending:
            if line.strip() == pending[0][0]:
                pending.pop(0)
            else:
                bodies[pending[0][1]] = bodies.get(pending[0][1], "") + line + "\n"
            continue
        out.append(line)
        cur_line_idx = len(out) - 1
        for m in HEREDOC_RE.finditer(line):
            pending.append((m.group(2), cur_line_idx))
    return "\n".join(out), bodies


def mask_quotes(s):
    """Same length string with quoted content replaced by '_' (quotes kept)."""
    res, q, i = [], None, 0
    while i < len(s):
        c = s[i]
        if q is None:
            if c == "\\" and i + 1 < len(s):
                res.append("__")
                i += 2
                continue
            if c in "'\"":
                q = c
            res.append(c)
        else:
            if c == "\\" and q == '"' and i + 1 < len(s):
                res.append("__")
                i += 2
                continue
            if c == q:
                q = None
                res.append(c)
            else:
                res.append("_")
        i += 1
    return "".join(res)


OP_RE = re.compile(r"&&|\|\||;|\||\n|&(?!>)|\(|\)|\{|\}")


def segments(cmd):
    """Split a command (no heredoc bodies) into [(text, op_before, op_after, line_index)] by shell operators."""
    m = mask_quotes(cmd)
    res, last, prev_op = [], 0, None
    for mo in OP_RE.finditer(m):
        # `>&2`, `2>&1`, `&>`: the & belongs to a redirect
        if mo.group() == "&" and (m[mo.start() - 1 : mo.start()] in (">", "<")):
            continue
        txt = cmd[last : mo.start()]
        line = cmd.count("\n", 0, last)
        res.append([txt, prev_op, mo.group(), line])
        prev_op, last = mo.group(), mo.end()
    res.append([cmd[last:], prev_op, None, cmd.count("\n", 0, last)])
    return [r for r in res if r[0].strip()]


WRAPPERS = {"time", "command", "nohup", "exec", "sudo", "env", "nice", "stdbuf", "then", "do", "else", "!", "if", "while", "until", "builtin", "setsid"}


def words_of(seg):
    try:
        w = shlex.split(seg, posix=True)
    except ValueError:
        w = seg.split()
    return w


def unwrap(words, var_assign=None):
    """Strip env assignments, wrappers and runners; returns the effective argv (first word is the program)."""
    w = list(words)
    for _ in range(12):
        if not w:
            break
        if re.match(r"^[A-Za-z_]\w*=", w[0]):
            if var_assign is not None:
                var_assign.append(w[0])
            w = w[1:]
            continue
        base = posixpath.basename(w[0])
        if base in WRAPPERS:
            w = w[1:]
            continue
        if base == "timeout" and len(w) > 2:
            w = w[2:] if re.match(r"^[\d.]+[smhd]?$", w[1]) else w[1:]
            continue
        if base in ("uv", "poetry", "pipenv", "pdm", "rye", "hatch") and len(w) > 2 and w[1] == "run":
            w = w[2:]
            continue
        if base == "uv" and len(w) > 1 and w[1] == "tool":
            w = w[3:]
            continue
        if base in ("npx", "bunx", "pnpx") and len(w) > 1:
            w = [x for x in w[1:] if not x.startswith("-")][:] if w[1].startswith("-") else w[1:]
            continue
        if base in ("pnpm", "yarn", "bun", "npm") and len(w) > 2 and w[1] in ("exec", "dlx", "x"):
            w = w[2:]
            continue
        if base == "corepack" and len(w) > 1:
            w = w[1:]
            continue
        break
    if w:
        w[0] = posixpath.basename(w[0]) if "/" in w[0] and not w[0].endswith((".sh", ".mjs", ".py", ".js")) else w[0]
    return w


SCRIPT_RE = re.compile(r"^(?:\./)?(?:[\w.\-/]*/)?(?:check|test|tests|lint|ci|verify|validate|gate|mutation|smoke|run[-_]?tests?)[\w.\-]*\.(?:sh|mjs|cjs|js|py|ts|bash)$", re.I)
PY_NAMES = {"python", "python3", "python3.10", "python3.11", "python3.12", "python3.13", "py"}
PKG_SCRIPTS = re.compile(r"^(?:test|tests|check|lint|typecheck|type-check|types|tsc|build|ci|verify|validate|gate|e2e|smoke|compile)(?:[:\-][\w:\-]+)?$")
RUNNER_ALWAYS = {"pytest", "py.test", "vitest", "jest", "mocha", "ava", "rspec", "phpunit", "bats", "ctest", "tox", "nox", "tsc", "vue-tsc", "mypy", "pyright", "basedpyright", "eslint",
                 "shellcheck", "hadolint", "golangci-lint", "pylint", "flake8", "pyflakes", "stylelint", "markdownlint", "yamllint", "actionlint", "karma", "jasmine", "svelte-check", "tsup", "vite-node-test"}
NOT_CHECK_FLAGS = {"--help", "-h", "--version", "-V", "--collect-only", "--co", "--dry-run", "--listTests", "--init"}


def check_kind(argv, text):
    """Is this (already unwrapped) command a verification command? Returns a short kind or None."""
    if not argv:
        return None
    p, a = argv[0], argv[1:]
    if any(x in NOT_CHECK_FLAGS for x in a):
        return None
    if p in ("bash", "sh", "zsh") and a and a[0] == "-n":
        return None
    # scripts (optionally behind bash/sh/node/python)
    cand = [p] + a[:2]
    if p in {"bash", "sh", "zsh", "node", "tsx", "bun", "deno"} | PY_NAMES:
        if p in PY_NAMES and a[:1] == ["-m"] and len(a) > 1:
            return check_kind(unwrap(a[1:]), text)
        if p in PY_NAMES and a[:1] and a[0].endswith("manage.py") and len(a) > 1 and a[1] in ("test", "check"):
            return "test"
        if p in ("bash", "sh", "zsh") and a and a[0] == "-n":
            return None
        if p == "node" and a[:1] == ["--test"]:
            return "test"
        cand = [x for x in a if not x.startswith("-")][:1]
    for c in cand:
        if SCRIPT_RE.match(c):
            return "script"
    if p in RUNNER_ALWAYS:
        if p == "tsc" and "--init" in a:
            return None
        return "runner"
    if p in ("unittest",):
        return "test"
    if p == "ruff":
        if a[:1] == ["check"] and "--fix" not in a:
            return "lint"
        if a[:1] == ["format"] and "--check" in a:
            return "lint"
        return None
    if p in ("black", "isort") and ("--check" in a or "--check-only" in a or "--diff" in a):
        return "lint"
    if p == "prettier" and ("--check" in a or "-c" in a or "-l" in a):
        return "lint"
    if p == "biome" and a[:1] in (["check"], ["lint"], ["ci"]) and "--write" not in a and "--apply" not in a:
        return "lint"
    if p == "go" and a[:1] and a[0] in ("test", "vet", "build"):
        return "go"
    if p == "cargo" and a[:1] and a[0] in ("test", "check", "clippy", "build", "nextest", "bench"):
        return "cargo"
    if p == "cargo" and a[:1] == ["fmt"] and "--check" in a:
        return "lint"
    if p in ("mvn", "mvnw", "./mvnw") and any(x in ("test", "verify", "package", "compile", "install") for x in a):
        return "mvn"
    if p in ("gradle", "gradlew", "./gradlew") and any(x in ("test", "check", "build", "assemble") for x in a):
        return "gradle"
    if p == "dotnet" and a[:1] and a[0] in ("test", "build"):
        return "dotnet"
    if p == "make" and any(x in ("test", "check", "lint", "build", "ci", "verify", "all", "typecheck") for x in a):
        return "make"
    if p == "turbo":
        rest = [x for x in a if not x.startswith("-")]
        if rest and rest[0] == "run":
            rest = rest[1:]
        if rest and PKG_SCRIPTS.match(rest[0]):
            return "pkg"
    if p in ("pnpm", "npm", "yarn", "bun"):
        rest, i = [], 0
        while i < len(a):
            x = a[i]
            if x in ("-C", "--dir", "--prefix", "--filter", "-F", "-w", "--workspace", "--cwd"):
                i += 2
                continue
            if x.startswith("-"):
                i += 1
                continue
            rest.append(x)
            i += 1
        if rest and rest[0] in ("run", "run-script", "exec", "dlx"):
            if rest[0] in ("exec", "dlx"):
                return check_kind(unwrap(rest[1:]), text)
            rest = rest[1:]
        if rest and (PKG_SCRIPTS.match(rest[0]) or rest[0] in ("t", "tst")):
            return "pkg"
        if rest and rest[0] in RUNNER_ALWAYS:  # `pnpm vitest run`: package managers run local bins directly
            return check_kind(unwrap(rest), text)
        return None
    if p == "gh":
        if a[:2] in (["run", "watch"], ["pr", "checks"], ["run", "view"]) and a[:2] != ["run", "view"]:
            return "ci"
    if p == "pre-commit" and a[:1] == ["run"]:
        return "lint"
    if p == "cypress" and a[:1] == ["run"]:
        return "test"
    if p == "playwright" and a[:1] == ["test"]:
        return "test"
    return None


GIT_OPS = {"merge", "rebase", "pull", "checkout", "switch", "stash", "cherry-pick", "mv", "rm", "restore", "reset", "revert", "am"}
INPLACE_FMT = {"prettier": ("--write", "-w"), "eslint": ("--fix",), "biome": ("--write", "--apply"), "ruff": ("--fix",)}
SHELL_WRITE_RE = re.compile(r"""open\s*\([^)]*,\s*['"](?:w|a|wb|ab|r\+|x|w\+)['"]|\.write_text\(|\.write_bytes\(|writeFile(?:Sync)?\(|appendFile(?:Sync)?\(|fs\.(?:rename|unlink|copyFile|rm|writeSync)|shutil\.(?:copy|copy2|copyfile|move|rmtree)|os\.(?:rename|remove|replace|unlink)|json\.dump\(|\.write\(""")
QUOTED_PATH_RE = re.compile(r"""['"]([~/.$\w][^'"\s]*(?:/[^'"\s]*|\.\w{1,6}))['"]""")


def git_strict_edit(sub, args):
    """Does this git operation count as an edit under the strict variant?"""
    if sub in ("checkout", "switch"):
        return not any(x in ("-b", "-B", "-c", "-C", "--orphan", "--detach") for x in args) and len([x for x in args if not x.startswith("-")]) > 0 and "--" in args or sub == "checkout" and "." in args
    if sub == "stash":
        return not (args[:1] and args[0] in ("list", "show"))
    return True


def analyse_bash(cmd, ctx, call_cwd):
    """Return (checks, edits, info). checks: list of dict(seg, kind, masked); edits: list of dict(seg, cls, how).
    cls in code|doc|scratch|git|gitstrict."""
    body_cmd, bodies = split_heredocs(cmd)
    segs = segments(body_cmd)
    var_scratch = set()
    for m in re.finditer(r"(?:^|[\s;&(])([A-Za-z_]\w*)=(['\"]?)(/tmp/[^\s'\";]*|/var/tmp/[^\s'\";]*|[^\s'\";]*scratch[^\s'\";]*|\$\{?(?:S|SP|TMPDIR|SCRATCH)\}?[^\s'\";]*)", body_cmd):
        var_scratch.add(m.group(1))
    checks, edits = [], []
    cwd = call_cwd
    unk = bool(re.search(r"scratchpad|/tmp/|\$\{?S\}?\b|\$\{?SP\}?\b", body_cmd))
    pipefail = "pipefail" in body_cmd
    env = {}
    for txt, _, _, _ in segs:
        for w in words_of(txt)[:3]:
            m = re.match(r"^(?:export\s+)?([A-Za-z_]\w*)=(.*)$", w)
            if m:
                env[m.group(1)] = m.group(2)
    env.setdefault("HOME", HOME)

    def expand(x):
        for _ in range(3):
            y = re.sub(r"\$\{(\w+)\}|\$(\w+)", lambda m: env.get(m.group(1) or m.group(2), m.group(0)), x)
            if y == x:
                break
            x = y
        return x

    for si, (txt, opb, opa, line) in enumerate(segs):
        av = []
        words = [expand(w) for w in words_of(txt)]
        argv = unwrap(words, av)
        if not argv:
            continue
        p, a = argv[0], argv[1:]
        body = bodies.get(line, "")
        # cd tracking for relative paths
        if p == "cd" and a:
            t = a[0]
            t = HOME + t[1:] if t.startswith("~") else t
            cwd = posixpath.normpath(t if t.startswith("/") else posixpath.join(cwd or "/", t))
            continue
        kind = check_kind(argv, txt)
        masked = False
        if kind:
            for j in range(si, len(segs)):
                op = segs[j][2]
                if op is None:
                    break
                if j + 1 < len(segs) or True:
                    nxt = segs[j + 1] if j + 1 < len(segs) else None
                    if nxt is None:
                        break
                    if op in (";", "\n", "||", "&") or (op == "|" and not pipefail):
                        masked = True
                    # a later `&&` keeps the exit
            wrapped = kind == "script" and p not in ({"bash", "sh", "zsh", "node", "tsx", "bun", "deno"} | PY_NAMES) and not SCRIPT_RE.match(p)
            checks.append({"seg": si, "kind": kind, "masked": masked, "wrapped": wrapped})
        # --- edits ---
        def add(cls, how, n=1):
            edits.append({"seg": si, "cls": cls, "how": how})

        if p == "git":
            ga = list(a)
            while ga and (ga[0] in ("-C", "-c") and len(ga) > 1):
                ga = ga[2:]
            ga = [x for x in ga if not x.startswith("--no-pager")]
            sub = ga[0] if ga else ""
            if sub == "apply":
                add(ctx.classify("?", cwd), "git-apply")
            elif sub in GIT_OPS:
                add("gitstrict" if git_strict_edit(sub, ga[1:]) else "git", "git")
            continue
        # in-place tools
        if p == "sed" and any(x.startswith("-i") or x == "--in-place" for x in a) or (p == "perl" and any(re.match(r"^-\w*i", x) for x in a)):
            files = [x for x in a if not x.startswith("-")]
            if p == "sed" and not any(x in ("-e", "-f") for x in a) and files:
                files = files[1:]
            if p == "perl":
                files = files[1:] if not any(x == "-e" or re.match(r"^-\w*e", x) for x in a) else files[1:]
            cl = [ctx.classify(f, cwd, var_scratch, unk) for f in files] or ["code"]
            add(_worst(cl), "sed-i")
        elif p in INPLACE_FMT and any(x in INPLACE_FMT[p] for x in a) and not (p == "ruff" and a[:1] == ["check"] and "--fix" not in a):
            add("code", "formatter")
        elif p == "ruff" and a[:1] == ["format"] and "--check" not in a and "--diff" not in a:
            add("code", "formatter")
        elif p in ("black", "isort") and not any(x in a for x in ("--check", "--check-only", "--diff")):
            add("code", "formatter")
        elif p in ("gofmt", "goimports") and "-w" in a:
            add("code", "formatter")
        elif p == "cargo" and a[:1] == ["fmt"] and "--check" not in a:
            add("code", "formatter")
        elif p in ("patch",):
            add("code", "patch")
        elif p in ("cp", "mv", "rm", "install", "ln", "rsync"):
            files = [x for x in a if not x.startswith("-")]
            if p == "rm":
                files = [x for x in files if posixpath.basename(x.rstrip("/")) not in IGNORED_RM and not x.endswith(".pyc")]
            if p == "cp" or p == "install" or p == "rsync":
                files = files[-1:]
            if p == "ln":
                files = []
            cl = [ctx.classify(f, cwd, var_scratch, unk) for f in files]
            cl = [c for c in cl if c != "ignore"]
            if cl:
                add(_worst(cl), p)
        elif p == "tee":
            files = [x for x in a if not x.startswith("-")]
            cl = [ctx.classify(f, cwd, var_scratch, unk) for f in files]
            cl = [c for c in cl if c != "ignore"]
            if cl:
                add(_worst(cl), "tee")
        elif p in ("pnpm", "npm", "yarn", "bun") and a[:1] and a[0] in ("add", "remove", "rm", "uninstall") and len([x for x in a[1:] if not x.startswith("-")]) > 0:
            add("code", "pkg-change")
        elif p in PY_NAMES | {"node", "ruby", "perl", "php", "deno", "bun", "tsx"} or (p in ("bash", "sh", "zsh") and "-c" in a):
            code = body + " " + txt
            if SHELL_WRITE_RE.search(code):
                paths = QUOTED_PATH_RE.findall(code)
                cl = [ctx.classify(x, cwd, var_scratch, unk) for x in paths]
                cl = [c for c in cl if c != "ignore"]
                add(_worst(cl) if cl else "code", "interp-write")
        # redirects (stdout / any fd into a file), not for pure data movers handled above
        mt = mask_quotes(txt)
        for mo in re.finditer(r"(?<![<>&\d])(\d?)>>?(?![&>])\s*([^\s;&|<>()]+)", mt):
            tgt = expand(txt[mo.start(2) : mo.end(2)].strip("'\""))
            if tgt.startswith("&"):
                continue
            if "_" * 3 in mt[mo.start(2) : mo.end(2)] and tgt and not tgt.startswith("$"):
                pass
            c = ctx.classify(tgt, cwd, var_scratch, unk)
            if c == "ignore":
                continue
            if kind and mo.group(1) in ("", "1", "2"):
                # a check writing its own output (> log) is not an edit unless it lands in a code file
                if c in ("scratch", "doc"):
                    continue
                if tgt.endswith((".txt", ".out", ".json", ".xml", ".html")) or "log" in tgt:
                    continue
            add(c, "redirect")
    kinds = {e["cls"] for e in edits}
    mixed = bool(kinds & {"git", "gitstrict"}) and bool(kinds - {"git", "gitstrict"})
    return checks, edits, {"segs": len(segs), "pipefail": pipefail, "mixed": mixed}


def _worst(classes):
    classes = [c for c in classes if c != "ignore"]
    for c in ("code", "doc", "scratch"):
        if c in classes:
            return c
    return "code"


# ---------------------------------------------------------------------------------------------------------------------
# Tool result helpers
# ---------------------------------------------------------------------------------------------------------------------
EVIDENCE_RES = [
    re.compile(r"\b[1-9]\d* (?:failed|failures?|errors?)\b", re.I),
    re.compile(r"\b(?:EXIT|exit|rc|RC|status|STATUS|check)[=:]\s*[1-9]\d*\b"),
    re.compile(r"BUILD FAILURE"),
    re.compile(r"Tests run:.*(?:Failures|Errors): [1-9]"),
    re.compile(r"^(?:FAILED|FAIL)\b", re.M),
    re.compile(r"\bFAILED\b"),
]


EXPECTED_RED_RE = re.compile(r"\bRED\b|expected (?:to )?(?:fail|red)|\bbehaved\b", re.I)


def block_text(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict))
    return ""


def result_info(rec, block):
    tur = rec.get("toolUseResult")
    tur = tur if isinstance(tur, dict) else {}
    txt = block_text(block.get("content"))
    out = (tur.get("stdout") or "") + "\n" + (tur.get("stderr") or "") if tur else ""
    text = out if out.strip() else txt
    exit_code = None
    m = re.match(r"\s*Exit code (\d+)", txt)
    if m:
        exit_code = int(m.group(1))
    err = bool(block.get("is_error"))
    return {
        "err": err or (exit_code not in (None, 0)),
        "exit": exit_code,
        "text": text,
        "interrupted": bool(tur.get("interrupted")),
        "bg": tur.get("backgroundTaskId"),
        "bashdiff": bool(tur.get("bashEditDiff")),
    }


# ---------------------------------------------------------------------------------------------------------------------
# Thread reading
# ---------------------------------------------------------------------------------------------------------------------
def load(path):
    recs = []
    with open(path, "r", errors="replace") as fh:
        for i, line in enumerate(fh):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if isinstance(o, dict):
                recs.append((i, o))
    return recs


def user_prompt_kind(o):
    """Return (is_prompt, is_slash) for a user record."""
    if o.get("type") != "user" or o.get("isSidechain") or o.get("isMeta") or o.get("isCompactSummary"):
        return False, False
    origin = o.get("origin")
    if origin is not None and not (isinstance(origin, dict) and origin.get("kind") == "human"):
        return False, False
    c = (o.get("message") or {}).get("content")
    if isinstance(c, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
            return False, False
        c = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    if not isinstance(c, str) or not c.strip():
        return False, False
    s = c.lstrip()
    if s.startswith(("<task-notification", "<local-command-", "<system-reminder", "<bash-input", "<bash-stdout", "<bash-stderr")):
        return False, False
    if s.startswith("[Request interrupted"):
        return False, False
    m = re.search(r"<command-name>\s*(/[^<\s]*)", s)
    if s.startswith(("<command-name>", "<command-message>")) or m:
        if m and m.group(1) in SKIP_SLASH:
            return False, False
        return True, True
    return True, False


def read_thread(path, is_sub, ctx_root):
    """Parse one JSONL into prompts + events. Returns dict(prompts, events, agent_calls, notifs, first_ts, cwd)."""
    recs = load(path)
    prompts, events, agent_calls, notifs = [], [], {}, {}
    pending = {}
    cur = -1 if is_sub else None
    first_ts, cwd0 = None, None
    ctx = Ctx(ctx_root)
    for pos, o in recs:
        ts = o.get("timestamp")
        if ts and first_ts is None:
            first_ts = ts
        if o.get("cwd") and cwd0 is None:
            cwd0 = o["cwd"]
        t = o.get("type")
        if t == "user":
            ok, slash = (False, False) if is_sub else user_prompt_kind(o)
            if ok:
                prompts.append({"uuid": o.get("uuid"), "ts": ts, "slash": slash, "pos": pos})
                cur = len(prompts) - 1
                continue
            c = (o.get("message") or {}).get("content")
            if isinstance(c, str) and c.lstrip().startswith("<task-notification"):
                tid = re.search(r"<tool-use-id>([^<]*)", c)
                st = re.search(r"<status>([^<]*)", c)
                sm = re.search(r"<summary>(.*?)</summary>", c, re.S)
                ec = None
                if sm:
                    m = re.search(r"exit code (\d+)", sm.group(1))
                    ec = int(m.group(1)) if m else None
                if tid:
                    notifs[tid.group(1)] = {"status": st.group(1) if st else None, "exit": ec, "pos": pos}
                continue
            if isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        use = pending.pop(b.get("tool_use_id"), None)
                        if use is None:
                            continue
                        _emit(use, o, b, pos, ts, events, ctx, cur)
        elif t == "assistant":
            content = (o.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    pending[b.get("id")] = {"id": b.get("id"), "name": b.get("name"), "input": b.get("input") or {}, "cwd": o.get("cwd") or cwd0, "prompt": cur, "ts": ts}
                    if b.get("name") in AGENT_TOOLS:
                        agent_calls[b.get("id")] = cur
    # tool calls without result: still count agent calls; checks/edits without a result never completed
    for use in pending.values():
        if use["name"] == "Bash":
            checks, edits, _ = analyse_bash(str(use["input"].get("command", "")), ctx, use["cwd"])
            if checks:
                events.append({"kind": "check", "prompt": use["prompt"], "pos": 10**9, "ts": use["ts"], "seg": checks[-1]["seg"], "ck": checks[-1], "outcome": "incomplete", "bgid": None, "tuid": use["id"], "sub": is_sub, "evidence": False})
    return {"prompts": prompts, "events": events, "agent_calls": agent_calls, "notifs": notifs, "first_ts": first_ts, "cwd": cwd0}


def _emit(use, rec, block, pos, ts, events, ctx, cur):
    name, inp = use["name"], use["input"]
    ri = result_info(rec, block)
    base = {"prompt": use["prompt"], "pos": pos, "ts": ts, "tuid": use["id"]}
    if name in EDIT_TOOLS:
        if ri["err"]:
            return
        path = inp.get("file_path") or inp.get("notebook_path") or ""
        cls = ctx.classify(path, use["cwd"])
        events.append({**base, "kind": "edit", "seg": 0, "cls": "code" if cls == "ignore" else cls, "how": "tool"})
    elif name == "Bash":
        cmd = str(inp.get("command", ""))
        checks, edits, info = analyse_bash(cmd, ctx, use["cwd"])
        for e in edits:
            events.append({**base, "kind": "edit", "seg": e["seg"], "cls": e["cls"], "how": e["how"], "bashdiff": ri["bashdiff"], "mixed": info["mixed"]})
        if ri["bashdiff"] and not edits:
            # harness recorded a diff for a command my detector did not recognise as writing
            events.append({**base, "kind": "edit", "seg": 0, "cls": "code", "how": "bashdiff-only"})
        if checks:
            ck = checks[-1]
            bgid = ri["bg"]
            is_bg = bool(bgid) or bool(inp.get("run_in_background"))
            if ri["interrupted"]:
                outcome = "incomplete"
            elif is_bg:
                outcome = "bg"
            elif ri["err"]:
                outcome = "fail"
            else:
                outcome = "pass"
            evidence = False
            if outcome == "pass" and ck["masked"]:
                # lines that announce an expected failure (mutation probes: "went RED (exit 1)") are not evidence
                shown = "\n".join(x for x in ri["text"].split("\n") if not EXPECTED_RED_RE.search(x))
                evidence = any(r.search(shown) for r in EVIDENCE_RES)
                if evidence:
                    outcome = "fail"
            events.append({**base, "kind": "check", "seg": ck["seg"], "ck": ck, "outcome": outcome, "bgid": use["id"] if is_bg else None, "evidence": evidence, "multi": len(checks) > 1})
    elif name in AGENT_TOOLS:
        events.append({**base, "kind": "agent", "seg": 0})


# ---------------------------------------------------------------------------------------------------------------------
# Judging
# ---------------------------------------------------------------------------------------------------------------------
def judge(events, mode):
    """events: ordered list of dict with kind edit/check, resolved outcome. Returns (status, reason_class, info)."""
    edits = [e for e in events if e["kind"] == "edit"]
    # mode: "main" = git operations never count; "strict" = merge/rebase/pull/... count as edits;
    # "cmd" = a git operation counts as a code edit when its Bash command also contains another file-writing segment
    # (command-level reading of S-11: only commands whose sole mutations are git operations are git-only).
    code = [e for e in edits if e["cls"] == "code" or (mode == "strict" and e["cls"] == "gitstrict") or (mode == "cmd" and e["cls"] in ("git", "gitstrict") and e.get("mixed"))]
    info = {}
    if not code:
        cls = {e["cls"] for e in edits}
        if not edits:
            rc = "nc-none"
        elif cls <= {"git", "gitstrict"}:
            rc = "nc-git"
        elif "scratch" in cls and "doc" in cls:
            rc = "nc-docscratch"
        elif "doc" in cls:
            rc = "nc-doc"
        elif "scratch" in cls:
            rc = "nc-scratch"
        else:
            rc = "nc-docscratch"
        return "no-changes", rc, info
    last_edit = max(e["order"] for e in code)
    checks = [e for e in events if e["kind"] == "check"]
    done = [c for c in checks if c["outcome"] in ("pass", "fail")]
    after = [c for c in done if c["order"] > last_edit]
    if after:
        last = max(after, key=lambda c: c["order"])
        info["decisive"] = last
        info["same_cmd"] = any(e["pos"] == last["pos"] and e["order"] < last["order"] for e in code)
        return ("checked", "c-passed", info) if last["outcome"] == "pass" else ("failing", "f-failed", info)
    inc_after = [c for c in checks if c["outcome"] == "incomplete" and c["order"] > last_edit]
    if inc_after:
        return "unchecked", "u-incomplete", info
    if done:
        info["fail_then_edit"] = max(done, key=lambda c: c["order"])["outcome"] == "fail"
        info["same_cmd_after"] = any(e["pos"] == max(done, key=lambda c: c["order"])["pos"] for e in code)
        return "unchecked", "u-after", info
    return "unchecked", "u-nocheck", info


# Counterfactual toggles: which tool behaviour (a deviation from the truth rules) would explain a disagreement.
# Used only to NAME mismatch categories; they never change the truth.
TOGGLES = [
    "git-op-in-mixed-command-counts",    # a git operation inside a command that also writes files counts as a code edit
    "git-ops-count-as-edits",            # every git operation counts as a code edit (strict)
    "shell-written-doc-or-scratch-counts",  # doc/scratch files written by Bash count as code
    "tool-written-scratch-counts",       # Edit/Write to scratch files counts as code
    "tool-written-doc-counts",           # Edit/Write to documentation counts as code
    "subagents-not-analysed",            # subagent transcripts ignored
    "background-checks-unresolved",      # background checks never complete
    "masked-failure-evidence-ignored",   # masked exit with failure text counts as a pass
    "edit-after-check-in-same-command",  # an edit in the same Bash command as a check counts as later
    "shell-edits-invisible",             # file writes by Bash are not seen
    "wrapped-check-not-recognised",      # a check script run under another program (flock, ...) is not recognised
    "script-checks-not-recognised",      # check scripts / gh run watch are not recognised as checks
]


def apply_toggles(events, tg):
    out = []
    check_pos = {e["pos"] for e in events if e["kind"] == "check"}
    for e in events:
        e = dict(e)
        if e["kind"] == "edit":
            sh = e["how"] != "tool"
            if "git-op-in-mixed-command-counts" in tg and e["cls"] in ("git", "gitstrict") and e.get("mixed"):
                e["cls"] = "code"
            if "git-ops-count-as-edits" in tg and e["cls"] == "gitstrict":
                e["cls"] = "code"
            if "shell-written-doc-or-scratch-counts" in tg and sh and e["cls"] in ("doc", "scratch"):
                e["cls"] = "code"
            if "tool-written-scratch-counts" in tg and not sh and e["cls"] == "scratch":
                e["cls"] = "code"
            if "tool-written-doc-counts" in tg and not sh and e["cls"] == "doc":
                e["cls"] = "code"
            if "shell-edits-invisible" in tg and sh:
                continue
            if "edit-after-check-in-same-command" in tg and e["pos"] in check_pos:
                e["order"] = e["order"][:4] + (999,)
        elif e["kind"] == "check":
            if "background-checks-unresolved" in tg and e.get("bgid"):
                e["outcome"] = "incomplete"
            if "masked-failure-evidence-ignored" in tg and e.get("evidence"):
                e["outcome"] = "pass"
            if "script-checks-not-recognised" in tg and e["ck"]["kind"] in ("script", "ci"):
                continue
            if "wrapped-check-not-recognised" in tg and e["ck"].get("wrapped"):
                continue
        if "subagents-not-analysed" in tg and e["sub"]:
            continue
        out.append(e)
    return out


def alternatives(ordered, base):
    """Results of judge() under every single toggle and pair of toggles that differs from `base`."""
    res = {}
    n = len(TOGGLES)
    combos = [(TOGGLES[i],) for i in range(n)] + [(TOGGLES[i], TOGGLES[j]) for i in range(n) for j in range(i + 1, n)]
    for tg in combos:
        st, rc, _ = judge(apply_toggles(ordered, set(tg)), "main")
        if (st, rc) != base:
            res["+".join(tg)] = [st, rc]
    return res


def build_orders(prompt_events):
    """Assign sortable 'order' keys; subagent events slot after the last parent event whose ts <= theirs."""
    parent = [e for e in prompt_events if not e["sub"]]
    subs = [e for e in prompt_events if e["sub"]]
    for e in parent:
        e["order"] = (e["pos"], 0, 0, 0, e["seg"])
    parent_sorted = sorted(parent, key=lambda e: e["pos"])
    for e in subs:
        anchor = -1
        for p in parent_sorted:
            if p["ts"] and e["ts"] and p["ts"] <= e["ts"]:
                anchor = p["pos"]
        e["order"] = (anchor, 1, e["ts"] or "", e["fileidx"] * 10**7 + e["pos"], e["seg"])  # different transcripts: by time, not by file


# ---------------------------------------------------------------------------------------------------------------------
# Session / project processing
# ---------------------------------------------------------------------------------------------------------------------
def process_project(pdir, min_age_s, now):
    files = sorted(glob.glob(os.path.join(pdir, "*.jsonl")))
    out, excluded = [], []
    sessions = {}
    for f in files:
        sid = os.path.basename(f)[:-6]
        if now - os.path.getmtime(f) < min_age_s:
            excluded.append(sid)
            continue
        probe = read_root(f)
        th = read_thread(f, False, probe)
        sessions[sid] = th
        th["file"] = f
        th["subs"] = []
        subdir = os.path.join(pdir, sid, "subagents")
        for sf in sorted(glob.glob(os.path.join(subdir, "agent-*.jsonl"))):
            meta = {}
            mp = sf[:-6] + ".meta.json"
            try:
                meta = json.load(open(mp))
            except (OSError, ValueError):
                pass
            sth = read_thread(sf, True, probe)
            sth["meta"] = meta
            th["subs"].append(sth)
    # first appearance owner per uuid
    owner = {}
    for sid, th in sorted(sessions.items(), key=lambda kv: kv[1]["first_ts"] or ""):
        for p in th["prompts"]:
            owner.setdefault(p["uuid"], sid)
    stats = Counter()
    for sid, th in sessions.items():
        notifs = dict(th["notifs"])
        for s in th["subs"]:
            notifs.update(s["notifs"])
        # host prompt for every agent tool_use id (parent and nested)
        host = dict(th["agent_calls"])
        for _ in range(4):
            for s in th["subs"]:
                for tid, pr in s["agent_calls"].items():
                    if tid not in host:
                        sid_tool = s["meta"].get("toolUseId")
                        if sid_tool in host:
                            host[tid] = host[sid_tool]
        per = defaultdict(list)
        for e in th["events"]:
            e["sub"], e["fileidx"] = False, 0
            if e["prompt"] is not None and e["prompt"] >= 0:
                per[e["prompt"]].append(e)
        for si, s in enumerate(th["subs"]):
            tuid = s["meta"].get("toolUseId")
            pr = host.get(tuid)
            if pr is None or pr < 0:
                stats["sub-unattached"] += 1
                continue
            stats["sub-attached"] += 1
            for e in s["events"]:
                e["sub"], e["fileidx"] = True, si + 1
                per[pr].append(e)
        for i, p in enumerate(th["prompts"]):
            evs = per.get(i, [])
            for e in evs:
                if e["kind"] == "check" and e["outcome"] == "bg":
                    n = notifs.get(e["bgid"])
                    if n is None:
                        e["outcome"] = "incomplete"
                    elif n["status"] == "failed" or (n["exit"] not in (None, 0)):
                        e["outcome"] = "fail"
                    elif n["status"] == "completed":
                        e["outcome"] = "pass"
                    else:
                        e["outcome"] = "incomplete"
                    e["bgresolved"] = n is not None
            build_orders(evs)
            ordered = sorted(evs, key=lambda e: e["order"])
            st, rc, info = judge(ordered, "main")
            sts, rcs, infos = judge(ordered, "strict")
            stc, rcc, infoc = judge(ordered, "cmd")
            dec = info.get("decisive")
            has_agent = any(e["kind"] == "agent" and not e["sub"] for e in evs)
            flags = set()
            if dec:
                if dec.get("bgid"):
                    flags.add("bg-check")
                if dec["ck"]["masked"]:
                    flags.add("masked")
                if dec.get("evidence"):
                    flags.add("evidence-fail")
                if dec["sub"]:
                    flags.add("check-by-sub")
                if info.get("same_cmd"):
                    flags.add("same-cmd")
                if dec["ck"]["kind"] == "script":
                    flags.add("script-check")
            if any(e["sub"] and e["kind"] == "edit" for e in evs):
                flags.add("sub-edit")
            if any(e["sub"] and e["kind"] == "check" for e in evs):
                flags.add("sub-check")
            if any(e["kind"] == "check" and e["outcome"] == "incomplete" for e in evs):
                flags.add("incomplete-check")
            if any(e["kind"] == "edit" and e["how"] not in ("tool",) and e["cls"] == "code" and not e.get("bashdiff") for e in evs):
                flags.add("shell-edit-nodiff")
            if any(e["kind"] == "edit" and e["cls"] in ("git", "gitstrict") for e in evs):
                flags.add("gitop")
            if any(e["kind"] == "edit" and e.get("mixed") for e in evs):
                flags.add("git-and-shell-in-one-command")
            if any(e["kind"] == "edit" and e["cls"] == "doc" for e in evs):
                flags.add("doc-edit")
            if any(e["kind"] == "edit" and e["cls"] == "scratch" for e in evs):
                flags.add("scratch-edit")
            if info.get("fail_then_edit"):
                flags.add("fail-then-edit")
            if info.get("same_cmd_after"):
                flags.add("same-cmd-after")
            if any(e["kind"] == "edit" and e["how"] == "bashdiff-only" for e in evs):
                flags.add("bashdiff-only")
            if any(e["kind"] == "edit" and e["how"] in ("redirect", "tee") and e["cls"] == "code" for e in evs):
                flags.add("redirect-edit")
            if sum(1 for e in evs if e["kind"] == "check") > 1:
                flags.add("multi-check")
            if p["slash"]:
                flags.add("slash")
            out.append({
                "project": os.path.basename(pdir), "session": sid, "uuid": p["uuid"], "idx": i, "owner": owner.get(p["uuid"]),
                "dup": owner.get(p["uuid"]) != sid, "agent": has_agent, "nevents": len(evs),
                "status": st, "reason": rc, "statusStrict": sts, "reasonStrict": rcs, "statusCmd": stc, "reasonCmd": rcc, "alt": alternatives(ordered, (st, rc)), "flags": sorted(flags),
            })
    return out, excluded, stats


def read_root(path):
    """Working directory of the session: the first record that carries one."""
    with open(path, "r", errors="replace") as fh:
        for i, line in enumerate(fh):
            if i > 200:
                break
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if isinstance(o, dict) and o.get("cwd"):
                return o["cwd"]
    return "/"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--projects-dir", default=os.path.join(HOME, ".claude", "projects"))
    ap.add_argument("--out", help="write per-prompt truth JSON here (outside the repo; never commit)")
    ap.add_argument("--min-age-minutes", type=float, default=30, help="skip session files modified more recently than this (the session being written)")
    args = ap.parse_args()
    if not os.path.isdir(args.projects_dir):
        print(f"truth: no projects dir at {args.projects_dir}", file=sys.stderr)
        return 2
    repo = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    if args.out and os.path.realpath(os.path.abspath(args.out)).startswith(repo + os.sep):
        print("truth: --out must be outside the repository (it holds ids derived from private logs)", file=sys.stderr)
        return 2
    now = time.time()
    rows, excl, stats = [], [], Counter()
    for pdir in sorted(glob.glob(os.path.join(args.projects_dir, "*"))):
        if not os.path.isdir(pdir):
            continue
        r, e, s = process_project(pdir, args.min_age_minutes * 60, now)
        rows += r
        excl += [(os.path.basename(pdir), x) for x in e]
        stats.update(s)
    res = {"rows": rows, "excluded": [{"project": a, "session": b} for a, b in excl], "stats": dict(stats)}
    if args.out:
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(res, fh)
    c = Counter(r["status"] for r in rows)
    print(f"truth: {len(rows)} prompts in {len({r['session'] for r in rows})} sessions; excluded sessions {len(excl)}; subagent files attached {stats['sub-attached']}, unattached {stats['sub-unattached']}")
    print("status: " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
    if not args.out:
        print("(no --out given: nothing written)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
