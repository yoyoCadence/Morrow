import type pg from 'pg';
import type { Logger } from '../logging/logger.js';
import { claimJob, completeJob, failJob, renewLease, type ClaimedJob } from './job-queue.js';

/**
 * Handles one job. Delivery is at-least-once: the same job can arrive again
 * after a crash or a lost lease, so a handler must be safe to repeat.
 */
export type JobHandler = (job: ClaimedJob) => Promise<void>;

export interface JobWorkerOptions {
  readonly pool: pg.Pool;
  readonly logger: Logger;
  readonly workerId: string;
  readonly handlers: ReadonlyMap<string, JobHandler>;
  /** Removes secrets from an error message before it is stored on the job. */
  readonly redact: (text: string) => string;
  readonly pollIntervalMs?: number;
  /** Lease length. A running job renews it every third of this, so only a stopped or frozen worker loses it. */
  readonly leaseMs?: number;
  /** Delay before the next attempt, given the attempt that just failed. */
  readonly retryDelayMs?: (attempt: number) => number;
}

/** 5 s, 10 s, 20 s ... capped at 5 minutes. */
export function defaultRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 300_000);
}

/**
 * Polls the queue and runs one job at a time. One at a time is deliberate:
 * this is a single-operator system on free API tiers, and serial execution
 * keeps provider pacing simple and predictable. The worker process runs one
 * of these per lane (see `startWorkerProcess`), so jobs of different lanes
 * do not wait for each other.
 */
export class JobWorker {
  readonly #options: JobWorkerOptions;
  readonly #stopController = new AbortController();
  #loop: Promise<void> | null = null;

  constructor(options: JobWorkerOptions) {
    this.#options = options;
  }

  /** Claims and runs at most one job. Returns whether a job was claimed. */
  async runOnce(): Promise<boolean> {
    const { pool, logger, workerId, handlers, redact } = this.#options;
    const leaseMs = this.#options.leaseMs ?? 300_000;
    const job = await claimJob(pool, { workerId, kinds: [...handlers.keys()], leaseMs });
    if (!job) return false;

    const handler = handlers.get(job.kind);
    const log = logger.child({ jobId: job.id, jobKind: job.kind, attempt: job.attempt });
    try {
      if (!handler) throw new Error(`No handler registered for job kind "${job.kind}"`);
      const stopRenewing = keepLease(pool, job.id, workerId, leaseMs, log);
      try {
        await handler(job);
      } finally {
        await stopRenewing();
      }
      const completed = await completeJob(pool, job.id, workerId);
      if (completed) log.info('job succeeded');
      else log.warn('job finished but its lease had been lost; another worker may repeat it');
    } catch (error) {
      const message = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      const delay = (this.#options.retryDelayMs ?? defaultRetryDelayMs)(job.attempt);
      const outcome = await failJob(pool, job.id, workerId, message, delay);
      log.error({ err: error, outcome }, 'job failed');
    }
    return true;
  }

  start(): void {
    if (this.#loop) return;
    this.#loop = this.#run();
  }

  /** Stops polling and waits for the job in flight, if any, to finish. */
  async stop(): Promise<void> {
    this.#stopController.abort();
    await this.#loop;
  }

  async #run(): Promise<void> {
    const signal = this.#stopController.signal;
    const pollIntervalMs = this.#options.pollIntervalMs ?? 1_000;
    while (!signal.aborted) {
      let worked = false;
      let delayMs = pollIntervalMs;
      try {
        worked = await this.runOnce();
      } catch (error) {
        // The queue itself is unreachable (database down, for instance). Keep
        // polling, but slowly, so an outage does not flood the log.
        this.#options.logger.error({ err: error }, 'job polling failed');
        delayMs = Math.max(pollIntervalMs, 5_000);
      }
      if (!worked) await sleep(delayMs, signal);
    }
  }
}

/**
 * Renews a job's lease every third of its length until the returned function
 * is called; that function resolves once no renewal is in flight, so the
 * caller can complete or fail the job without racing one. Without renewal, a
 * job running longer than its lease would be handed out again, or declared
 * dead if it was on its last attempt, while it is still running.
 */
function keepLease(pool: pg.Pool, jobId: string, workerId: string, leaseMs: number, log: Logger): () => Promise<void> {
  let lost = false;
  let inFlight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    inFlight = inFlight.then(async () => {
      if (lost) return;
      try {
        if (await renewLease(pool, jobId, workerId, leaseMs)) return;
        lost = true;
        clearInterval(timer);
        log.warn('lease lost while the job was running; another worker may repeat it');
      } catch (error) {
        // The lease is still ours until it runs out; try again on the next tick.
        log.warn({ err: error }, 'lease renewal failed');
      }
    });
  }, Math.max(1, Math.floor(leaseMs / 3)));
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}

/** Resolves after `ms`, or immediately once the signal aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
