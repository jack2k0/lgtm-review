import { describe, expect, test, vi } from "vitest";
import { BACKOFF_MS, POLL_MS, Poller, delayAfter, formatUpdated, nextDelay, readPaused, writePaused, type PollOutcome, type Timers } from "./live";

describe("schedule", () => {
  test("5 s -> 10 s -> 30 s, capped, reset by success (failures = 0)", () => {
    expect(POLL_MS).toBe(5_000);
    expect(BACKOFF_MS).toEqual([5_000, 10_000, 30_000]);
    expect([0, 1, 2, 3, 10, 1000].map(delayAfter)).toEqual([5_000, 10_000, 30_000, 30_000, 30_000, 30_000]);
    expect(delayAfter(-1)).toBe(5_000);
    expect(delayAfter(1.9)).toBe(10_000);
  });
  test("no delay while paused or hidden", () => {
    expect(nextDelay({ paused: false, visible: true, failures: 0 })).toBe(5_000);
    expect(nextDelay({ paused: false, visible: true, failures: 2 })).toBe(30_000);
    expect(nextDelay({ paused: true, visible: true, failures: 0 })).toBeNull();
    expect(nextDelay({ paused: false, visible: false, failures: 0 })).toBeNull();
    expect(nextDelay({ paused: true, visible: false, failures: 1 })).toBeNull();
  });
  test("formatUpdated is local HH:MM:SS", () => {
    expect(formatUpdated(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("03:04:05");
    expect(formatUpdated(new Date(2026, 0, 2, 23, 59, 9).getTime())).toBe("23:59:09");
  });
});

describe("pause preference storage", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  test("default is live; round-trips", () => {
    const s = mem();
    expect(readPaused(s)).toBe(false);
    writePaused(s, true);
    expect(readPaused(s)).toBe(true);
    writePaused(s, false);
    expect(readPaused(s)).toBe(false);
  });
  test("missing or throwing storage never throws", () => {
    expect(readPaused(null)).toBe(false);
    expect(readPaused(broken)).toBe(false);
    expect(() => writePaused(broken, true)).not.toThrow();
    expect(() => writePaused(null, true)).not.toThrow();
  });
});

/** Manual clock: timers fire only when `advance` passes them. */
function fakeClock() {
  let now = 0;
  let id = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers<number> = {
    set: (fn, ms) => {
      pending.set(++id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void pending.delete(h),
  };
  return {
    timers,
    pendingDelays: () => [...pending.values()].map((p) => p.at - now),
    count: () => pending.size,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = end;
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness(results: (PollOutcome | Error)[], opts: { paused?: boolean; visible?: boolean; retryable?: (e: unknown) => boolean } = {}) {
  const clock = fakeClock();
  const calls: AbortSignal[] = [];
  const log: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const poller = new Poller<number>({
    timers: clock.timers,
    paused: opts.paused ?? false,
    visible: opts.visible ?? true,
    ...(opts.retryable ? { retryable: opts.retryable } : {}),
    run: async (signal) => {
      calls.push(signal);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        await Promise.resolve();
        const r = results[Math.min(calls.length - 1, results.length - 1)]!;
        if (r instanceof Error) throw r;
        return r;
      } finally {
        concurrent--;
      }
    },
    onSuccess: (o) => log.push(`ok:${o}`),
    onFailure: (_e, n) => log.push(`fail:${n}`),
  });
  return { poller, clock, calls, log, maxConcurrent: () => maxConcurrent };
}

describe("Poller", () => {
  test("first request at start, then every 5 s after the previous one finished", async () => {
    const h = harness(["changed", "same"]);
    h.poller.start();
    await flush();
    expect(h.calls.length).toBe(1);
    expect(h.clock.pendingDelays()).toEqual([5_000]);
    await h.clock.advance(4_999);
    expect(h.calls.length).toBe(1);
    await h.clock.advance(1);
    expect(h.calls.length).toBe(2);
    await h.clock.advance(5_000);
    expect(h.calls.length).toBe(3);
    expect(h.log).toEqual(["ok:changed", "ok:same", "ok:same"]);
    expect(h.maxConcurrent()).toBe(1);
    h.poller.stop();
  });

  test("never overlaps: the next timer is armed only after a slow request settles", async () => {
    const clock = fakeClock();
    let release!: () => void;
    let n = 0;
    const poller = new Poller<number>({
      timers: clock.timers,
      paused: false,
      visible: true,
      run: () => {
        n++;
        return n === 1 ? new Promise<PollOutcome>((r) => (release = () => r("same"))) : Promise.resolve("same");
      },
    });
    poller.start();
    await clock.advance(60_000);
    expect(n).toBe(1);
    expect(clock.count()).toBe(0);
    release();
    await flush();
    expect(clock.pendingDelays()).toEqual([5_000]);
    poller.stop();
  });

  test("failures back off 10 s then 30 s; success resets to 5 s", async () => {
    const h = harness([new Error("x"), new Error("x"), new Error("x"), "same", "same"]);
    h.poller.start();
    await flush();
    expect(h.clock.pendingDelays()).toEqual([10_000]);
    await h.clock.advance(10_000);
    expect(h.clock.pendingDelays()).toEqual([30_000]);
    await h.clock.advance(30_000);
    expect(h.clock.pendingDelays()).toEqual([30_000]);
    await h.clock.advance(30_000); // 4th call succeeds
    expect(h.clock.pendingDelays()).toEqual([5_000]);
    expect(h.log).toEqual(["fail:1", "fail:2", "fail:3", "ok:same"]);
    h.poller.stop();
  });

  test("hiding the tab cancels the timer; becoming visible refetches immediately", async () => {
    const h = harness(["same"]);
    h.poller.start();
    await flush();
    h.poller.setVisible(false);
    expect(h.clock.count()).toBe(0);
    await h.clock.advance(120_000);
    expect(h.calls.length).toBe(1);
    h.poller.setVisible(true);
    await flush();
    expect(h.calls.length).toBe(2);
    expect(h.clock.pendingDelays()).toEqual([5_000]);
    h.poller.stop();
  });

  test("pause stops polling, resume refetches at once; resume while hidden waits for visibility", async () => {
    const h = harness(["same"]);
    h.poller.start();
    await flush();
    h.poller.setPaused(true);
    await h.clock.advance(60_000);
    expect(h.calls.length).toBe(1);
    h.poller.setVisible(true); // no-op: already visible
    h.poller.setVisible(false);
    h.poller.setPaused(false);
    await flush();
    expect(h.calls.length).toBe(1);
    h.poller.setVisible(true);
    await flush();
    expect(h.calls.length).toBe(2);
    h.poller.stop();
  });

  test("a hidden tab at start still loads once, then stays quiet", async () => {
    const h = harness(["changed"], { visible: false });
    h.poller.start();
    await flush();
    expect(h.calls.length).toBe(1);
    expect(h.clock.count()).toBe(0);
    h.poller.stop();
  });

  test("ABORT: stop() aborts the request in flight, drops its result and arms no timer", async () => {
    const clock = fakeClock();
    let signal!: AbortSignal;
    let resolve!: (o: PollOutcome) => void;
    const seen: string[] = [];
    const poller = new Poller<number>({
      timers: clock.timers,
      paused: false,
      visible: true,
      run: (s) => {
        signal = s;
        return new Promise<PollOutcome>((r) => (resolve = r));
      },
      onSuccess: () => seen.push("success"),
      onFailure: () => seen.push("failure"),
    });
    poller.start();
    expect(poller.inFlight).toBe(true);
    expect(signal.aborted).toBe(false);
    poller.stop();
    expect(signal.aborted).toBe(true);
    expect(poller.inFlight).toBe(false);
    resolve("changed"); // late result of the aborted request
    await flush();
    expect(seen).toEqual([]);
    expect(clock.count()).toBe(0);
    await clock.advance(60_000);
    expect(poller.inFlight).toBe(false);
  });

  test("ABORT: a request rejected because of the abort is not a failure", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const poller = new Poller<number>({
      timers: clock.timers,
      paused: false,
      visible: true,
      run: (s) => new Promise<PollOutcome>((_, rej) => s.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
      onFailure: () => seen.push("failure"),
    });
    poller.start();
    poller.stop();
    await flush();
    expect(seen).toEqual([]);
    expect(clock.count()).toBe(0);
  });

  test("stop() cancels a pending timer; start() works again afterwards", async () => {
    const h = harness(["same"]);
    h.poller.start();
    await flush();
    expect(h.clock.count()).toBe(1);
    h.poller.stop();
    expect(h.clock.count()).toBe(0);
    h.poller.start();
    await flush();
    expect(h.calls.length).toBe(2);
    h.poller.stop();
  });

  test("non-retryable error halts the chain; resume restarts it", async () => {
    const h = harness([new Error("403"), "changed"], { retryable: () => false });
    h.poller.start();
    await flush();
    expect(h.log).toEqual(["fail:1"]);
    expect(h.clock.count()).toBe(0);
    h.poller.setPaused(true);
    h.poller.setPaused(false);
    await flush();
    expect(h.log).toEqual(["fail:1", "ok:changed"]);
    expect(h.clock.pendingDelays()).toEqual([5_000]);
    h.poller.stop();
  });

  test("works with the real timers type too", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const poller = new Poller<ReturnType<typeof setTimeout>>({
        timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
        paused: false,
        visible: true,
        run: async () => (n++, "same"),
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(n).toBe(3);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
