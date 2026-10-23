import { describe, expect, test } from "vitest";
import { classifyCommand, findMaskedFailure, type RepoScripts } from "./check-patterns.js";

const repo: RepoScripts = { packageScripts: ["verify"], makeTargets: ["ci"], scriptFiles: ["tools/run-all.sh"] };

// [command, isCheck, unreliable?]
const cases: [string, boolean, boolean?][] = [
  // JS
  ["pnpm test", true, false],
  ["pnpm run test", true],
  ["npm test", true],
  ["npm t", true],
  ["npm run lint", true],
  ["yarn typecheck", true],
  ["bun test", true],
  ["bun run build", true],
  ["pnpm -r test", true],
  ["pnpm --filter @lgtm/core test", true],
  ["pnpm -C packages/core run typecheck", true],
  ["pnpm test:unit", true],
  ["pnpm exec vitest run", true],
  ["pnpm verify", true],
  ["npx tsc --noEmit", true],
  ["npx -y eslint .", true],
  ["./node_modules/.bin/vitest run", true],
  ["vitest run src/a.test.ts", true],
  ["jest --ci", true],
  ["biome check .", true],
  ["node --test dist/", true],
  // Python
  ["pytest -q tests/", true],
  ["python -m pytest", true],
  ["python3 -m mypy src", true],
  ["uv run pytest -x", true],
  ["uv run --with foo pytest", true],
  [".venv/bin/pytest", true],
  ["ruff check .", true],
  ["ruff format --check .", true],
  ["mypy src", true],
  ["flake8", true],
  // Go / Rust / JVM / make
  ["go test ./...", true],
  ["go vet ./...", true],
  ["cargo clippy --all-targets", true],
  ["cargo +nightly test", true],
  ["./mvnw -q verify", true],
  ["mvn test", true],
  ["./gradlew build", true],
  ["make test", true],
  ["make -C sub -j4 lint", true],
  ["make ci", true],
  // repo scripts
  ["./scripts/check.sh", true],
  ["bash scripts/test-all.sh --fast", true],
  ["tools/run-all.sh", true],
  // prefixes and chains
  ["cd /home/user/project && pnpm test", true, false],
  ["CI=1 NODE_ENV=test pnpm test", true],
  ["time pytest", true],
  ["timeout 120 pytest", true],
  ["timeout -k 5 120s pnpm test", true],
  ["sudo -n make check", true],
  ["cd x && pnpm install && pnpm lint && pnpm test", true, false],
  ["(cd x && pytest)", true],
  ["# run tests\npnpm test", true],
  // unreliable exit codes (A10)
  ["pytest | tail -20", true, true],
  ["pnpm test 2>&1 | tee out.log", true, true],
  ["pytest || true", true, true],
  ["pytest; echo done", true, true],
  ["pnpm test & ", true, true],
  ["pytest 2>&1", true, false],
  ["pytest && echo ok", true, false],
  // script names without a repo list (status-accuracy)
  ["bash scripts/verify-x.sh > log 2>&1", true],
  ["bash scripts/verify-x.sh", true, false],
  ["./scripts/validate-schema.sh", true],
  ["sh tools/gate.sh --strict", true],
  ["zsh ci/mutation-run.sh", true],
  ["./smoke.sh", true],
  ["bash scripts/smoke-test.sh 2>&1 | tail -20", true, true],
  ["cd ../other-repo && bash scripts/check-all.sh", true],
  ["bash -x scripts/test-all.sh", true],
  ["/opt/work/repo/scripts/lint-docs.sh", true],
  // more runners
  ["dotnet test", true],
  ["dotnet test Foo.sln --no-build -v q", true],
  ["dotnet build -c Release", true],
  ["dotnet test 2>&1 | tail -5", true, true],
  ["python manage.py test", true],
  ["python3 manage.py test app.tests --parallel", true],
  ["./manage.py test", true],
  ["uv run python manage.py test", true],
  ["bats tests/", true],
  ["bats --tap test/x.bats", true],
  ["shellcheck scripts/*.sh", true],
  ["hadolint Dockerfile", true],
  ["cargo nextest run", true],
  ["cargo +stable nextest run --workspace", true],
  ["gh run watch 12345 --exit-status", true],
  ["gh run watch --exit-status 12345 && echo done", true, false],
  ["gh pr checks", true],
  ["gh pr checks 17 --watch", true],
  // masked / mutation-probe shapes
  ["pytest -q 2>&1 | tail -1; git checkout -q src/a.py", true, true],
  ["pytest -q && git restore src/a.py", true, true],
  ["pytest; git stash", true, true],
  ["pytest; git stash pop", true, true],
  // not checks: syntax only, dry runs, fixers
  ["bash -n scripts/check.sh", false],
  ["sh -n scripts/verify-x.sh", false],
  ["bash -n scripts/check.sh && echo syntax ok", false],
  ["zsh -n ci/test.sh", false],
  ["make -n test", false],
  ["make test --dry-run", false],
  ["pnpm test --dry-run", false],
  ["bash scripts/verify-x.sh --dry-run", false],
  ["bash scripts/verify-x.sh --help", false],
  ["ruff check --fix .", false],
  ["ruff check --fix-only src", false],
  ["ruff format .", false],
  ["ruff format src/a.py", false],
  ["gh run watch 12345", false],
  ["gh run list", false],
  ["gh pr view 3", false],
  ["dotnet restore", false],
  ["dotnet run", false],
  ["python manage.py migrate", false],
  ["python manage.py runserver", false],
  ["cargo fmt", false],
  ["cat scripts/verify-x.sh", false],
  ["vim scripts/verify-x.sh", false],
  ["chmod +x scripts/verify-x.sh", false],
  ["bash scripts/deploy.sh", false],
  ["bash scripts/setup.sh", false],
  ["git checkout -q src/a.py", false],
  // negatives
  ["echo pytest", false],
  ["grep -r pytest .", false],
  ["cat package.json | grep test", false],
  ["git commit -m 'run pnpm test'", false],
  ["pnpm install", false],
  ["pnpm add -D vitest", false],
  ["npm run dev", false],
  ["pnpm dev", false],
  ["pytest --version", false],
  ["tsc --help", false],
  ["make", false],
  ["make deploy", false],
  ["ls scripts/", false],
  ["cat scripts/check.sh", false],
  ["python script.py", false],
  ["python -m pip install pytest", false],
  ["cargo run", false],
  ["go mod tidy", false],
  ["node index.js", false],
  ["cat <<'EOF' > notes.txt\npytest\npnpm test\nEOF", false],
  ["echo 'a && pytest'", false],
  ["echo \"x; pnpm test\"", false],
  ["", false],
  ["   ", false],
];

