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
    ["git merge b && sed -i s/x/y/ plan.md && python3 -c \"open('src/a.ts','w')\"", false],
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
    "node -r x/register scripts/gate.mjs",
    "node --require ./reg scripts/verify-run.mjs",
    "python3 -u scripts/gate.py",
    "python3 -uBI scripts/validate_all.py",
    "cd scripts && node gate.mjs",
    "python3 -c \"print(1)\"",
    "python3 -c \"open('/tmp/x','w').write('x')\"",
    "python3 -c \"print('exec(')\"",
    "python3 -c \"print('import os')\"",
    "python3 -c \"print(1)  # import os; open('a.ts','w')\"",
  ])("safe: %s", (seg) => {
    expect(classifyShellMutation(mixed(seg)).opaque).toBe(false);
  });

  test.each([
    "npm install",
    "pnpm install",
    "yarn install",
    "pnpm i",
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
    "python3 -c \"print('ab'.replace('a', 'b'))\"",
    "python3 -c \"json.dump(d, f)\"",
    "python3 -c \"print(open('a.ts', 'r').read())\"",
    "python3 -c \"import platform; print(platform.system())\"",
    "python3 -c 'from pathlib import Path as P; (P(\"a\")/\"b\").write_text(\"x\")'",
  ])("kept opaque: %s", (seg) => {
    expect(classifyShellMutation(mixed(seg)).opaque).toBe(true);
  });

  test("python -c open in write mode resolves, an unknown path does not", () => {
    const h1 = classifyShellMutation("git merge b && sed -i s/x/y/ plan.md && python3 -c \"open('src/a.ts','w')\"");
    expect(h1.opaque).toBe(false);
    expect(h1.edits.map((e) => e.file)).toContain("src/a.ts");
    expect(files("python3 -c \"open('src/a.ts','w').write('x')\"")).toEqual(["src/a.ts"]);
    expect(files("python3 -c \"open(p,'w')\"")).toEqual([SHELL_EDIT_FILE]);
    expect(files("python3 -c \"print(1)\"")).toEqual([]);
    expect(files("F=src/a.ts && python3 -c \"open('$F','w').write('x')\"")).toEqual(["src/a.ts"]);
    const indented = "python3 -c \"\n    p = 'src/a.ts'\n    open(p, 'w').write('x')\n\"";
    expect(files(indented)).toEqual(["src/a.ts"]);
  });

  test("python -c extra write APIs are edits, and an escape wins over a parsed write", () => {
    expect(files("python3 -c \"from pathlib import Path; Path('a.ts').unlink()\"")).toEqual([SHELL_EDIT_FILE]);
    expect(classifyShellMutation(mixed("python3 -c \"from pathlib import Path; Path('a.ts').unlink()\"")).opaque).toBe(false);
    const both = classifyShellMutation("python3 -c \"open('src/a.ts','w').write('x'); exec('1')\"");
    expect(both.opaque).toBe(false);
    expect(both.edits).toEqual([]);
    const mixedEscape = classifyShellMutation(mixed("python3 -c \"open('src/a.ts','w').write('x'); exec('1')\""));
    expect(mixedEscape.opaque).toBe(true);
    expect(mixedEscape.edits.map((e) => e.file)).not.toContain("src/a.ts");
  });

  test("C12: python -c is non-writing only on the import allow-list", () => {
    const ok = (seg: string) => classifyShellMutation(mixed(seg));
    const dumps = ok("python3 -c \"import json; print(json.dumps({}))\"");
    expect(dumps.opaque).toBe(false);
    expect(dumps.edits.map((e) => e.file)).toEqual(["plan.md"]);
    const aliased = ok("python3 -c \"import json as j; print(j.dumps({}))\"");
    expect(aliased.opaque).toBe(false);
    const hashed = ok("python3 -c \"import hashlib; print(hashlib.sha256(b'x').hexdigest())\"");
    expect(hashed.opaque).toBe(false);
    const machine = ok("python3 -c \"import platform; print(platform.machine())\"");
    expect(machine.opaque).toBe(false);
    expect(files("python3 -c \"print(1)\"")).toEqual([]);
    expect(files("python3 -c \"import json; print(json.dumps({}))\"")).toEqual([]);
    expect(files("python3 -c \"open('/tmp/x','w').write('x')\"")).toEqual([]);
    const chained = classifyShellMutation("python3 -c \"open('src/a.ts','w').write('x')\"");
    expect(chained.opaque).toBe(false);
    expect(chained.edits.map((e) => e.file)).toEqual(["src/a.ts"]);
    const pathOnly = classifyShellMutation("python3 -c \"Path('notes.md').write_text('x')\"");
    expect(pathOnly.opaque).toBe(false);
    expect(pathOnly.edits.map((e) => e.file)).toEqual(["notes.md"]);

    const dumped = classifyShellMutation("python3 -c \"json.dump(d, open('x.json','w'))\"");
    expect(dumped.opaque).toBe(false);
    expect(dumped.edits.map((e) => e.file)).toEqual(["x.json"]);
    const dumpedMixed = ok("python3 -c \"json.dump(d, open('x.json','w'))\"");
    expect(dumpedMixed.opaque).toBe(false);
    expect(dumpedMixed.edits.map((e) => e.file)).toContain("x.json");

    // A resolved write stays, but a disallowed import makes the command opaque.
    const pathWrite = ok("python3 -c \"from pathlib import Path; Path('a.ts').write_text('x')\"");
    expect(pathWrite.opaque).toBe(true);
    expect(pathWrite.edits.map((e) => e.file)).toContain("a.ts");

    // Alias hides the path: unresolved write, still a code edit, and opaque.
    const alias = "python3 -c 'from pathlib import Path as P; (P(\"a\")/\"b\").write_text(\"x\")'";
    const aliasOnly = classifyShellMutation(alias);
    expect(aliasOnly.opaque).toBe(true);
    expect(aliasOnly.edits.map((e) => e.file)).toEqual([SHELL_EDIT_FILE]);
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
});
