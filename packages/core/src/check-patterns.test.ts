import { describe, expect, test } from "vitest";
import { classifyCommand, type RepoScripts } from "./check-patterns.js";

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
      expect(r).toEqual({ isCheck: false, label: "", unreliable: false });
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

  test("never throws on odd input", () => {
    for (const c of ['"unterminated', "'x", "\\", "&&&&", "||", ";;;", "<<", "a <<EOF", "\u0000", "(((("]) {
      expect(() => classifyCommand(c)).not.toThrow();
    }
    expect(classifyCommand(undefined as unknown as string).isCheck).toBe(false);
  });
});