describe("classifyCommand", () => {
  test("table has enough cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  test.each(cases)("%j", (command, isCheck, unreliable) => {
    const r = classifyCommand(command, repo);
    expect(r.isCheck).toBe(isCheck);
    if (isCheck) {
      expect(r.label).not.toBe("");
      if (unreliable !== undefined) expect(r.unreliable).toBe(unreliable);
    } else {
      expect(r).toEqual({ isCheck: false, label: "", unreliable: false, mutationProbe: false });
    }
  });

  test("repo scripts are only used when provided", () => {
    expect(classifyCommand("pnpm verify").isCheck).toBe(false);
    expect(classifyCommand("make ci").isCheck).toBe(false);
    expect(classifyCommand("tools/run-all.sh").isCheck).toBe(false);
  });

  test("labels are the normalized check segment", () => {
    expect(classifyCommand("cd x && CI=1 pnpm test").label).toBe("pnpm test");
    expect(classifyCommand("pnpm lint && pnpm test").label).toBe("pnpm lint + pnpm test");
    expect(classifyCommand("uv run pytest -k foo").label).toBe("pytest -k foo");
  });

  test("mutation probe flags a revert after the check, and makes the result unreliable", () => {
    for (const c of ["pytest -q | tail -1; git checkout -q src/a.py", "pytest && git restore src/a.py", "pytest; git stash", "pytest; git checkout -- .", "pytest; git -C sub checkout src/a.py"]) {
      expect(classifyCommand(c), c).toMatchObject({ isCheck: true, mutationProbe: true, unreliable: true });
    }
    for (const c of ["pytest", "pytest | tail -3", "git checkout -q src/a.py; pytest", "pytest; git checkout -b feature", "pytest; git stash pop", "pytest; git status", "pytest; git checkout main"]) {
      expect(classifyCommand(c).mutationProbe, c).toBe(false);
    }
  });

  test("never throws on odd input", () => {
    for (const c of ['"unterminated', "'x", "\\", "&&&&", "||", ";;;", "<<", "a <<EOF", "\u0000", "(((("]) {
      expect(() => classifyCommand(c)).not.toThrow();
    }
    expect(classifyCommand(undefined as unknown as string).isCheck).toBe(false);
  });
});

