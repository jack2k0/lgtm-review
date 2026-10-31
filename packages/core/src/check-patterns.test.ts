import { describe, expect, test } from "vitest";
import { classifyShellMutation } from "./shell-edits.js";
import { checkScope, classifyCommand, findMaskedFailure, parseHeredocStarts, stripHeredocs, type RepoScripts } from "./check-patterns.js";

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
  ["corepack pnpm check", true],
  ["corepack pnpm exec vitest run", true],
  ["corepack yarn test", true],
  ["corepack enable", false],
  ["node scripts/gate.mjs", false],
  ["node scripts/gate.mjs --base main", false],
  ["python3 scripts/check_status.py", false],
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
  ["pytest -v", true],
  ["pytest -v tests/", true],
  ["python -m ruff check .", true],
  ["python3 -m ruff format --check .", true],
  ["python -m ruff check --fix .", false],
  ["python -m flake8 src", true],
  ["python -m pylint pkg", true],
  ["python -m black --check .", true],
  ["python -m black .", false],
  // not checks: listing / collecting / version
  ["pytest --collect-only", false],
  ["pytest --co -q", false],
  ["python -m pytest --collect-only", false],
  ["jest --listTests", false],
  ["vitest list", false],
  ["vitest list --json", false],
  ["cargo test --no-run", false],
  ["cargo +nightly test --no-run", false],
  ["dotnet test --list-tests", false],
  ["tsc -v", false],
  ["vitest -v", false],
  ["tsc --version", false],
  ["cargo test", true],
  ["vitest run", true],
  // package managers running check binaries directly
  ["pnpm vitest", true],
  ["pnpm vitest run src/a.test.ts", true],
  ["pnpm vitest --watch", true],
  ["vitest --watch", true],
  ["pnpm jest --ci", true],
  ["pnpm eslint .", true],
  ["pnpm tsc --noEmit", true],
  ["pnpm -C packages/core vitest run", true],
  ["pnpm --filter web vitest", true],
  ["yarn vitest run", true],
  ["yarn eslint src", true],
  ["bun vitest", true],
  ["bun tsc --noEmit", true],
  ["pnpm pytest", true],
  ["pnpm mypy src", true],
  ["pnpm ruff check .", true],
  ["pnpm ruff check --fix .", false],
  ["npm exec vitest run", true],
  ["npm exec -- vitest run", true],
  ["pnpm vitest list", false],
  ["pnpm tsc -v", false],
  ["pnpm jest --listTests", false],
  ["pnpm vitest --help", false],
  ["pnpm prettier --write .", false],
  ["pnpm cowsay hi", false],
  // deno / just
  ["deno test", true],
  ["deno test -A src/", true],
  ["deno lint", true],
  ["deno check main.ts", true],
  ["deno lint --fix", false],
  ["deno run main.ts", false],
  ["just test", true],
  ["just check", true],
  ["just lint", true],
  ["just -d sub test", true],
  ["just test foo", true],
  ["just build", false],
  ["just --list", false],
  ["just deploy test", false],
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
  // wrappers (status-accuracy-3)
  ["flock /tmp/x.lock pnpm test", true],
  ["flock -n /tmp/x.lock ./scripts/check.sh", true],
  ["flock -nx lock pytest", true],
  ["flock -w10 lock pnpm test", true],
  ["flock -w 600 lock bash scripts/verify-all.sh", true],
  ["flock --wait=10 lock pnpm test", true],
  ["flock -E 1 lock pnpm test", true],
  ["flock --conflict-exit-code 1 lock pnpm test", true],
  ["flock /tmp/x.lock -c 'pnpm test'", true],
  ["flock /tmp/x.lock -c \"scripts/check.sh\"", true],
  ["flock 9 pnpm test", true],
  ["flock /tmp/l ls", false],
  ["flock /tmp/l -c 'ls'", false],
  ["ionice -c3 pnpm test", true],
  ["ionice -c 3 -n 7 pytest", true],
  ["ionice -t scripts/check.sh", true],
  ["ionice -c3 nice pnpm test", true],
  ["ionice -c3 ls", false],
  ["setsid pnpm test", true],
  ["setsid -f scripts/check.sh", true],
  ["setsid -w ls", false],
  ["stdbuf -oL pnpm test", true],
  ["stdbuf -o L -eL scripts/check.sh", true],
  ["stdbuf -i0 -o0 -e0 pytest", true],
  ["stdbuf -oL ls", false],
  ["flock -w 5 /tmp/l ionice -c3 setsid stdbuf -oL scripts/check.sh", true],
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
  // task runners (turbo / nx)
  ["turbo run test", true, false],
  ["turbo run build lint", true],
  ["turbo test", true],
  ["turbo run test:unit", true],
  ["turbo run test --filter ./packages/web", true],
  ["turbo run test --filter '{packages/web}'", true],
  ["turbo run test --filter=./packages/web", true],
  ["turbo --filter ./packages/web run test", true],
  ["turbo run deploy", false],
  ["turbo deploy", false],
  ["turbo run", false],
  ["turbo", false],
  ["turbo login", false],
  ["turbo run test --dry", false],
  ["turbo run test --dry=json", false],
  ["turbo run test --dry-run", false],
  ["turbo run test --dry-run=json", false],
  ["turbo run test --graph", false],
  ["turbo --graph test", false],
  ["turbo --version", false],
  ["turbo run test --help", false],
  ["npx turbo run test", true],
  ["npx -y turbo run test", true],
  ["pnpm exec turbo run test", true],
  ["pnpm dlx turbo run test", true],
  ["bunx turbo run test", true],
  ["yarn dlx turbo run test", true],
  ["yarn turbo run test", true],
  ["pnpm turbo run test", true],
  ["pnpm turbo run test --filter ./packages/web", true],
  ["nx run-many -t test", true],
  ["nx run-many --targets lint,test", true],
  ["nx run-many --targets=deploy,test", true],
  ["nx affected -t test", true],
  ["nx affected --targets test,lint", true],
  ["nx run web:test", true],
  ["nx run web:build:production", true],
  ["nx test web", true],
  ["nx build web --configuration=production", true],
  ["nx run-many -t deploy", false],
  ["nx run-many --targets deploy,serve", false],
  ["nx run-many", false],
  ["nx affected -t deploy", false],
  ["nx affected --base=main", false],
  ["nx run web:deploy", false],
  ["nx deploy web", false],
  ["nx graph", false],
  ["nx run-many -t test --graph", false],
  ["nx --help", false],
  ["nx run web:test --help", false],
  ["nx format:check", false],
  ["npx nx run-many -t test", true],
  ["pnpm exec nx affected -t test", true],
  ["pnpm nx run web:test", true],
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
  ["eslint .", true],
  ["eslint --fix-dry-run .", true],
  ["eslint --fix .", false],
  ["eslint --fix-type problem .", false],
  ["eslint --fix-type=problem .", false],
  ["pnpm eslint --fix .", false],
  ["npx eslint --fix .", false],
  ["yarn eslint --fix .", false],
  ["bun eslint --fix .", false],
  ["biome check .", true],
  ["biome check --write", false],
  ["biome check --fix", false],
  ["biome check --apply", false],
  ["biome check --apply-unsafe", false],
  ["biome check --unsafe", false],
  ["pnpm biome check --write", false],
  ["npx biome check --write", false],
  ["yarn biome check --write", false],
  ["bun biome check --write", false],
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
  // status-script-autofix
  ["pnpm lint --fix", false],
  ["pnpm -r lint --fix", false],
  ["pnpm --filter x lint --fix", false],
  ["npm run lint -- --fix", false],
  ["turbo run lint -- --fix", false],
  ["pnpm lint:fix", false],
  ["pnpm lint-fix", false],
  ["pnpm fix:lint", false],
  ["turbo lint:fix", false],
  ["turbo run lint-fix", false],
  ["pnpm lint --fix=code", false],
  ["pnpm lint --fix-type=problem", false],
  ["pnpm lint --fix-type problem", false],
  ["pnpm lint --fix-only", false],
  ["pnpm lint --write", false],
  ["pnpm lint --apply", false],
  ["pnpm lint --apply-unsafe", false],
  ["pnpm lint --unsafe", false],
  ["pnpm check --fix", false],
  ["pnpm lint:ci --fix", false],
  ["npm run lint -- --fix-dry-run", true],
  ["pnpm lint --fix-dry-run", true],
  ["pnpm lint --fix && pnpm test", true],
  // status-update-flags
  ["vitest -u", false],
  ["vitest run -u", false],
  ["vitest --update", false],
  ["vitest --update=next", false],
  ["vitest --update-snapshots", false],
  ["vitest --update-snapshots=all", false],
  ["jest -u", false],
  ["npx jest -u", false],
  ["bunx jest -u", false],
  ["pnpm vitest -u", false],
  ["pnpm jest --updateSnapshot", false],
  ["pnpm test -u", false],
  ["pnpm -r test -u", false],
  ["pnpm test --updateSnapshot=paths", false],
  ["npm test -- --updateSnapshot", false],
  ["npm run test -- --update-snapshots", false],
  ["turbo run test -- -u", false],
  ["pnpm test:cover --update", false],
  ["cargo clippy --fix", false],
  ["pnpm test -u && pnpm test", true],
  ["pnpm test -- --testNamePattern u", true],
  ["pytest -u", true],
  ["git add -u && pnpm test", true],
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

  test("autofix scripts produce opaque shell mutations", () => {
    expect(classifyShellMutation("pnpm lint --fix").opaque).toBe(true);
    expect(classifyShellMutation("npm run lint -- --fix").opaque).toBe(true);
    expect(classifyShellMutation("pnpm lint:fix").opaque).toBe(true);
    expect(classifyShellMutation("turbo run lint -- --fix").opaque).toBe(true);
  });

  test("snapshot updates and clippy --fix produce opaque shell mutations", () => {
    expect(classifyShellMutation("pnpm test -u").opaque).toBe(true);
    expect(classifyShellMutation("vitest -u").opaque).toBe(true);
    expect(classifyShellMutation("npm test -- --updateSnapshot").opaque).toBe(true);
    expect(classifyShellMutation("turbo run test -- -u").opaque).toBe(true);
    expect(classifyShellMutation("cargo clippy --fix").opaque).toBe(true);
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
  // jest/vitest/go failure lines and killed processes
  ["FAIL src/app.test.ts\n  ● test failure\n", true],
  [" FAIL  src/app.test.ts > suite > case\n", true],
  ["--- FAIL: TestFoo (0.01s)\nFAIL\n", true],
  ["ok  \tpkg/a\t0.1s\nFAIL\tpkg/b\t0.2s\nFAIL\n", true],
  ["Killed\n", true],
  ["Terminated\n", true],
  ["PASS src/app.test.ts\nTests: 3 passed\n", false],
  ["PASS\nok  \tpkg/a\t0.1s\n", false],
  ["const FAILURE_SIGNALS = [];\n12 passed\n", false],
  ["12 passed, 0 failed\n", false],
  ["the process was not Killed\n12 passed\n", false],
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

describe("checkScope", () => {
  const rows: [string, string[] | null][] = [
    ["pnpm test", ["."]],
    ["cd packages/web && pnpm test", ["packages/web"]],
    ["cd packages/web && cd src && pnpm test", ["packages/web/src"]],
    ["cd /abs/x && pnpm test", ["/abs/x"]],
    ["cd $DIR && pnpm test", null],
    ["cd && pnpm test", null],
    ["cd - && pnpm test", null],
    ["cd ~/x && pnpm test", null],
    ["pushd packages/core && pnpm test", ["packages/core"]],
    ["(cd packages/web && pnpm test)", ["packages/web"]],
    ["(cd packages/web && pnpm test) && pnpm test", ["packages/web", "."]],
    ["(cd packages/web && pnpm test); pnpm test", ["packages/web", "."]],
    ["cd packages && (cd web && pnpm test) && pnpm test", ["packages/web", "packages"]],
    ["pnpm -C packages/web test", ["packages/web"]],
    ["pnpm --dir=packages/web test", ["packages/web"]],
    ["pnpm --filter ./packages/web test", ["packages/web"]],
    ["pnpm --filter '{packages/web}' test", ["packages/web"]],
    ["pnpm --filter '...{packages/web}' test", ["packages/web"]],
    ["pnpm --filter '{packages/*}' test", null],
    ["pnpm --filter '@acme/web{packages/web}' test", null],
    ["pnpm --filter './packages/*' test", null],
    ["pnpm --filter './packages/{web,core}' test", null],
    ["pnpm --filter ./packages/web... test", ["packages/web"]],
    ["pnpm -F @acme/web test", null],
    ["pnpm --filter web test", null],
    ["pnpm -r test", null],
    ["pnpm --recursive test", null],
    ["npm --prefix packages/web test", ["packages/web"]],
    ["npm test --prefix packages/web", ["packages/web"]],
    ["npm test --prefix=packages/web", ["packages/web"]],
    ["npm -w packages/web test", ["packages/web"]],
    ["npm test -w packages/web", ["packages/web"]],
    ["npm test --workspace packages/core", ["packages/core"]],
    ["npm --workspace=@acme/web test", null],
    ["npm test --workspace @acme/web", null],
    ["yarn workspace web test", null],
    ["yarn --cwd packages/web test", ["packages/web"]],
    ["pnpm exec vitest run tests/api", ["tests/api"]],
    ["pnpm vitest run tests/api", ["tests/api"]],
    ["pnpm vitest", ["."]],
    ["pnpm -C packages/core vitest run", ["packages/core"]],
    ["pnpm --filter ./packages/web vitest run", ["packages/web"]],
    ["pnpm --filter web vitest run", null],
    ["pnpm -C packages/core vitest run tests/x", null],
    ["yarn eslint src", ["src"]],
    ["bun tsc --noEmit", ["."]],
    ["deno test", ["."]],
    ["just test", ["."]],
    ["just -d sub test", ["sub"]],
    ["python -m ruff check src", ["src"]],
    ["pnpm exec vitest run packages/e2e", ["packages/e2e"]],
    ["pnpm exec vitest run apps/e2e", ["apps/e2e"]],
    ["vitest run -t adds src/math", ["src/math"]],
    ["vitest run --bail 1", ["."]],
    ["vitest run --maxWorkers 2 --minWorkers 1 --testTimeout 5000 --hookTimeout 3000 --retry 2 --repeats 1 --exclude dist --include src src/a.test.ts", ["src/a.test.ts"]],
    ["vitest related src/a.ts", null],
    ["npx vitest --dir packages/core", ["packages/core"]],
    ["jest --bail 1", ["."]],
    ["jest --retry 2 src/a.test.ts", ["src/a.test.ts"]],
    ["jest --testTimeout 5000 src/a.test.ts", ["src/a.test.ts"]],
    ["jest --testPathPattern api", ["api"]],
    ["jest --testPathPatterns api", ["api"]],
    ["pytest tests/test_cart.py::test_total -q", ["tests/test_cart.py"]],
    ["uv run pytest tests/test_cart.py", ["tests/test_cart.py"]],
    ["pytest -k total", ["."]],
    ["pytest -q --password hunter2", ["."]],
    ["pytest --token s3cr3t", ["."]],
    ["pytest -q --api-key mykey tests/unit", ["tests/unit"]],
    ["pytest -q 2>&1 | tail -1", ["."]],
    ["pytest -q > log 2>&1", ["."]],
    ["dotnet test 2>&1 | tail -5", ["."]],
    ["python -m pytest tests/unit", ["tests/unit"]],
    ["go test ./...", ["."]],
    ["go test -run TestX ./internal/foo/...", ["internal/foo"]],
    ["go test github.com/x/y", null],
    ["tsc -p packages/core/tsconfig.json", ["packages/core"]],
    ["tsc -p packages/core", ["packages/core"]],
    ["tsc --noEmit", ["."]],
    ["tsc --noEmit packages/web/src/index.ts", ["packages/web/src/index.ts"]],
    ["eslint 'src/**/*.ts'", ["src"]],
    ["eslint packages/web/src/index.ts", ["packages/web/src/index.ts"]],
    ["shellcheck scripts/deploy.sh", ["scripts/deploy.sh"]],
    ["ruff check app/", ["app"]],
    ["mypy -p pkg", null],
    ["cargo test -p core", null],
    ["make -C backend test", ["backend"]],
    ["make -Cbackend test", ["backend"]],
    ["turbo run test", ["."]],
    ["turbo run build lint", ["."]],
    ["turbo test --filter ./packages/web", ["packages/web"]],
    ["turbo run test --filter '{packages/web}'", ["packages/web"]],
    ["turbo run test --filter=./packages/web", ["packages/web"]],
    ["turbo run test -F ./packages/core", ["packages/core"]],
    ["turbo run test --filter ./packages/web...", ["packages/web"]],
    ["turbo run test --filter ./packages/web --filter ./packages/core", ["packages/web", "packages/core"]],
    ["turbo run test --filter @acme/web", null],
    ["turbo run test --filter web", null],
    ["turbo run test --filter './packages/*'", null],
    ["turbo run test --filter '{packages/*}'", null],
    ["turbo run test --affected", null],
    ["turbo --affected run test", null],
    ["cd packages/web && turbo run test", ["packages/web"]],
    ["pnpm turbo run test", ["."]],
    ["pnpm turbo run test --filter ./packages/web", ["packages/web"]],
    ["pnpm -C packages/web turbo run test", ["packages/web"]],
    ["pnpm --filter ./packages/web turbo run test", ["packages/web"]],
    ["pnpm -r turbo run test", null],
    ["npx turbo run test", ["."]],
    ["yarn turbo run test --filter ./packages/core", ["packages/core"]],
    ["nx run-many -t test", ["."]],
    ["nx run-many --targets lint,test", ["."]],
    ["nx affected -t test", ["."]],
    ["nx run-many -t test -p web", null],
    ["nx run-many -t test --projects=web,core", null],
    ["nx affected -t test --projects web", null],
    ["nx run web:test", null],
    ["nx test web", null],
    ["pnpm exec nx affected -t test", ["."]],
    ["pnpm nx run web:test", null],
    ["bash scripts/check.sh", null],
    ["gh run watch 1 --exit-status", null],
    ["pnpm lint && cd packages/web && pnpm test", [".", "packages/web"]],
    ["pnpm test && pnpm --filter @x/y test", null],
    ["ls src", null],
  ];
  test.each(rows)("%s", (cmd, expected) => {
    expect(checkScope(cmd)).toEqual(expected);
  });
});

describe("status-accuracy-7 stripHeredocs forms", () => {
  test("backslash delimiter is recognised", () => {
    expect(stripHeredocs("cat <<\\EOF\nbody\nEOF\npnpm check")).toBe("cat <<\\EOF\npnpm check");
  });
  test("plain delimiter must match exactly", () => {
    expect(stripHeredocs("cat <<EOF\n  EOF\nEOF \nEOF\npnpm check")).toBe("cat <<EOF\npnpm check");
  });
  test("dash delimiter allows leading tabs only", () => {
    expect(stripHeredocs("cat <<-EOF\n  EOF\n\tEOF\npnpm check")).toBe("cat <<-EOF\npnpm check");
  });
});

describe("status-accuracy-8 stripHeredocs delimiter words", () => {
  test("a delimiter with - . + digits is the whole word", () => {
    expect(stripHeredocs("cat <<END-1\nbody\nEND-1\npnpm check")).toBe("cat <<END-1\npnpm check");
    expect(stripHeredocs("cat <<E.x\nbody\nE.x\npnpm check")).toBe("cat <<E.x\npnpm check");
    expect(stripHeredocs("cat <<E'-'1\nbody\nE-1\npnpm check")).toBe("cat <<E'-'1\npnpm check");
  });
});

describe("status-accuracy-9 multiple heredocs on one line", () => {
  test("stripHeredocs drops both bodies", () => {
    const cmd = "cat <<A >notes.txt; cat <<B >other.txt\nx\nA\nbody-b\nB\npnpm check";
    expect(stripHeredocs(cmd)).toBe("cat <<A >notes.txt; cat <<B >other.txt\npnpm check");
  });

  test("parseHeredocStarts unit tests", () => {
    expect(parseHeredocStarts("cat <<A; cat <<B")).toEqual([
      { delim: "A", quoted: false, dash: false },
      { delim: "B", quoted: false, dash: false },
    ]);
    expect(parseHeredocStarts("cat <<-A; cat <<'Q'")).toEqual([
      { delim: "A", quoted: false, dash: true },
      { delim: "Q", quoted: true, dash: false },
    ]);
    expect(parseHeredocStarts("cat <<-A; x=$((1<<2)); cat <<'Q'")).toEqual([
      { delim: "A", quoted: false, dash: true },
      { delim: "Q", quoted: true, dash: false },
    ]);
  });
});

describe("status-accuracy-10 quote- and arithmetic-aware heredoc starts", () => {
  test("sa10: a << inside single quotes, double quotes or ANSI quotes is not a heredoc start", () => {
    expect(parseHeredocStarts('python3 -c "print(1 << 2)"')).toEqual([]);
    expect(parseHeredocStarts('grep "<<EOF" "a b"')).toEqual([]);
    expect(parseHeredocStarts("echo 'a <<B'")).toEqual([]);
    expect(parseHeredocStarts("echo $'foo <<EOF bar'")).toEqual([]);
    expect(parseHeredocStarts('python3 -c "import sys; print(1 << 2)"')).toEqual([]);
  });

  test("sa10: arithmetic context $(( ... )) or $[ ... ] preserves shift across pipe or semicolon", () => {
    expect(parseHeredocStarts("echo $((8 | 1<<2)); cat <<E | python3")).toEqual([
      { delim: "E", quoted: false, dash: false },
    ]);
    expect(parseHeredocStarts("echo $[8 | 1<<2]; cat <<E")).toEqual([
      { delim: "E", quoted: false, dash: false },
    ]);
  });

  test("sa10: let unquoted vs quoted heredoc start detection", () => {
    expect(parseHeredocStarts('let "x = 1 << 2"; cat <<A')).toEqual([
      { delim: "A", quoted: false, dash: false },
    ]);
    expect(parseHeredocStarts("let x=1<<2; cat <<A")).toEqual([
      { delim: "2", quoted: false, dash: false },
      { delim: "A", quoted: false, dash: false },
    ]);
  });

  test("sa10 review F2: # after escaped space is not a comment", () => {
    expect(parseHeredocStarts("echo \\ #x; cat <<E")).toEqual([
      { delim: "E", quoted: false, dash: false },
    ]);
  });

  test("sa10 review F3: backslash-escaped << is not a heredoc start", () => {
    expect(parseHeredocStarts("echo \\<<E")).toEqual([]);
    expect(parseHeredocStarts("echo \\\\<<E")).toEqual([
      { delim: "E", quoted: false, dash: false },
    ]);
    expect(parseHeredocStarts("echo \\\\\\<<E")).toEqual([]);
  });

  test("sa11 R1: ( (( and { (( start arithmetic when closed by ))", () => {
    expect(parseHeredocStarts("( (( 1 << 2 )) ); cat <<E")).toEqual([
      { delim: "E", quoted: false, dash: false },
    ]);
    expect(parseHeredocStarts("{ (( 1 << 2 )); }; cat <<E")).toEqual([
      { delim: "E", quoted: false, dash: false },
    ]);
    expect(parseHeredocStarts("if false; then :; else (( 1 << 2 )); fi; cat <<E")).toEqual([
      { delim: "E", quoted: false, dash: false },
    ]);
    expect(parseHeredocStarts("for x in 1; do (( 1 << 2 )); done; cat <<E")).toEqual([
      { delim: "E", quoted: false, dash: false },
    ]);
  });

  test("sa11 R2: $'...' in heredoc delimiter honours backslash escapes", () => {
    expect(parseHeredocStarts("cat <<E$'a\\'b'")).toEqual([
      { delim: "Ea'b", quoted: true, dash: false },
    ]);
  });

  test("sa11 R4: stripHeredocs handles arithmetic spanning newline", () => {
    expect(stripHeredocs("echo $((\n1 << 2)) ; cat <<E\nZZB1\nE\necho ZZB2")).toBe(
      "echo $((\n1 << 2)) ; cat <<E\necho ZZB2",
    );
  });

  test("sa11 review F2: parseHeredocStarts decodes numeric, hex, unicode and control escapes in $''", () => {
    expect(parseHeredocStarts("cat <<E$'\\x41'")).toEqual([
      { delim: "EA", quoted: true, dash: false },
    ]);
    expect(parseHeredocStarts("cat <<E$'\\101'")).toEqual([
      { delim: "EA", quoted: true, dash: false },
    ]);
    expect(parseHeredocStarts("cat <<E$'\\u0041'")).toEqual([
      { delim: "EA", quoted: true, dash: false },
    ]);
    expect(parseHeredocStarts("cat <<E$'\\U00000041'")).toEqual([
      { delim: "EA", quoted: true, dash: false },
    ]);
    expect(parseHeredocStarts("cat <<E$'\\cA'")).toEqual([
      { delim: "E\x01", quoted: true, dash: false },
    ]);
    expect(parseHeredocStarts("cat <<E$'\\c?'")).toEqual([
      { delim: "E\x7f", quoted: true, dash: false },
    ]);
  });

  test("sa13 R1: check commands in subshells and groupings with redirections", () => {
    expect(classifyCommand("(pnpm check) 2>&1 > results.txt")).toMatchObject({
      isCheck: true,
      label: "pnpm check 2>&1 > results.txt",
      unreliable: false,
    });
    expect(classifyCommand("(pnpm test) > results.txt")).toMatchObject({
      isCheck: true,
      label: "pnpm test > results.txt",
      unreliable: false,
    });
    expect(classifyCommand("{ pnpm check; } 2>&1 > results.txt")).toMatchObject({
      isCheck: true,
      label: "pnpm check 2>&1 > results.txt",
      unreliable: false,
    });
  });
});
