import type { KeyValueStore } from "./token";

/** Delay before the next poll after 0, 1, and 2+ consecutive failures. A success resets to the first. */
export const BACKOFF_MS: readonly number[] = [5_000, 10_000, 30_000];
export const POLL_MS = BACKOFF_MS[0]!;

export function delayAfter(failures: number): number {
  return BACKOFF_MS[Math.min(Math.max(0, Math.trunc(failures)), BACKOFF_MS.length - 1)]!;
}

/** Delay until the next request, or null when none should be scheduled (paused or tab hidden). */
export function nextDelay(s: { paused: boolean; visible: boolean; failures: number }): number | null {
  return s.paused || !s.visible ? null : delayAfter(s.failures);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local `HH:MM:SS` of an epoch-ms instant. */
export function formatUpdated(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const PAUSE_KEY = "lgtm-live-paused";

/** Live is on by default; only an explicit "1" in the (per-tab) store pauses it. Storage may throw. */
export function readPaused(store: KeyValueStore | null): boolean {
  try {
    return store?.getItem(PAUSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writePaused(store: KeyValueStore | null, paused: boolean): void {
  try {
    store?.setItem(PAUSE_KEY, paused ? "1" : "0");
  } catch {
    /* keep it in memory only */
  }
}

/** "changed": new data was applied; "same": the server answered 304. */
export type PollOutcome = "changed" | "same";

export interface Timers<H> {
  set(fn: () => void, ms: number): H;
  clear(h: H): void;
}

export interface PollerOptions<H = unknown> {
  /** One request. Must reject (not resolve) on failure; an aborted request's result is ignored. */
  run(signal: AbortSignal): Promise<PollOutcome>;
  onSuccess?(outcome: PollOutcome): void;
  /** `failures` counts consecutive failures including this one. */
  onFailure?(error: unknown, failures: number): void;
  /** False stops the chain after this error until `setPaused(false)`/`refreshNow()` (e.g. 403 on the first load). */
  retryable?(error: unknown): boolean;
  timers: Timers<H>;
  visible: boolean;
  paused: boolean;
}

/**
 * Single timer chain: the next poll is scheduled only after the previous request finished, so requests never
 * overlap. The first request runs on `start()` regardless of pause/visibility (the view needs data);
 * afterwards polling pauses while paused or hidden and resumes at once when allowed again.
 */
export class Poller<H = unknown> {
  private timer: H | null = null;
  private ac: AbortController | null = null;
  private failures = 0;
  private stopped = true;
  private halted = false;
  private paused: boolean;
  private visible: boolean;

  constructor(private readonly o: PollerOptions<H>) {
    this.paused = o.paused;
    this.visible = o.visible;
  }

  get inFlight(): boolean {
    return this.ac !== null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  /** Cancels the timer and aborts a request in flight; its result is dropped. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.ac?.abort();
    this.ac = null;
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.clearTimer();
    else this.refreshNow();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) this.clearTimer();
    else this.refreshNow();
  }

  /** Requests immediately when polling is allowed and nothing is in flight (restarts a halted chain). */
  refreshNow(): void {
    if (this.stopped || this.ac || this.paused || !this.visible) return;
    this.halted = false;
    this.clearTimer();
    void this.tick();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.o.timers.clear(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || this.ac) return;
    const ac = new AbortController();
    this.ac = ac;
    try {
      const outcome = await this.o.run(ac.signal);
      if (ac.signal.aborted) return;
      this.failures = 0;
      this.ac = null;
      this.o.onSuccess?.(outcome);
    } catch (e) {
      if (ac.signal.aborted) return;
      this.ac = null;
      this.failures++;
      this.o.onFailure?.(e, this.failures);
      if (this.o.retryable && !this.o.retryable(e)) this.halted = true;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.halted || this.timer !== null) return;
    const ms = nextDelay({ paused: this.paused, visible: this.visible, failures: this.failures });
    if (ms === null) return;
    this.timer = this.o.timers.set(() => void this.tick(), ms);
  }
}