// [output, failure signal expected?]
const maskedCases: [string, boolean][] = [
  ["=== 2 failed, 10 passed in 1.2s ===", true],
  ["1 failed", true],
  ["12 failures", true],
  ["Found 3 errors in 2 files", true],
  ["1 error", true],
  ["...\nEXIT=1", true],
  ["done\nexit: 2", true],
  ["ran\nrc=127", true],
  ["status: 1", true],
  ["exit code 1", true],
  ["[ERROR] BUILD FAILURE\n[INFO] Total time: 3 s", true],
  ["Tests run: 12, Failures: 1, Errors: 0, Skipped: 0", true],
  ["Tests run: 12, Failures: 0, Errors: 2, Skipped: 0", true],
  ["FAILED tests/test_a.py::test_x - assert 1 == 2", true],
  ["not ok 3 - handles empty input", true],
  ["Failed!  - Failed:     2, Passed:    10, Skipped:     0, Total:    12", true],
  ["Traceback (most recent call last):\n  File \"x.py\", line 1, in <module>\nValueError: boom", true],
  // all clear
  ["", false],
  ["12 passed in 0.8s", false],
  ["0 failed, 12 passed", false],
  ["no errors found", false],
  ["errors: 0", false],
  ["0 errors, 0 warnings", false],
  ["Tests run: 12, Failures: 0, Errors: 0, Skipped: 1", false],
  ["status: 200 OK", false],
  ["exit: 0", false],
  ["ok 1 - a\nok 2 - b", false],
  ["Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12", false],
  ["Ran 5 tests in 0.01s\n\nOK", false],
  ["All tests passed", false],
  ["test_handles_FAILED_state PASSED", false],
  // G3: a failure signal wins over a negative phrase, in both orders
  ["3 failed in suite\n0 failed on rerun", true],
  ["0 failed on rerun\n3 failed in suite", true],
  ["FAILED tests/a.py::t\nno errors", true],
  ["no errors so far\nEXIT=1", true],
  ["EXIT=1\nAll tests passed", true],
  // a failure signal on the final negative summary line itself is discarded
  ["12 passed\n0 FAILED", false],
  // traceback only near the end of the output
  [`Traceback (most recent call last):\n  x\nValueError: logged\n${"line\n".repeat(30)}12 passed`, false],
  [`${"line\n".repeat(30)}Traceback (most recent call last):\n  File "x.py"\nKeyError: 1`, true],
];

describe("findMaskedFailure", () => {
  test("table has enough cases", () => {
    expect(maskedCases.length).toBeGreaterThanOrEqual(30);
  });

  test.each(maskedCases)("%j", (output, failing) => {
    expect(findMaskedFailure(output) !== null).toBe(failing);
  });

  test("only the last 4 KB are inspected", () => {
    expect(findMaskedFailure(`3 failed\n${"x".repeat(5000)}\n12 passed`)).toBeNull();
    expect(findMaskedFailure(`${"x".repeat(5000)}\n3 failed\n`)).toBe("3 failed");
  });

  test("returns the trimmed signal line", () => {
    expect(findMaskedFailure("ok\n  2 failed, 3 passed  \n")).toBe("2 failed, 3 passed");
  });

  test("never throws", () => {
    expect(findMaskedFailure(undefined as unknown as string)).toBeNull();
  });
});
