import { describe, expect, test } from "vitest";
import { classifyShellMutation, normalizePath, resolveTarget, SHELL_EDIT_FILE } from "./shell-edits.js";

const files = (cmd: string): string[] => classifyShellMutation(cmd).edits.map((e) => e.file);

describe("classifyShellMutation: edits", () => {
  test.each<[string, string[]]>([
    ["sed -i 's/a/b/' src/x.js", ["src/x.js"]],
    ["sed -i.bak 's/a/b/g' src/x.js src/y.js", ["src/x.js", "src/y.js"]],
    ["sed -i -e 's/a/b/' -e 's/c/d/' x.js", ["x.js"]],
    ["sed -Ei 's/(a)/\\1/' x.js", ["x.js"]],
    ["sed --in-place 's/a/b/' x.js", ["x.js"]],
    ["sed -i 's/a/b/' \"my file.js\"", ["my file.js"]],
    ["sed -i 's/a/b/' src/*.js", [SHELL_EDIT_FILE]],
    ["flock -w 10 /tmp/l sed -i 's/a/b/' src/x.js", ["src/x.js"]],
    ["ionice -c3 nice sed -i 's/a/b/' src/x.js", ["src/x.js"]],
    ["find . -name '*.js' | xargs sed -i 's/a/b/'", [SHELL_EDIT_FILE]],
    ["perl -pi -e 's/a/b/' lib/a.pl", ["lib/a.pl"]],
    ["perl -i.bak -pe 's/a/b/' lib/a.pl", ["lib/a.pl"]],
    ["perl -pi -e 's/a/b/' $(git ls-files)", [SHELL_EDIT_FILE]],
    ["echo hi | tee out.js", ["out.js"]],
    ["echo hi | tee -a notes.md other.md", ["notes.md", "other.md"]],
    ["echo hi | sudo tee /etc/hosts", ["/etc/hosts"]],
    ["echo hi > README.md", ["README.md"]],
    ["echo hi >> config/app.yml", ["config/app.yml"]],
    ["echo hi >config/app.yml", ["config/app.yml"]],
    ["cat > src/new.js <<'EOF'\nconsole.log(1)\nEOF", ["src/new.js"]],
    ["cat >> src/new.js <<EOF\nx\nEOF", ["src/new.js"]],
    ["git apply fix.patch", [SHELL_EDIT_FILE]],
    ["cd ../repo && git apply -p0 fix.patch", [SHELL_EDIT_FILE]],
    ["python3 - <<'EOF'\nopen('src/a.py', 'w').write('x')\nEOF", ["src/a.py"]],
    ["python3 - <<'EOF'\nwith open(path, \"w\") as f:\n    f.write('x')\nEOF", [SHELL_EDIT_FILE]],
    ["python - <<EOF\nfrom pathlib import Path\nPath('a').write_text('x')\nEOF", ["a"]],
    ["python3 - <<'EOF'\np = \"docs/x.md\"\nwith open(p, \"w\") as f:\n    f.write('x')\nEOF", ["docs/x.md"]],
    ["python3 - <<'EOF'\nfrom pathlib import Path\nPath(\"a/b.md\").write_text('x')\nEOF", ["a/b.md"]],
    ["python3 - <<'EOF'\nfrom pathlib import Path\np = Path(\"a.md\")\np.write_text('x')\nEOF", ["a.md"]],
    ["R=context/plan.md && python3 - \"$R\" <<'EOF'\nimport sys\nopen(sys.argv[1], \"w\").write('x')\nEOF", ["context/plan.md"]],
    ["R=docs/x.md\npython3 - $R <<'EOF'\nimport sys\np = sys.argv[1]\nopen(p, 'w').write('x')\nEOF", ["docs/x.md"]],
    ["python3 - docs/y.md <<'EOF'\nimport sys\nfrom pathlib import Path\nPath(sys.argv[1]).write_text('x')\nEOF", ["docs/y.md"]],
    ["python3 - <<'EOF'\nopen(f\"{x}.md\", \"w\").write('x')\nEOF", [SHELL_EDIT_FILE]],
    ["python3 - \"$UNSET\" <<'EOF'\nimport sys\nopen(sys.argv[1], \"w\").write('x')\nEOF", [SHELL_EDIT_FILE]],
    ["python3 - <<'EOF'\np = \"a.md\"\np = \"b.md\"\nopen(p, \"w\").write('x')\nEOF", ["b.md"]],
    ["python3 - <<'EOF'\np = \"docs/a.md\"\nopen(p, \"w\").write('x')\np = \"docs/b.md\"\nopen(p, \"w\").write('y')\nEOF", ["docs/a.md", "docs/b.md"]],
    ["python3 - <<'EOF'\nroot = \"docs\"\nopen(root + \"/x.md\", \"w\").write('x')\nEOF", ["docs/x.md"]],
    ["python3 - <<'EOF'\nfrom pathlib import Path\nroot = Path(\"docs\")\n(root / \"x.md\").write_text('x')\nEOF", ["docs/x.md"]],
    ["python3 - <<'EOF'\nimport os\nopen(os.path.join(\"docs\", \"x.md\"), \"w\").write('x')\nEOF", ["docs/x.md"]],
    ["python3 - <<'EOF'\np = \"docs/a.md\"\np = compute()\nopen(p, \"w\").write('x')\nEOF", [SHELL_EDIT_FILE]],
    ["F=context/plan.md && sed -i 's/a/b/' \"$F\"", ["context/plan.md"]],
    ["F=a.md\necho x >> \"$F\"", ["a.md"]],
    ["D=docs && echo x > $D/y.md", ["docs/y.md"]],
    ["F=a.md && echo x | tee $F", ["a.md"]],
    ["sed -i 's/a/b/' \"$F\"", [SHELL_EDIT_FILE]],
    ["F=$(pick) && sed -i 's/a/b/' \"$F\"", [SHELL_EDIT_FILE]],
    ["cat > tool.py <<'EOF'\nimport sys\nopen(sys.argv[1], 'w').write('x')\nEOF\npython3 tool.py out.md", ["tool.py"]],
    ["cat > t.md <<'EOF'\nopen('x.py', 'w')\nEOF\npython3 - <<'EOF'\nopen('y.md', 'w').write('z')\nEOF", ["t.md", "y.md"]],
    ["git mv a.js b.js", ["a.js", "b.js"]],
    ["git rm src/a.ts", ["src/a.ts"]],
    ["git rm -r src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
  ])("%s", (cmd, expected) => {
    expect(files(cmd)).toEqual(expected);
  });

  test.each([
    "sed 's/a/b/' x.js",
    "sed -n '1,5p' x.js",
    "cat x.js",
    "ls -la",
    "git status",
    "git diff > /dev/null",
    "git apply --check fix.patch",
    "git apply --stat fix.patch",
    "echo hi > /tmp/x.txt",
    "echo hi > /var/tmp/x.txt",
    "echo hi > $TMPDIR/x.txt",
    "echo hi > ${TMPDIR}/x.txt",
    "echo hi > $S/x.txt",
    "echo hi > .cache/x.txt",
    "echo hi > tmp/scratch/x.txt",
    "echo hi > ~/.cache/x.txt",
    "echo hi > run.log",
    "echo hi 2> err.txt",
    "ls 2>&1",
    "ls >&2",
    "ls &> all.txt",
    "cmd > \"$OUT\"",
    "echo hi | tee /tmp/out.txt",
    "echo hi | tee build.log",
    "sed -i 's/a/b/' /tmp/x.txt",
    "python3 - <<'EOF'\nprint(open('a.py').read())\nEOF",
    "python3 - <<'EOF'\nopen('/tmp/a.py', 'w').write('x')\nEOF",
    "python3 - <<'EOF'\np = \"/tmp/scratch/a.md\"\nopen(p, 'w').write('x')\nEOF",
    "python3 script.py",
    "echo \"a > b\"",
    "echo 'x' | grep '>'",
    "if [ 1 -gt 0 ]; then echo ok; fi",
    "git rm --cached a.js",
    "git rm -r --cached src/",
  ])("no edit: %s", (cmd) => {
    expect(files(cmd)).toEqual([]);
  });

  test("a check's own redirect and a tee fed by a check are log capture", () => {
    expect(files("bash scripts/verify-x.sh > results.json 2>&1")).toEqual([]);
    expect(files("pnpm test 2>&1 | tee results.json")).toEqual([]);
    expect(files("pnpm test > out.json && echo done > done.json")).toEqual(["done.json"]);
    expect(files("echo hi | tee x.json")).toEqual(["x.json"]);
  });

  test("never throws on odd input", () => {
    for (const c of ["", "   ", "'", "\"", ">", ">>", "sed -i", "tee", "git", "git -C", "cat <<", "perl -pi", "a >", "2>", "$(", "`"]) {
      expect(() => classifyShellMutation(c)).not.toThrow();
    }
    // @ts-expect-error wrong type on purpose
    expect(classifyShellMutation(undefined).edits).toEqual([]);
  });
});

describe("classifyShellMutation: git operations", () => {
  test.each([
    "git merge main",
    "git rebase origin/main",
    "git pull",
    "git checkout feature",
    "git -C ../w checkout -b x",
    "git stash",
    "git cherry-pick abc",
    "git mv a b",
    "git rm a b",
    "git rm -r src/",
    "git restore x",
    "git reset --hard",
    "git fetch && git merge origin/main",
    "git add -A && git merge --no-ff x",
  ])("gitOnly: %s", (cmd) => {
    expect(classifyShellMutation(cmd).gitOnly).toBe(true);
  });

  test.each(["git status", "git merge main && sed -i 's/a/b/' x.js", "git merge main && echo x > y.js", "git apply p.patch", "git merge x; tee f < g", "ls"])(
    "not gitOnly: %s",
    (cmd) => {
      expect(classifyShellMutation(cmd).gitOnly).toBe(false);
    },
  );

  test("git mv carries the gitOp flag and kinds", () => {
    expect(classifyShellMutation("git mv a.js b.js").edits).toEqual([
      { file: "a.js", gitOp: true, kind: "D" },
      { file: "b.js", gitOp: true, kind: "A" },
    ]);
  });

  test("git rm records files as deleted (D) unless --cached", () => {
    expect(classifyShellMutation("git rm src/a.ts").edits).toEqual([{ file: "src/a.ts", gitOp: true, kind: "D" }]);
    expect(classifyShellMutation("git rm -r src/").edits).toEqual([{ file: "src/", gitOp: true, kind: "D" }]);
    expect(classifyShellMutation("git rm --cached src/a.ts").edits).toEqual([]);
    expect(classifyShellMutation("git rm -r --cached src/").edits).toEqual([]);
  });
});

describe("classifyShellMutation: order and paths", () => {
  test.each<[string, string]>([
    ["sed -i s/a/b/ x.js && pnpm test", "before-check"],
    ["pnpm test && sed -i s/a/b/ x.js", "after-check"],
    ["sed -i s/a/b/ x.js; pnpm test; sed -i s/b/a/ x.js", "after-check"],
    ["sed -i s/a/b/ x.js", "unknown"],
    ["pnpm test", "unknown"],
  ])("%s => %s", (cmd, order) => {
    expect(classifyShellMutation(cmd).order).toBe(order);
  });

  test("cd is reported", () => {
    expect(classifyShellMutation("cd ../repo && sed -i s/a/b/ x.js").hasCd).toBe(true);
    expect(classifyShellMutation("sed -i s/a/b/ x.js").hasCd).toBe(false);
  });

  test("resolveTarget", () => {
    expect(resolveTarget("src/x.js", "/home/u/p", false)).toBe("/home/u/p/src/x.js");
    expect(resolveTarget("./src/../x.js", "/home/u/p", false)).toBe("/home/u/p/x.js");
    expect(resolveTarget("src/x.js", "/home/u/p", true)).toBe("src/x.js");
    expect(resolveTarget("/abs/x.js", "/home/u/p", false)).toBe("/abs/x.js");
    expect(resolveTarget("~/notes.md", "/home/u/p", false)).toBe("~/notes.md");
    expect(resolveTarget("src/x.js", null, false)).toBe("src/x.js");
    expect(resolveTarget(SHELL_EDIT_FILE, "/home/u/p", false)).toBe(SHELL_EDIT_FILE);
  });

  test("normalizePath", () => {
    expect(normalizePath("/a/b/../c/./d")).toBe("/a/c/d");
    expect(normalizePath("../a")).toBe("../a");
  });
});

describe("classifyShellMutation: history-moving git operations", () => {
  test.each(["git merge b", "git rebase main", "git pull", "git cherry-pick a", "git revert a", "git stash", "git checkout x", "git switch x", "git reset --hard", "git restore a", "git am p.mbox", "git mv a b"])(
    "%s",
    (cmd) => {
      const m = classifyShellMutation(cmd);
      expect(m.hasHistoryGitOp).toBe(true);
      expect(m.gitOnly).toBe(true);
    },
  );

  test("plain edits next to a git operation are listed separately", () => {
    const m = classifyShellMutation("git merge b && sed -i 's/x/y/' plan.md && git commit -qam m");
    expect(m.hasHistoryGitOp).toBe(true);
    expect(m.gitOnly).toBe(false);
    expect(m.edits.map((e) => [e.file, e.gitOp])).toEqual([["plan.md", false]]);
  });

  test("git rm, git apply and plain edits are not history-moving", () => {
    expect(classifyShellMutation("git rm a.js").hasHistoryGitOp).toBe(false);
    expect(classifyShellMutation("git apply p.diff").hasHistoryGitOp).toBe(false);
    expect(classifyShellMutation("sed -i s/a/b/ x.js").hasHistoryGitOp).toBe(false);
  });

  test("git mv reports its targets as git-moved", () => {
    const m = classifyShellMutation("git mv context/changes/x context/archive/x");
    expect(m.edits.map((e) => [e.file, e.gitOp, e.kind])).toEqual([["context/changes/x", true, "D"], ["context/archive/x", true, "A"]]);
  });

  test("git mv handles fewer than two operands", () => {
    expect(classifyShellMutation("git mv").edits).toEqual([{ file: SHELL_EDIT_FILE, gitOp: true, kind: "M" }]);
    expect(classifyShellMutation("git mv a.js").edits).toEqual([{ file: "a.js", gitOp: true, kind: "A" }]);
  });
});

describe("classifyShellMutation: fail closed on unresolved shell writes (review round 1)", () => {
  test.each<[string, string, string[]]>([
    ["A3 non-literal mode", "python3 - <<'EOF'\nm = 'w'\nopen('docs/a.md', m).write('x')\nEOF", [SHELL_EDIT_FILE]],
    ["A3 non-literal mode keyword", "python3 - <<'EOF'\nopen('docs/a.md', mode=m).write('x')\nEOF", [SHELL_EDIT_FILE]],
    ["A3 literal read mode is no write", "python3 - <<'EOF'\nopen('docs/a.md', 'r').read()\nEOF", []],
    ["A4 qualified receiver", "python3 - <<'EOF'\nself.p.write_text('x')\nEOF", [SHELL_EDIT_FILE]],
    ["A4 chained receiver", "python3 - <<'EOF'\nfrom pathlib import Path\nPath('a.md').resolve().write_text('x')\nEOF", [SHELL_EDIT_FILE]],
    ["A5 apostrophe in a comment inside the call", "python3 - <<'EOF'\nopen('docs/a.md', # don't\n    'w').write('x')\nEOF", ["docs/a.md"]],
    ["A5 unbalanced call", "python3 - <<'EOF'\nopen('docs/a.md', 'w'\nEOF", [SHELL_EDIT_FILE]],
    ["A6 heredoc three stages before python", "cat <<'EOF' | tr a b | python3 -\nopen('docs/a.md', 'w').write('x')\nEOF", ["docs/a.md"]],
    ["A6 piped python with a heredoc elsewhere", "cat <<'EOF' > /tmp/x\nfoo\nEOF\nprintf x | python3 -", [SHELL_EDIT_FILE]],
    ["A7 indented rebinding", "python3 - <<'EOF'\np = 'docs/a.md'\nif x:\n    p = 'src/b.ts'\nopen(p, 'w').write('x')\nEOF", [SHELL_EDIT_FILE]],
    ["A8 prefix assignment does not reach python argv", "R=docs/x.md python3 - \"$R\" <<'EOF'\nimport sys\nopen(sys.argv[1], 'w').write('x')\nEOF", [SHELL_EDIT_FILE]],
    ["A8 prefix assignment does not persist", "R=docs/x.md true && sed -i s/a/b/ \"$R\"", [SHELL_EDIT_FILE]],
    ["A8 export persists", "export R=docs/x.md && sed -i s/a/b/ \"$R\"", ["docs/x.md"]],
    ["A8 variable with glob characters stays dynamic", "export R=\"*.ts\" && sed -i s/a/b/ \"$R\"", [SHELL_EDIT_FILE]],
  ])("%s", (_name, cmd, expected) => {
    expect(files(cmd)).toEqual(expected);
  });

  test("H2: a cut list of edits is opaque", () => {
    const many = Array.from({ length: 25 }, (_, i) => `d${i}.md`).join(" ");
    const m = classifyShellMutation(`git merge b && sed -i s/a/b/ ${many}`);
    expect(m.edits).toHaveLength(20);
    expect(m.opaque).toBe(true);
  });

  test.each([
    ["git merge b && sed -i 's/x/y/' plan.md && git commit -qam m", false],
    ["cd sub && git merge b && sed -i s/x/y/ plan.md && git status", false],
    ["git merge b && echo done && ls && sleep 1 && true", false],
    ["git merge b && sed -i s/x/y/ plan.md && cp /tmp/x src/a.ts", true],
    ["git merge b && sed -i s/x/y/ plan.md && python3 -c \"open('src/a.ts','w')\"", true],
    ["git merge b && sed -i s/x/y/ plan.md && install a b", true],
    ["git merge b && sed -i s/x/y/ plan.md && echo x > \"$UNSET\"", true],
  ])("H1 opaque: %s", (cmd, opaque) => {
    expect(classifyShellMutation(cmd).opaque).toBe(opaque);
  });
});

describe("classifyShellMutation: read-only segments do not make a mixed command opaque", () => {
  const mixed = (seg: string) => `git merge b && sed -i s/x/y/ plan.md && ${seg}`;
  test.each([
    "tail -5 log", "head -3 f", "grep -r x .", "egrep x f", "rg x", "cut -d: -f1 f", "wc -l f", "tr a b", "sort f", "uniq f", "diff a b", "cmp a b",
    "jq . f", "column -t f", "nl f", "basename a", "dirname a", "realpath a", "readlink a", "stat a", "file a", "du -sh .", "df -h", "date", "which git",
    "type git", "command -v git", "whoami", "hostname", "sleep 1", "sed -n 1p f", "sed s/a/b/ f", "for f in a b; do echo $f; done", "if true; then true; fi",
    "while false; do break; done", "case x in x) true;; esac", "exit 0", "mkdir -p d", "rmdir d", "git branch -D x", "git push origin x", "git fetch",
    "git remote -v", "git rev-parse HEAD", "git rev-list HEAD", "git merge-base a b", "git show-ref", "git grep x", "git ls-files", "git worktree add ../w",
    "git worktree remove ../w", "git worktree prune", "git worktree list", "git tag v1", "git describe", "git config --get user.name", "herdr pane list",
  ])("safe: %s", (seg) => {
    expect(classifyShellMutation(mixed(seg)).opaque).toBe(false);
  });

  test.each([
    "cp a b", "rm a", "mv a b", "install a b", "python3 x.py", "node x.js", "bash x.sh", "sh x.sh", "uv run x", "pnpm publish", "npm run x", "npx x", "make all",
    "awk '{print}' f", "perl x.pl", "frobnicate", "sed -n 'w out' f", "sed 's/a/b/w out' f", "git config user.name x",
    "git worktree move a b", "git clean -fd", "echo x > $UNSET", "grep x f > $UNSET",
  ])("kept opaque: %s", (seg) => {
    expect(classifyShellMutation(mixed(seg)).opaque).toBe(true);
  });
});

describe("classifyShellMutation: write options of read-only tools, fd redirects (review round 2)", () => {
  const mixed = (seg: string) => `git merge b && sed -i s/x/y/ plan.md && ${seg}`;
  test.each([
    "sort -o out.ts in", "sort --output=out.ts in", "sort -ro out.ts in", "sort -oout.ts in", "sort --output out.ts in", "uniq in out.ts", "uniq -c in out.ts", "uniq -f 1 in out.ts",
    "git diff --output=out.ts", "git show --output out.ts HEAD", "git log --output=out.ts",
    "sed -n 'W out.ts' f", "sed e f", "sed 's/a/b/e' f", "sed -n 's/a/b/w out.ts' f",
    "echo x &> out.ts", "echo x &>> out.ts", "echo x >& out.ts", "echo x 2> out.ts", "echo x 2>> out.ts", "echo x 2> \"$UNSET\"", "echo x 3> out.ts",
  ])("opaque: %s", (seg) => {
    expect(classifyShellMutation(mixed(seg)).opaque).toBe(true);
  });

  test.each([
    "sort in", "sort -r -k2 in", "uniq in", "uniq -c in", "git diff", "git show HEAD", "sed -n '/e/p' f", "sed -n 's/a/b/gp' f",
    "echo x 2>&1", "echo x >&2", "echo x 2>/dev/null", "echo x &> /dev/null", "echo x 2> err.log", "echo x 2> notes.md", "ls >&-",
  ])("still known: %s", (seg) => {
    expect(classifyShellMutation(mixed(seg)).opaque).toBe(false);
  });
});

describe("classifyShellMutation: cd and variable chains (status-accuracy-4)", () => {
  test.each<[string, string[]]>([
    ["cd \"$UNKNOWN\"; sed -i x a.ts", [SHELL_EDIT_FILE]],
    ["cd - && sed -i x a.ts", [SHELL_EDIT_FILE]],
    ["cd $(pwd)/x && sed -i x a.ts", [SHELL_EDIT_FILE]],
    ["cd $(pwd) && sed -i x a.ts", [SHELL_EDIT_FILE]],
    ["cd ~ && sed -i x a.ts", [SHELL_EDIT_FILE]],
    ["S=$OTHER/f; cd $S && sed -i x a.ts", [SHELL_EDIT_FILE]],
    ["(cd /tmp/s && sed -i x a.ts); sed -i x b.ts", ["/tmp/s/a.ts", "b.ts"]],
    ["(cd /tmp/s; sed -i x a.ts); sed -i x b.ts", [SHELL_EDIT_FILE, "b.ts"]],
    // A `( … )` subshell does not keep the directory change. The outer file stays on the session cwd.
    ["(cd /tmp/s); sed -i x b.ts", ["b.ts"]],
    ["pushd /tmp/s && sed -i x a.ts", ["/tmp/s/a.ts"]],
    ["cd /tmp/s && cd wt && sed -i x a.ts", ["/tmp/s/wt/a.ts"]],
    ["cd /tmp/s && cd ../t && sed -i x a.ts", ["/tmp/t/a.ts"]],
    ["cd \"$UNKNOWN\" && sed -i x /abs/a.ts", ["/abs/a.ts"]],
    ["S=/tmp/x; R=$S/y; cd \"$R\" && sed -i x a.ts", ["/tmp/x/y/a.ts"]],
    ["S=/tmp/claude-1000/x/scratchpad; cd $S/wt && sed -i x src/a.ts", ["/tmp/claude-1000/x/scratchpad/wt/src/a.ts"]],
    ["sed -i x a.ts && cd \"$UNKNOWN\"", ["a.ts"]],
    ["cd sub && sed -i x src/b.ts", ["src/b.ts"]],
  ])("%s", (cmd, expected) => {
    expect(files(cmd)).toEqual(expected);
  });

  test("a subshell cd does not move the next command, and a relative cd keeps its base", () => {
    const sub = classifyShellMutation("(cd /tmp/s && sed -i x a.ts); sed -i x b.ts");
    expect(sub.edits.map((e) => [e.file, e.baseDir])).toEqual([
      ["/tmp/s/a.ts", undefined],
      ["b.ts", ""],
    ]);
    const rel = classifyShellMutation("cd sub && sed -i x src/b.ts");
    expect(rel.hasCd).toBe(true);
    expect(rel.edits).toEqual([{ file: "src/b.ts", gitOp: false, kind: "M", baseDir: "sub" }]);
    const before = classifyShellMutation("sed -i x a.ts && cd \"$UNKNOWN\"");
    expect(before.edits).toEqual([{ file: "a.ts", gitOp: false, kind: "M", baseDir: "" }]);
  });

  test("a redirect on cd is applied in the old directory", () => {
    const m = classifyShellMutation("cd /tmp/s > out.md && sed -i x a.ts");
    expect(m.edits).toEqual([
      { file: "out.md", gitOp: false, kind: "M", baseDir: "" },
      { file: "/tmp/s/a.ts", gitOp: false, kind: "M" },
    ]);
  });

  test("popd poisons later relative targets", () => {
    expect(files("popd && sed -i x a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(classifyShellMutation("popd && sed -i x a.ts").hasCd).toBe(true);
  });

  test("git rm stays git-made beside a plain sed", () => {
    const m = classifyShellMutation("git rm old/a.ts && sed -i 's/x/y/' src/a.ts");
    expect(m.opaque).toBe(false);
    expect(m.gitOnly).toBe(false);
    expect(m.edits).toEqual([
      { file: "old/a.ts", gitOp: true, kind: "D" },
      { file: "src/a.ts", gitOp: false, kind: "M" },
    ]);
  });
});

describe("classifyShellMutation: env slots, frozen install, gate scripts, python -c (status-accuracy-4)", () => {
  const mixed = (seg: string) => `git merge b && sed -i s/x/y/ plan.md && ${seg}`;

  test("env $E / env \"$E\" of NAME=value words is a git operation", () => {
    for (const cmd of [
      'E="GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=y" && env $E git merge b',
      'E="GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=y" && env "$E" git merge b',
    ]) {
      const m = classifyShellMutation(cmd);
      expect(m.gitOnly, cmd).toBe(true);
      expect(m.hasHistoryGitOp, cmd).toBe(true);
      expect(m.opaque, cmd).toBe(false);
    }
  });

  test("an env value that is not only NAME=value stays opaque", () => {
    const m = classifyShellMutation('E="x y" && git merge b && sed -i s/x/y/ plan.md && env $E true');
    expect(m.opaque).toBe(true);
  });

  test.each([
    "npm ci",
    "npm ci --ignore-scripts",
    "npm --prefix packages/core ci",
    "pnpm install --frozen-lockfile",
    "pnpm --frozen-lockfile install",
    "pnpm -C packages/core install --frozen-lockfile",
    "pnpm i --frozen-lockfile",
    "yarn install --frozen-lockfile",
    "yarn install --immutable",
    "yarn --immutable i",
    "corepack pnpm install --frozen-lockfile",
    "node scripts/gate.mjs --base main",
    "cd scripts && node gate.mjs",
  ])("safe: %s", (seg) => {
    expect(classifyShellMutation(mixed(seg)).opaque).toBe(false);
  });

  test.each([
    "npm install",
    "pnpm install",
    "yarn install",
    "pnpm i",
    // C15: a node option that loads code is not GATEREAD, including the forms C9 used to skip.
    "node -r x/register scripts/gate.mjs",
    "node --require ./reg scripts/verify-run.mjs",
    "node scripts/build.mjs",
    "cd sub && node scripts/gate.mjs",
    "cd /repo && node scripts/gate.mjs",
    "node /home/user/project/scripts/gate.mjs",
    "python3 -c \"import os; os.system('sed -i s/x/y/ src/a.ts')\"",
    "python3 -c \"import shutil\"",
    "python3 -c \"from shutil import copy\"",
    "python3 -c \"import os; os.rename('a.ts', 'b.ts')\"",
    "python3 -c \"$SRC\"",
    // C12: `import os` is off the allow-list, including a read of os.path / os.getcwd (overrides C1).
    "python3 -c \"import os; print(os.path.join('a', 'b'))\"",
    "python3 -c \"import os; print(os.getcwd())\"",
    "python3 -c \"import os; print(os.environ.get('X'))\"",
    "python3 -c \"from os import path; print(path.join('a', 'b'))\"",
    "python3 -c \"import os.path\"",
    "python3 -c \"import json, os\"",
    "python3 -c \"import io; print(1)\"",
    "python3 -c \"import os as o; o.system('sed -i s/x/y/ src/a.ts')\"",
    "python3 -c \"import os as o; o.rename('a.ts', 'b.ts')\"",
    "python3 -c \"getattr(x, 'system')('true')\"",
    "python3 -c \"json.dump(d, f)\"",
    // C16: any interpreter option before the script operand is not GATEREAD.
    "python3 -u scripts/gate.py",
    "python3 -uBI scripts/validate_all.py",
    "python3 -c \"import platform; print(platform.system())\"",
    "python3 -c 'from pathlib import Path as P; (P(\"a\")/\"b\").write_text(\"x\")'",
    // C17: every `python -c` is opaque, including the old allow-list.
    "python3 -c \"print('ab'.replace('a', 'b'))\"",
    "python3 -c \"print(open('a.ts', 'r').read())\"",
    "python3 -c \"print(1)\"",
    "python3 -c \"open('/tmp/x','w').write('x')\"",
    "python3 -c \"print('exec(')\"",
    "python3 -c \"print('import os')\"",
    "python3 -c \"print(1)  # import os; open('a.ts','w')\"",
  ])("kept opaque: %s", (seg) => {
    expect(classifyShellMutation(mixed(seg)).opaque).toBe(true);
  });

  test("C17: python -c is opaque and records no edit, as on main", () => {
    const h1 = classifyShellMutation("git merge b && sed -i s/x/y/ plan.md && python3 -c \"open('src/a.ts','w')\"");
    expect(h1.opaque).toBe(true);
    expect(h1.edits.map((e) => e.file)).toEqual(["plan.md"]);
    for (const cmd of [
      "python3 -c \"open('src/a.ts','w').write('x')\"",
      "python3 -c \"open(p,'w')\"",
      "python3 -c \"print(1)\"",
      "F=src/a.ts && python3 -c \"open('$F','w').write('x')\"",
      "python3 -c \"\n    p = 'src/a.ts'\n    open(p, 'w').write('x')\n\"",
    ]) {
      expect(files(cmd), cmd).toEqual([]);
      expect(classifyShellMutation(cmd).opaque, cmd).toBe(true);
    }
  });

  test("python -c extra write APIs are edits, and an escape wins over a parsed write", () => {
    // C16: pathlib, unlink and exec are outside the allow-list: opaque, and the write is not trusted.
    expect(files("python3 -c \"from pathlib import Path; Path('a.ts').unlink()\"")).toEqual([]);
    expect(classifyShellMutation(mixed("python3 -c \"from pathlib import Path; Path('a.ts').unlink()\"")).opaque).toBe(true);
    const both = classifyShellMutation("python3 -c \"open('src/a.ts','w').write('x'); exec('1')\"");
    expect(both.opaque).toBe(true);
    expect(both.edits).toEqual([]);
    const mixedEscape = classifyShellMutation(mixed("python3 -c \"open('src/a.ts','w').write('x'); exec('1')\""));
    expect(mixedEscape.opaque).toBe(true);
    expect(mixedEscape.edits.map((e) => e.file)).not.toContain("src/a.ts");
  });

  test("C17: python -c allow-list is withdrawn; heredocs stay scanned", () => {
    const ok = (seg: string) => classifyShellMutation(mixed(seg));
    // C17: `import json; print(json.dumps({}))` is opaque. The sed beside it is still the only edit.
    const dumps = ok("python3 -c \"import json; print(json.dumps({}))\"");
    expect(dumps.opaque).toBe(true);
    expect(dumps.edits.map((e) => e.file)).toEqual(["plan.md"]);
    // C16: an alias, and any module other than json / re / math, is opaque.
    const aliased = ok("python3 -c \"import json as j; print(j.dumps({}))\"");
    expect(aliased.opaque).toBe(true);
    const hashed = ok("python3 -c \"import hashlib; print(hashlib.sha256(b'x').hexdigest())\"");
    expect(hashed.opaque).toBe(true);
    const machine = ok("python3 -c \"import platform; print(platform.machine())\"");
    expect(machine.opaque).toBe(true);
    expect(files("python3 -c \"print(1)\"")).toEqual([]);
    expect(files("python3 -c \"import json; print(json.dumps({}))\"")).toEqual([]);
    expect(files("python3 -c \"open('/tmp/x','w').write('x')\"")).toEqual([]);
    const chained = classifyShellMutation("python3 -c \"open('src/a.ts','w').write('x')\"");
    expect(chained.opaque).toBe(true);
    expect(chained.edits.map((e) => e.file)).toEqual([]);
    // C16: write_text, dump and an unbound name are outside the allow-list, so nothing is recorded.
    const pathOnly = classifyShellMutation("python3 -c \"Path('notes.md').write_text('x')\"");
    expect(pathOnly.opaque).toBe(true);
    expect(pathOnly.edits.map((e) => e.file)).toEqual([]);

    const dumped = classifyShellMutation("python3 -c \"json.dump(d, open('x.json','w'))\"");
    expect(dumped.opaque).toBe(true);
    expect(dumped.edits.map((e) => e.file)).toEqual([]);
    const dumpedMixed = ok("python3 -c \"json.dump(d, open('x.json','w'))\"");
    expect(dumpedMixed.opaque).toBe(true);
    expect(dumpedMixed.edits.map((e) => e.file)).not.toContain("x.json");

    // A from-import is outside the allow-list: opaque, and the write is not trusted.
    const pathWrite = ok("python3 -c \"from pathlib import Path; Path('a.ts').write_text('x')\"");
    expect(pathWrite.opaque).toBe(true);
    expect(pathWrite.edits.map((e) => e.file)).not.toContain("a.ts");

    // An alias is a from-import: opaque, and no edit is trusted.
    const alias = "python3 -c 'from pathlib import Path as P; (P(\"a\")/\"b\").write_text(\"x\")'";
    const aliasOnly = classifyShellMutation(alias);
    expect(aliasOnly.opaque).toBe(true);
    expect(aliasOnly.edits.map((e) => e.file)).toEqual([]);
    expect(ok(alias).opaque).toBe(true);
    expect(ok(alias).edits.map((e) => e.file)).not.toContain("a/b");

    // Heredocs stay on the old writer scan (C12 does not apply the allow-list there).
    const heredoc = "python3 - <<'EOF'\nfrom pathlib import Path as P\n(P('a')/'b').write_text('x')\nEOF";
    expect(files(heredoc)).toEqual([SHELL_EDIT_FILE]);
    expect(classifyShellMutation(heredoc).opaque).toBe(false);
    expect(classifyShellMutation(mixed(heredoc)).opaque).toBe(false);
  });

  test("a gate script is not opaque and its redirect still writes", () => {
    const m = classifyShellMutation("node scripts/gate.mjs > out.md");
    expect(m.opaque).toBe(false);
    expect(m.edits).toEqual([{ file: "out.md", gitOp: false, kind: "M" }]);
    expect(m.order).toBe("unknown");
    const scratch = classifyShellMutation("S=/tmp/claude-1000/x/scratchpad && node scripts/gate.mjs > \"$S/g.txt\"");
    expect(scratch.opaque).toBe(false);
    expect(scratch.edits).toEqual([]);
  });

  test("C13: gate scripts after an absolute cd into the repo or a sibling worktree", () => {
    const repo = "/abs/repo";
    const at = (cmd: string, root?: string) => classifyShellMutation(cmd, undefined, root);
    const sibling = "cd /abs/repo-x && node scripts/gate.mjs --merge > $S/g.txt";
    // Scratch redirect, no work-tree edit. Non-opaque only once that directory is a sibling worktree.
    const bare = at(sibling, repo);
    expect(bare.opaque).toBe(false);
    expect(bare.edits).toEqual([]);
    // A parsed edit keeps the opaque flag, which an absolute cd used to force on.
    expect(at(mixed(sibling), repo).opaque).toBe(false);
    expect(at(mixed("cd /abs/repo && node scripts/gate.mjs"), repo).opaque).toBe(false);
    // C17: only `scripts/gate.mjs` is GATEREAD. `validate_all.py` is opaque.
    expect(at(mixed("cd /abs/repo/pkg && node ./scripts/validate_all.py"), repo).opaque).toBe(true);
    expect(at("cd /tmp/other && node scripts/gate.mjs", repo).opaque).toBe(true);
    expect(at("cd /abs/repo && node scripts/build.mjs", repo).opaque).toBe(true);
    expect(at(mixed("cd /tmp/other && node scripts/gate.mjs"), repo).opaque).toBe(true);
    expect(at(mixed("cd /abs/repo && node scripts/build.mjs"), repo).opaque).toBe(true);
    // No known repo root: an absolute cd still refuses the script.
    expect(at(mixed("cd /abs/repo-x && node scripts/gate.mjs")).opaque).toBe(true);
  });

  test("C17: a python -c read/replace/write is opaque and records no edit", () => {
    const src = "p='docs/a.md';s=open(p).read();s=s.replace('a','b');open(p,'w').write(s)";
    const cmd = `python3 -c ${JSON.stringify(src)}`;
    const m = classifyShellMutation(cmd);
    expect(m.opaque).toBe(true);
    expect(m.edits.map((e) => e.file)).toEqual([]);
    expect(classifyShellMutation(mixed(cmd)).opaque).toBe(true);
    expect(classifyShellMutation(mixed(cmd)).edits.map((e) => e.file)).toEqual(["plan.md"]);
    const readMode = `python3 -c ${JSON.stringify("p='docs/a.md';s=open(p, 'rb').read();open(p,'w').write(s)")}`;
    expect(classifyShellMutation(readMode).opaque).toBe(true);
    expect(files(readMode)).toEqual([]);
    const dynamic = classifyShellMutation(`python3 -c ${JSON.stringify("open(p, m)")}`);
    expect(dynamic.opaque).toBe(true);
    expect(dynamic.edits.map((e) => e.file)).toEqual([]);
    const pathReplace = classifyShellMutation(`python3 -c ${JSON.stringify("from pathlib import Path; Path(p).replace(q)")}`);
    expect(pathReplace.opaque).toBe(true);
    expect(pathReplace.edits.map((e) => e.file)).toEqual([]);
  });
});

describe("review round 1: directory hiders, python -c escapes, gate options, heredocs, scratch ..", () => {
  const mixed = (seg: string) => `git merge b && sed -i s/x/y/ plan.md && ${seg}`;

  test("eval, source, dot, builtin, command and exec poison later relative targets", () => {
    const rel = "sed -i 's/a/b/' src/a.ts";
    for (const hide of [
      `eval "cd /home/user/project"`,
      "source env.sh",
      ". ./env.sh",
      "builtin cd /home/user/project",
      "command cd /home/user/project",
      "exec cd /home/user/project",
    ]) {
      expect(files(`cd /tmp/x; ${hide}; ${rel}`), hide).toEqual([SHELL_EDIT_FILE]);
    }
    // The hider's own relative edit is unresolved too (`command` may be `command cd`).
    expect(files("cd /tmp/x; command sed -i 's/a/b/' src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files(`eval "cd /tmp/x"; sed -i 's/a/b/' /home/user/project/src/a.ts`)).toEqual(["/home/user/project/src/a.ts"]);
  });

  test("a subshell hider does not leak, and pnpm exec is not the shell builtin", () => {
    expect(files(`(eval "cd /home/user/project"; sed -i 's/a/b/' src/a.ts); sed -i 's/a/b/' b.ts`)).toEqual([SHELL_EDIT_FILE, "b.ts"]);
    const kept = classifyShellMutation("cd sub && pnpm exec vitest && sed -i x a.ts");
    expect(kept.edits).toEqual([{ file: "a.ts", gitOp: false, kind: "M", baseDir: "sub" }]);
    expect(kept.opaque).toBe(false);
  });

  test("python -c module subscript, dunder, private attribute and frame names are opaque", () => {
    for (const seg of [
      `python3 -c "import sys; sys.modules['subprocess'].run(['sh','-c','echo > src/c.ts'])"`,
      `python3 -c "import sys; sys.modules['os'].execvp('sed', ['sed','-i','s/a/b/','src/a.ts'])"`,
      `python3 -c "[c for c in ().__class__.__base__.__subclasses__() if c.__name__=='Popen'][0](['sed'])"`,
      `python3 -c "import random; random._os.execvp('sed', ['sed','-i','s/a/b/','src/a.ts'])"`,
      `python3 -c "x = __globals__['sy'+'stem']"`,
      `python3 -c "import sys; print(sys.version)"`,
      `python3 -c "x = f_code"`,
      `python3 -c "import json; print(json.dumps({}).gi_frame)"`,
    ]) {
      expect(classifyShellMutation(mixed(seg)).opaque, seg).toBe(true);
    }
  });

  test("python -c documented safe calls stay non-opaque", () => {
    const ok = (seg: string) => classifyShellMutation(mixed(seg));
    // C17: the documented-safe allow-list is withdrawn. `json.dumps` is opaque, as on main.
    expect(ok(`python3 -c "import json; print(json.dumps({}))"`).opaque).toBe(true);
    // C16: aliases, other modules, from-import, sys and an unbound open are opaque.
    expect(ok(`python3 -c "import json as j; print(j.dumps({}))"`).opaque).toBe(true);
    expect(ok(`python3 -c "import hashlib; print(hashlib.sha256(b'x').hexdigest())"`).opaque).toBe(true);
    expect(ok(`python3 -c "import platform; print(platform.machine())"`).opaque).toBe(true);
    expect(ok(`python3 -c "import sys; print(1)"`).opaque).toBe(true);
    expect(ok(`python3 -c "from json import dumps; print(dumps({}))"`).opaque).toBe(true);
    expect(files(`python3 -c "open(p,'w')"`)).toEqual([]);
    expect(classifyShellMutation(mixed(`python3 -c "open(p,'w')"`)).opaque).toBe(true);
  });

  test("node options that take or load code before a gate script are not GATEREAD", () => {
    for (const seg of [
      `node --eval="require('fs').writeFileSync('src/c.ts','x')" scripts/gate.mjs`,
      "node --print=1 scripts/gate.mjs",
      "node --print scripts/gate.mjs",
      "node -e scripts/gate.mjs",
      "node -p scripts/gate.mjs",
      "node -r x/register scripts/gate.mjs",
      "node --require ./reg scripts/verify-run.mjs",
      "node --require=/tmp/x.cjs scripts/gate.mjs",
      "node --require /tmp/x.cjs scripts/gate.mjs",
      "node -r./x.cjs scripts/gate.mjs",
      "node --import=./x.mjs scripts/gate.mjs",
      "node --import ./x.mjs scripts/gate.mjs",
      "node --loader=./x.mjs scripts/gate.mjs",
      "node --loader ./x.mjs scripts/gate.mjs",
      "node --experimental-loader=./x.mjs scripts/gate.mjs",
      "node --experimental-loader ./x.mjs scripts/gate.mjs",
      `python3 -c "print(1)" scripts/gate.py`,
      "python3 -m json.tool scripts/gate.py",
    ]) {
      expect(classifyShellMutation(mixed(seg)).opaque, seg).toBe(true);
    }
    expect(classifyShellMutation(mixed("node scripts/gate.mjs --base main")).opaque).toBe(false);
    // C16: no interpreter option may precede the script operand.
    expect(classifyShellMutation(mixed("python3 -u scripts/gate.py")).opaque).toBe(true);
    expect(classifyShellMutation(mixed("python3 -uBI scripts/validate_all.py")).opaque).toBe(true);
    // C17: `python -c` is opaque even when the source only prints.
    expect(classifyShellMutation(mixed(`python3 -c "print(1)"`)).opaque).toBe(true);
  });

  test("npm install is not frozen, npm ci and pnpm/yarn frozen still are", () => {
    for (const seg of ["npm install --frozen-lockfile", "npm i --frozen-lockfile", "npm install --ignore-scripts", "npm i --ignore-scripts"]) {
      expect(classifyShellMutation(mixed(seg)).opaque, seg).toBe(true);
    }
    for (const seg of ["npm ci", "npm ci --ignore-scripts", "pnpm install --frozen-lockfile", "pnpm i --immutable", "yarn install --immutable"]) {
      expect(classifyShellMutation(mixed(seg)).opaque, seg).toBe(false);
    }
  });

  test("dash-less python heredocs record a code write, a doc write and a pathlib write", () => {
    const bodies: [string, string][] = [
      ["p = \"src/a.ts\"\nopen(p, 'w').write('x')", "src/a.ts"],
      ["p = \"docs/x.md\"\nopen(p, 'w').write('x')", "docs/x.md"],
      ["from pathlib import Path\nPath(\"src/a.ts\").write_text('x')", "src/a.ts"],
    ];
    for (const head of ["python3 <<'EOF'", "python <<'EOF'", "python3.11 <<'EOF'", "python3 -B <<EOF"]) {
      for (const [body, file] of bodies) {
        const cmd = `${head}\n${body}\nEOF`;
        const m = classifyShellMutation(cmd);
        expect(m.edits.map((e) => e.file), cmd).toEqual([file]);
        expect(m.opaque, cmd).toBe(false);
      }
    }
  });

  test(".. and ./ in an absolute path are normalised before the scratch test", () => {
    expect(files("sed -i 's/a/b/' /tmp/../home/user/project/src/a.ts")).toEqual(["/home/user/project/src/a.ts"]);
    expect(files("sed -i 's/a/b/' /tmp/./../home/user/project/src/a.ts")).toEqual(["/home/user/project/src/a.ts"]);
    // C17: a non-literal path that contains `..` is unresolved, whatever its prefix.
    expect(files(`V=/tmp/s; sed -i 's/a/b/' "$V/../../../home/user/project/src/a.ts"`)).toEqual([SHELL_EDIT_FILE]);
  });
});

describe("C16: allow-lists instead of deny-lists", () => {
  const mixed = (seg: string) => `git merge b && sed -i s/x/y/ plan.md && ${seg}`;

  test("C16: vars(sys) is opaque", () => {
    const seg = `python3 -c "import sys; vars(sys)['modules']['os'].link('a','b')"`;
    const alone = classifyShellMutation(seg);
    expect(alone.opaque).toBe(true);
    expect(alone.edits).toEqual([]);
    const withEdit = classifyShellMutation(mixed(seg));
    expect(withEdit.opaque).toBe(true);
    expect(withEdit.edits.map((e) => e.file)).toEqual(["plan.md"]);
  });

  test("C16: a node option before the gate script is not GATEREAD", () => {
    for (const seg of [
      `node --conditions scripts/gate.mjs -e "require('fs').writeFileSync('src/a.ts','x')"`,
      `node -C /tmp scripts/gate.mjs -e "require('fs').writeFileSync('src/a.ts','x')"`,
      `node --conditions=custom scripts/gate.mjs -e "1"`,
      `node --conditions=x -e "1" scripts/gate.mjs`,
    ]) {
      const m = classifyShellMutation(seg);
      expect(m.opaque, seg).toBe(true);
      expect(m.edits, seg).toEqual([]);
      expect(classifyShellMutation(mixed(seg)).opaque, seg).toBe(true);
    }
    // Words after the script are arguments. They are not scanned for node options.
    expect(classifyShellMutation(mixed(`node scripts/gate.mjs -e "1"`)).opaque).toBe(false);
    expect(classifyShellMutation(mixed("node scripts/gate.mjs --base main")).opaque).toBe(false);
  });

  test("C16: a temp-variable path that climbs with .. is a code edit", () => {
    expect(files("sed -i 's/a/b/' $S/../../x/src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("sed -i 's/a/b/' $S/../../../../home/jack/git/lgtm-review-status-accuracy-4/src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("sed -i 's/a/b/' $TMPDIR/../../../home/jack/git/lgtm-review-status-accuracy-4/src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("sed -i 's/a/b/' $S/foo/../../x/src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("sed -i 's/a/b/' $S/wt/a.ts")).toEqual([]);
    // C17: any non-literal `..` is unresolved, even when it would normalise back under the temp variable.
    expect(files("sed -i 's/a/b/' $S/foo/../bar.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo hi > $S/../../x/src/a.ts")).toEqual([SHELL_EDIT_FILE]);
  });

  test("C16: a hider after if or until makes the directory unknown", () => {
    for (const cmd of [
      "if source ./x.sh; then sed -i 's/a/b/' src/a.ts; fi",
      "elif source ./x.sh; then sed -i 's/a/b/' src/a.ts; fi",
      "while source ./x.sh; do sed -i 's/a/b/' src/a.ts; break; done",
      `until eval "cd /tmp/x"; do sed -i 's/a/b/' src/a.ts; break; done`,
      "time source ./x.sh; sed -i 's/a/b/' src/a.ts",
      "\\source ./x.sh && sed -i 's/a/b/' src/a.ts",
      "FOO=1 eval 'cd /tmp/x'; sed -i 's/a/b/' src/a.ts",
    ]) {
      const m = classifyShellMutation(cmd);
      expect(m.edits.map((e) => e.file), cmd).toEqual([SHELL_EDIT_FILE]);
      expect(m.hasCd, cmd).toBe(true);
    }
  });

  test("C16: read-only python -c outside the allow-list stays opaque, math.pi does not", () => {
    for (const seg of [
      `python3 -c "import json,sys; print(json.dumps(sys.argv))"`,
      `python3 -c "import sys,json; print(json.load(sys.stdin))"`,
      `python3 -c "import datetime; print(datetime.datetime.now().isoformat())"`,
      `python3 -c "from json import dumps; print(dumps.__globals__)"`,
    ]) {
      const m = classifyShellMutation(`${seg} && sed -i 's/a/b/' src/a.ts`);
      expect(m.opaque, seg).toBe(true);
      expect(m.edits.map((e) => e.file), seg).toEqual(["src/a.ts"]);
    }
    // C17: `math` and `re` are no longer an allow-list. The sed is still the only edit.
    const pi = classifyShellMutation(`python3 -c "import math; print(math.pi)" && sed -i 's/a/b/' src/a.ts`);
    expect(pi.opaque).toBe(true);
    expect(pi.edits.map((e) => e.file)).toEqual(["src/a.ts"]);
    const compiled = classifyShellMutation(`python3 -c "import re; print(re.compile('a').findall('a'))" && sed -i 's/a/b/' src/a.ts`);
    expect(compiled.opaque).toBe(true);
    expect(compiled.edits.map((e) => e.file)).toEqual(["src/a.ts"]);
  });

  test("wrappers before eval or source hide the directory", () => {
    const rel = "sed -i s/a/b/ src/a.ts";
    for (const hide of [
      'nice eval "cd /repo"',
      "sudo source f",
      "env A=1 source f",
      "nohup eval x",
      "time -p source f",
      "timeout 5 source f",
      "sudo -u root source f",
      'nice -n 10 eval "cd /repo"',
      "flock /tmp/l source f",
      "ionice -c 3 source f",
      "setsid source f",
      "stdbuf -o0 source f",
      "corepack source f",
      "nice command sed -i s/a/b/ src/a.ts",
    ]) {
      const cmd = hide.startsWith("nice command") ? `cd /tmp/x; ${hide}` : `cd /tmp/x; ${hide}; ${rel}`;
      const m = classifyShellMutation(cmd);
      expect(m.edits.map((e) => e.file), cmd).toEqual([SHELL_EDIT_FILE]);
      expect(m.hasCd, cmd).toBe(true);
    }
    for (const cmd of ["nice command -v node && sed -i s/a/b/ src/a.ts", "sudo command -V node && sed -i s/a/b/ src/a.ts"]) {
      const m = classifyShellMutation(cmd);
      expect(m.edits, cmd).toEqual([{ file: "src/a.ts", gitOp: false, kind: "M" }]);
      expect(m.hasCd, cmd).toBe(false);
    }
  });

  test("C16: command -v does not hide the directory", () => {
    for (const cmd of ["command -v node && sed -i 's/a/b/' src/a.ts", "command -V node && sed -i 's/a/b/' src/a.ts"]) {
      const m = classifyShellMutation(cmd);
      expect(m.edits, cmd).toEqual([{ file: "src/a.ts", gitOp: false, kind: "M" }]);
      expect(m.hasCd, cmd).toBe(false);
      expect(m.opaque, cmd).toBe(false);
    }
    expect(files("command sed -i 's/a/b/' src/a.ts")).toEqual([SHELL_EDIT_FILE]);
  });

  test("C16: a relative edit path is stored canonicalised", () => {
    expect(classifyShellMutation("sed -i 's/a/b/' scratch/../src/a.ts").edits).toEqual([{ file: "src/a.ts", gitOp: false, kind: "M" }]);
    expect(files("sed -i 's/a/b/' src/../scratch/a.ts")).toEqual([]);
    expect(classifyShellMutation("git rm -r src/").edits).toEqual([{ file: "src/", gitOp: true, kind: "D" }]);
  });
});

describe("C17: python -c withdrawn, cd only on && / || exit, exact gate, temp climb, scratch files", () => {
  const mixed = (seg: string) => `git merge b && sed -i s/x/y/ plan.md && ${seg}`;
  const opaqueNoEdit = (cmd: string): void => {
    const m = classifyShellMutation(cmd);
    expect(m.opaque, cmd).toBe(true);
    expect(m.edits.map((e) => e.file), cmd).not.toContain("src/a.ts");
    expect(m.edits.map((e) => e.file), cmd).not.toContain("packages/core/src/x.ts");
  };

  test("C17: python -c bypasses are opaque and record no code edit", () => {
    for (const cmd of [
      `python3 -c "x=open; x('src/a.ts','w').write('1')"`,
      `python3 -c "w=open; w('src/a.ts','w').write('1')"`,
      `python3 -c "len=open; len('src/a.ts','w').write('1')"`,
      `python3 -c "print=open; print('src/a.ts','w').write('1')"`,
      `python3 -c "(open)('src/a.ts','w').write('1')"`,
      `python3 -c "[open][0]('src/a.ts','w').write('1')"`,
      `python3 -c 'dict(exec=0); exec("open(\\"src/a.ts\\",\\"w\\").write(\\"x\\")")'`,
      `python3 -c "o = open; o('packages/core/src/x.ts','w').write('y')"`,
      `python3 -c "eval = eval; eval('x=1')"`,
      `python3 -c "import json; print(json.dumps({}))"`,
      `python3 -c "import math; print(math.pi)"`,
      `python3 -c "import re; print(re.compile('a').findall('a'))"`,
      `python3 -c "print(1)"`,
      `python3 -c "open('src/a.ts','w').write('x')"`,
      `python3 -c "p='/tmp/x'\nif 1:\n p='src/a.ts'\nopen(p,'w').write('x')"`,
    ]) {
      opaqueNoEdit(cmd);
    }
    const beside = classifyShellMutation(mixed(`python3 -c "x=open; x('src/a.ts','w').write('1')"`));
    expect(beside.opaque).toBe(true);
    expect(beside.edits.map((e) => e.file)).toEqual(["plan.md"]);
  });

  test("C17: a temp path with a repeated slash or a non-literal .. is a code edit", () => {
    expect(files("echo x > $S//../src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > ${TMPDIR}//../../src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > $S//../packages/core/src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > /tmp/$X/../../home/jack/repo/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > scratch/$X/../../src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > .cache/$X/../../src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > /dev/$X/../../home/jack/repo/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > scratch*/../src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > $S/../src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x > $S/a.ts")).toEqual([]);
    expect(files("echo x > $S/..a")).toEqual([]);
  });

  test("C17: a temp name assigned to a non-temp root, or used by for/read, is a code edit", () => {
    expect(files("S=$PWD/src; echo x > $S/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("TMPDIR=$PWD/src; echo x >> $TMPDIR/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("S=$(pwd)/src\necho x > $S/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("for TMPDIR in src; do echo x > $TMPDIR/a.ts; done")).toEqual([SHELL_EDIT_FILE]);
    expect(files("for S in src; do echo x > $S/a.ts; done")).toEqual([SHELL_EDIT_FILE]);
    expect(files("read S; echo x > $S/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("read -r TMPDIR; echo x > $TMPDIR/a.ts")).toEqual([SHELL_EDIT_FILE]);
    const merged = classifyShellMutation("git merge x && S=$PWD/src && echo x > $S/a.ts");
    expect(merged.edits.map((e) => e.file)).toEqual([SHELL_EDIT_FILE]);
    expect(merged.opaque).toBe(false);
    expect(files("S=/tmp/x; echo x > $S/a.ts")).toEqual([]);
    expect(files("S=/tmp/claude-1000/x/scratchpad; echo x > $S/a.ts")).toEqual([]);
    // A use before the assignment stays scratch. The assignment poisons only what follows it.
    expect(files("echo x > $S/a.txt; S=$PWD/src")).toEqual([]);
    expect(files("echo x > $S/a.txt; S=$PWD/src; echo x > $S/b.ts")).toEqual([SHELL_EDIT_FILE]);
  });

  test("C17: cd is tracked only for && and || exit/return", () => {
    expect(files("cd /tmp/x | cat; sed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo x | cd /tmp/x; sed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("cd /tmp/x & sed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("cd /tmp/x; sed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("cd /tmp/x\nsed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("cd /tmp/x || true; sed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("cd /tmp/x && sed -i s/a/b/ src/a.ts")).toEqual(["/tmp/x/src/a.ts"]);
    expect(files("cd /tmp/x || exit 1; sed -i s/a/b/ src/a.ts")).toEqual(["/tmp/x/src/a.ts"]);
    expect(files("cd /tmp/x || exit; sed -i s/a/b/ src/a.ts")).toEqual(["/tmp/x/src/a.ts"]);
    expect(files("cd /tmp/x || return; sed -i s/a/b/ src/a.ts")).toEqual(["/tmp/x/src/a.ts"]);
    expect(files("cd /tmp/x || return 2; sed -i s/a/b/ src/a.ts")).toEqual(["/tmp/x/src/a.ts"]);
    expect(files("if cd R; then sed -i s/a/b/ a.ts; fi")).toEqual([SHELL_EDIT_FILE]);
    expect(files("while cd R; do sed -i s/a/b/ a.ts; break; done")).toEqual([SHELL_EDIT_FILE]);
    expect(files("until cd R; do sed -i s/a/b/ a.ts; break; done")).toEqual([SHELL_EDIT_FILE]);
    expect(files("cd /tmp/x && if cd R; then sed -i s/a/b/ src/a.ts; fi")).toEqual([SHELL_EDIT_FILE]);
    expect(files("case x in x) cd src;; esac; sed -i s/a/b/ a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("f() { cd /tmp/x; }; sed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("alias c='cd /tmp/x'; sed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("echo $(cd /tmp/x); sed -i s/a/b/ src/a.ts")).toEqual([SHELL_EDIT_FILE]);
    expect(files("cd /tmp/x && sed -i s/a/b/ src/a.ts && echo done")).toEqual(["/tmp/x/src/a.ts"]);
    expect(files("(cd /tmp/s && sed -i x a.ts); sed -i x b.ts")).toEqual(["/tmp/s/a.ts", "b.ts"]);
    expect(files("(cd /tmp/s); sed -i x b.ts")).toEqual(["b.ts"]);
    expect(files("(cd /tmp/s; sed -i x a.ts); sed -i x b.ts")).toEqual([SHELL_EDIT_FILE, "b.ts"]);
    expect(files("(cd /tmp/s | cat); sed -i x b.ts")).toEqual(["b.ts"]);
    expect(files("(cd /tmp/s || true); sed -i x b.ts")).toEqual(["b.ts"]);
    expect(files("(if cd /tmp/s; then sed -i x a.ts; fi); sed -i x b.ts")).toEqual([SHELL_EDIT_FILE, "b.ts"]);
    expect(files("(popd); sed -i x b.ts")).toEqual(["b.ts"]);
    expect(files("(pushd /tmp/s); sed -i x b.ts")).toEqual(["b.ts"]);
    expect(files("cd /repo && (cd /tmp/s); sed -i x b.ts")).toEqual(["/repo/b.ts"]);
    expect(files("cd /tmp/x; (cd /repo && sed -i x a.ts); sed -i x b.ts")).toEqual(["/repo/a.ts", SHELL_EDIT_FILE]);
  });

  test("C17: scratch* is a directory name, and a scratch-like file name is code", () => {
    expect(files("echo x > src/scratchpad.ts")).toEqual(["src/scratchpad.ts"]);
    expect(files("sed -i s/a/b/ src/scratchpad.ts")).toEqual(["src/scratchpad.ts"]);
    expect(files("echo x > scratch/a.ts")).toEqual([]);
    expect(files("echo x > src/scratch/a.ts")).toEqual([]);
  });

  test("C17: GATEREAD is only node scripts/gate.mjs, with no env loader in front", () => {
    expect(classifyShellMutation(mixed("node scripts/gate.mjs --base main")).opaque).toBe(false);
    expect(classifyShellMutation(mixed("node ./scripts/gate.mjs")).opaque).toBe(false);
    expect(classifyShellMutation(mixed("cd scripts && node gate.mjs")).opaque).toBe(false);
    for (const seg of [
      "NODE_OPTIONS=--require=/x node scripts/gate.mjs",
      "PYTHONPATH=/tmp node scripts/gate.mjs",
      "env --chdir=/tmp node scripts/gate.mjs",
      "sudo --chdir=/tmp node scripts/gate.mjs",
      "node scripts/check.mjs",
      "node scripts/check-fix.mjs",
      "node scripts/verify.js",
      "node scripts/validate.ts",
      "python3 scripts/gate.py",
      "python3 scripts/check.py --fix",
      "node scripts/gate.js",
    ]) {
      expect(classifyShellMutation(mixed(seg)).opaque, seg).toBe(true);
    }
    const repo = "/abs/repo";
    expect(classifyShellMutation(mixed("cd /abs/repo && node scripts/gate.mjs"), undefined, repo).opaque).toBe(false);
    expect(classifyShellMutation(mixed("cd /abs/repo-x && node scripts/gate.mjs"), undefined, repo).opaque).toBe(false);
    expect(classifyShellMutation(mixed("cd /abs/repo/pkg && node ./scripts/validate_all.py"), undefined, repo).opaque).toBe(true);
    expect(classifyShellMutation("NODE_OPTIONS=--require=/x node scripts/gate.mjs").opaque).toBe(true);
    expect(classifyShellMutation("node scripts/check.mjs").opaque).toBe(true);
  });
});
