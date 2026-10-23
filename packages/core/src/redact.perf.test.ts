import { describe, expect, test } from "vitest";
import { redact } from "./redact.js";

// Every secret-like input below is assembled at test time from a deterministic pseudo-random body, so that no file
// of the repository contains a complete realistic secret (fixture secret scan, push protection).

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B64URL = ALNUM + "-_";

/** Deterministic body of `n` characters out of `alphabet` (LCG, seed-dependent, always contains a digit and a letter). */
function body(n: number, seed: number, alphabet = ALNUM): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  let s = "";
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    s += alphabet[(x >>> 8) % alphabet.length];
  }
  // guarantee at least one digit and one letter at fixed positions
  return "7" + s.slice(1, n - 1) + "Q";
}

describe("redact: performance (1 MB adversarial inputs)", () => {
  const MB = 1_000_000;
  const SMALL = MB / 4;
  const RUNS = 3;
  /**
   * Absolute ceiling. Catastrophic backtracking makes a 1 MB input take seconds even on a fast machine; a healthy
   * linear scan stays in the tens or low hundreds of milliseconds, so this leaves room for a heavily loaded CPU.
   */
  const HARD_CEILING_MS = 5_000;
  /**
   * Some cases legitimately do more work than the benign baseline (cookies, env lines). Catastrophic backtracking
   * costs orders of magnitude more than that, so a generous ratio still catches it while tolerating CPU load.
   */
  const BASELINE_RATIO = 80;
  /** 4x the input must not cost more than 8x the time; quadratic growth would be at least 16x. */
  const SCALING_RATIO = 8;
  /** Timings below this are too small to compare reliably. */
  const NOISE_FLOOR_MS = 25;

  const OPTIONS: { usernames?: string[]; repoDir?: string; envFile?: boolean }[] = [
    {},
    { usernames: ["jack"], repoDir: "/home/jack/app", envFile: true },
  ];

  // Ordinary prose that triggers no rule: its runtime is the cost of the linear passes under the current CPU load.
  const BENIGN_UNIT = "The quick brown fox jumps over the lazy dog and then rests by the river. ";
  const benign = (size: number): string => BENIGN_UNIT.repeat(Math.ceil(size / BENIGN_UNIT.length)).slice(0, size);
  const BENIGN_MB = benign(MB);

  /** The adversarial corpus at `size` bytes; running the same shapes at 1 MB and 256 KB exposes super-linear growth. */
  function buildCases(size: number): [string, string][] {
    const rep = (unit: string): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    return [
      ["alphabet run", rep(ALNUM)],
      ["single char run", "a".repeat(size)],
      ["random run with digits", body(size, 110, B64URL)],
      ["sk- repeated", rep("sk-")],
      ["sk-ant- repeated", rep("sk-" + "ant-")],
      ["sk- then near-matches", rep("sk-" + "a".repeat(19) + " ")],
      ["eyJ repeated", rep("eyJ")],
      ["eyJ. repeated", rep("eyJ.")],
      ["eyJ segments never closed", rep("eyJ" + "a".repeat(10) + ".")],
      ["AKIA repeated", rep("AKIA")],
      ["ghp_ near-matches", rep("gh" + "p_" + "a".repeat(10) + " ")],
      ["Bearer spaces", rep("Bearer" + " ".repeat(1000))],
      ["Bearer short tokens", rep("Bearer abc ")],
      ["authorization repeated", rep("authorization:")],
      ["token= repeated", rep("token=")],
      ["token: spaces", rep("token:" + " ".repeat(500))],
      ["password near-matches", rep('password: "' + "a".repeat(400))],
      ["key ident chains", rep("a.b-c_d.e-f_g.")],
      ["scheme separators", rep("://")],
      ["scheme user chain", rep("a://" + "u".repeat(150) + ":" + "p".repeat(150))],
      ["at signs", rep("a@")],
      ["email near-matches", rep("a.b@c.d.e.f.g.h.i.j.k.")],
      ["cookie repeated", rep("cookie:")],
      ["cookie long", rep("cookie:" + "a=b;".repeat(500))],
      ["PEM begin repeated", rep("-----BEGIN A-----")],
      ["PEM begin without label", rep("-----BEGIN -----")],
      ["PEM end repeated", rep("-----END A-----")],
      ["PEM begin with body", ("-----BEGIN " + "PRIVATE KEY-----\n" + "A".repeat(size)).slice(0, size)],
      ["PEM many blocks", rep("-----BEGIN A-----\nx\n-----END A-----\n")],
      ["home prefixes", rep("/home/")],
      ["home near-matches", rep("/home/" + "a".repeat(70) + "/")],
      ["root prefixes", rep("/root")],
      ["cli flags", rep("--token ")],
      ["cli flags near-matches", rep("--token aaaa ")],
      ["env lines", rep("SOME_ENV_VARIABLE_NAME=some value\n")],
      ["env-like comments", rep("# A=b\n")],
      ["env lines with long indentation", rep(" ".repeat(300) + "A=b\n")],
      ["equals padding", rep("a====")],
      ["slashes", rep("/a/")],
      ["many newlines", "\n".repeat(size)],
      ["many spaces", " ".repeat(size)],
      ["unicode", rep("日本語 ")],
    ];
  }

  const cases = buildCases(MB);
  const smallCases = buildCases(SMALL);

  /**
   * Runs every function `RUNS` times, interleaved so all measurements see the same load, and returns each one's
   * minimum. The minimum discards scheduler delays and GC pauses caused by other suites on the same machine, while a
   * genuine slowdown shows up in every run.
   */
  function bestTimes(fns: (() => void)[]): number[] {
    const best = fns.map(() => Number.POSITIVE_INFINITY);
    for (let r = 0; r < RUNS; r++) {
      for (let i = 0; i < fns.length; i++) {
        const t0 = performance.now();
        fns[i]!();
        best[i] = Math.min(best[i]!, performance.now() - t0);
      }
    }
    return best;
  }

  /** Fails if `ms` is too slow in absolute terms, grows super-linearly with input size, or dwarfs the benign baseline. */
  function expectFast(label: string, ms: number, smallMs: number, baselineMs: number): void {
    const detail = `${label}: ${ms.toFixed(0)} ms at 1 MB, ${smallMs.toFixed(0)} ms at 256 KB, benign baseline ${baselineMs.toFixed(0)} ms`;
    expect(ms, `hard ceiling - ${detail}`).toBeLessThan(HARD_CEILING_MS);
    expect(ms, `scaling (super-linear growth) - ${detail}`).toBeLessThan(Math.max(SCALING_RATIO * smallMs, NOISE_FLOOR_MS));
    expect(ms, `ratio to benign baseline - ${detail}`).toBeLessThan(Math.max(BASELINE_RATIO * baselineMs, NOISE_FLOOR_MS));
  }

  test.each(cases.map(([name, text], i) => [name, text, smallCases[i]![1]] as const))(
    "%s",
    { timeout: 60_000 },
    (_name, text, smallText) => {
      expect(text.length).toBe(MB);
      expect(smallText.length).toBe(SMALL);
      for (const o of OPTIONS) {
        const [baselineMs, ms, smallMs] = bestTimes([
          () => void redact(BENIGN_MB, o),
          () => void redact(text, o),
          () => void redact(smallText, o),
        ]) as [number, number, number];
        expectFast(_name, ms, smallMs, baselineMs);
      }
    },
  );

  test("user name and repo dir occurrences", { timeout: 60_000 }, () => {
    const o = { usernames: ["jack"], repoDir: "/home/jack/app" };
    const text = "jack /home/jack/app ".repeat(Math.ceil(MB / 20)).slice(0, MB);
    const small = text.slice(0, SMALL);
    let r!: ReturnType<typeof redact>;
    const [baselineMs, ms, smallMs] = bestTimes([
      () => void redact(BENIGN_MB, o),
      () => void (r = redact(text, o)),
      () => void redact(small, o),
    ]) as [number, number, number];
    expectFast("user name and repo dir occurrences", ms, smallMs, baselineMs);
    expect(r.count).toBeGreaterThan(1000);
  });

  test("a mixed realistic 1 MB log", { timeout: 60_000 }, () => {
    const o = { usernames: ["jack"], repoDir: "/home/jack/git/app" };
    const line = `{"type":"tool_result","text":"ran pnpm test in /home/jack/git/app ok, token_count=12 id 3f2b8c1e-9d4a-4b7e-8a61-2c5d7e9f0a1b"}\n`;
    const text = line.repeat(Math.ceil(MB / line.length)).slice(0, MB);
    const small = text.slice(0, SMALL);
    const [baselineMs, ms, smallMs] = bestTimes([
      () => void redact(BENIGN_MB, o),
      () => void redact(text, o),
      () => void redact(small, o),
    ]) as [number, number, number];
    expectFast("mixed realistic log", ms, smallMs, baselineMs);
  });
});
