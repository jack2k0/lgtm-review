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
    ["python - <<EOF\nfrom pathlib import Path\nPath('a').write_text('x')\nEOF", [SHELL_EDIT_FILE]],
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
    expect(resolveTarget("src/x.js", null, false)).toBe("src/x.js");
    expect(resolveTarget(SHELL_EDIT_FILE, "/home/u/p", false)).toBe(SHELL_EDIT_FILE);
  });

  test("normalizePath", () => {
    expect(normalizePath("/a/b/../c/./d")).toBe("/a/c/d");
    expect(normalizePath("../a")).toBe("../a");
  });
});
