/**
 * Spaces requests at least `minIntervalMs` apart. Callers queue in arrival
 * order, so a burst is smoothed out rather than rejected.
 *
 * The limiter lives in one process. It is authoritative because only the
 * worker calls providers and only one worker session can run at a time.
 */
export class SmoothRateLimiter {
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #nextSlot = 0;

  constructor(minIntervalMs: number, now: () => number, sleep: (ms: number) => Promise<void>) {
    this.#minIntervalMs = minIntervalMs;
    this.#now = now;
    this.#sleep = sleep;
  }

  /** Resolves when the caller may send. */
  async acquire(): Promise<void> {
    const now = this.#now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + this.#minIntervalMs;
    if (slot > now) await this.#sleep(slot - now);
  }
}
