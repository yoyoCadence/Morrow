import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import type { Logger } from '../logging/logger.js';
import { enqueueJob } from './job-queue.js';
import { sleep } from './worker.js';

/**
 * A job that runs on a fixed cadence (the blueprint's "固定排程"). Time is
 * divided into slots of `everyMs`, aligned to the UTC epoch, so a 5-minute
 * schedule has slots at :00, :05, :10 and so on, whenever the worker started.
 * Each slot enqueues at most one job.
 *
 * One schedule is one job per slot, not one per token or address: a handler
 * that covers several (the six active tokens, the warm universe) loops over
 * them itself.
 */
export interface Schedule {
  /** Stable name, part of every job's dedupe key. Renaming it starts a new series. */
  readonly name: string;
  /** The job kind to enqueue. A handler for it must be registered. */
  readonly kind: string;
  readonly everyMs: number;
  /** Added to every job's payload, beside `schedule` and `slot_start`, which the scheduler sets. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * Default 1: the next slot is the retry. A later attempt of an old slot
   * would observe the same present as the next slot does.
   */
  readonly maxAttempts?: number;
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MIN_EVERY_MS = 1_000;

/** Throws on a schedule list that cannot work: bad names, duplicates, or slots shorter than a second. */
export function validateSchedules(schedules: readonly Schedule[]): void {
  const seen = new Set<string>();
  for (const schedule of schedules) {
    if (!NAME.test(schedule.name)) throw new Error(`Schedule name "${schedule.name}" must match ${NAME}`);
    if (seen.has(schedule.name)) throw new Error(`Schedule "${schedule.name}" is defined twice`);
    seen.add(schedule.name);
    if (!Number.isInteger(schedule.everyMs) || schedule.everyMs < MIN_EVERY_MS) {
      throw new Error(`Schedule "${schedule.name}": everyMs must be a whole number of at least ${MIN_EVERY_MS}`);
    }
  }
}

/** Start of the slot that contains `at`. */
export function slotStart(at: Date, everyMs: number): Date {
  return new Date(Math.floor(at.getTime() / everyMs) * everyMs);
}

/** The dedupe key of a slot's job: a slot is enqueued once, however many ticks or workers see it. */
export function scheduleDedupeKey(name: string, slot: Date): string {
  return `schedule:${name}:${slot.toISOString()}`;
}

/** Why slots are skipped while the scheduler is running. */
export type SkipReason =
  /** The previous slot's job has not started yet; another would only queue behind it. */
  | 'BACKLOG'
  /**
   * This machine's clock is too far from the providers' (blueprint fail-safe:
   * clock drift): slots computed from it, and what would be observed in
   * them, cannot be trusted.
   */
  | 'CLOCK_SKEW';

/**
 * Why slots were not run. NOT_SCHEDULED: no tick reached the database during
 * them (the worker was not running, was asleep, or could not reach the
 * database). Otherwise the reason they were skipped.
 */
export type GapReason = 'NOT_SCHEDULED' | SkipReason;

/** Slots a schedule did not run, recorded in `schedule_gaps`. */
export interface ScheduleGap {
  readonly reason: GapReason;
  /** Start of the first missed slot. */
  readonly start: Date;
  /** End of the last missed slot. */
  readonly end: Date;
  readonly missedSlots: number;
}

export type ScheduleOutcome =
  | { readonly kind: 'enqueued'; readonly slotStart: Date; readonly jobId: string; readonly gaps: readonly ScheduleGap[] }
  | { readonly kind: 'skipped'; readonly reason: SkipReason; readonly slotStart: Date; readonly gaps: readonly ScheduleGap[] }
  /** This slot was already dealt with. */
  | { readonly kind: 'up_to_date'; readonly slotStart: Date; readonly gaps: readonly ScheduleGap[] };

interface StateRow {
  every_ms: string;
  last_slot_start: Date;
  last_job_id: string | null;
  skip_since: Date | null;
  skip_reason: SkipReason | null;
}

interface SkipRun {
  readonly since: Date;
  readonly reason: SkipReason;
}

function gap(reason: GapReason, start: Date, end: Date, everyMs: number): ScheduleGap {
  return { reason, start, end, missedSlots: Math.round((end.getTime() - start.getTime()) / everyMs) };
}

/**
 * Brings one schedule up to the slot containing `at`, in one transaction:
 *
 * - If whole slots passed without any tick reaching the database, they are
 *   recorded as one NOT_SCHEDULED gap and only the current slot is
 *   considered. Missed slots are never run late.
 * - The current slot is skipped while `hold` says so (the clock cannot be
 *   trusted), or while the previous slot's job is still queued (a second job
 *   would only wait behind it and then observe the same present). A run of
 *   skipped slots is recorded as one gap, with its reason, when it ends.
 * - Otherwise the current slot is enqueued. The first time, or after the slot
 *   length changed, nothing before it is counted.
 *
 * The state row is locked, and every job has a per-slot dedupe key, so
 * concurrent calls enqueue a slot once.
 */
export async function advanceSchedule(
  pool: pg.Pool,
  schedule: Schedule,
  input: { readonly at: Date; readonly sessionId: string | null; readonly hold?: 'CLOCK_SKEW' | null },
): Promise<ScheduleOutcome> {
  const every = schedule.everyMs;
  const current = slotStart(input.at, every);
  const hold = input.hold ?? null;

  return withTransaction(pool, async (tx) => {
    const enqueue = async (): Promise<string> => {
      const { jobId } = await enqueueJob(tx, {
        kind: schedule.kind,
        payload: { ...schedule.payload, schedule: schedule.name, slot_start: current.toISOString() },
        dedupeKey: scheduleDedupeKey(schedule.name, current),
        maxAttempts: schedule.maxAttempts ?? 1,
      });
      return jobId;
    };
    const save = (lastJobId: string | null, skip: SkipRun | null) =>
      tx.query(
        `UPDATE schedule_state
            SET every_ms = $2, last_slot_start = $3, last_job_id = $4, skip_since = $5, skip_reason = $6,
                updated_at = clock_timestamp()
          WHERE name = $1`,
        [schedule.name, every, current, lastJobId, skip?.since ?? null, skip?.reason ?? null],
      );
    // The first slot of a series: nothing before it was promised.
    const startSeries = async (): Promise<ScheduleOutcome> => {
      if (hold) {
        await save(null, { since: current, reason: hold });
        return { kind: 'skipped', reason: hold, slotStart: current, gaps: [] };
      }
      const jobId = await enqueue();
      await save(jobId, null);
      return { kind: 'enqueued', slotStart: current, jobId, gaps: [] };
    };

    const created = await tx.query(
      `INSERT INTO schedule_state (name, every_ms, last_slot_start) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING RETURNING name`,
      [schedule.name, every, current],
    );
    if (created.rowCount === 1) return startSeries();

    const state = (
      await tx.query<StateRow>(
        'SELECT every_ms, last_slot_start, last_job_id, skip_since, skip_reason FROM schedule_state WHERE name = $1 FOR UPDATE',
        [schedule.name],
      )
    ).rows[0];
    if (!state) throw new Error(`Schedule state for "${schedule.name}" disappeared`);
    // A new slot length is a new series; the old slots do not map onto the new ones.
    if (Number(state.every_ms) !== every) return startSeries();
    // The same slot again, or a clock that moved back.
    if (current.getTime() <= state.last_slot_start.getTime()) return { kind: 'up_to_date', slotStart: current, gaps: [] };

    const gaps: ScheduleGap[] = [];
    let skip: SkipRun | null = state.skip_since && state.skip_reason ? { since: state.skip_since, reason: state.skip_reason } : null;
    const expectedNext = new Date(state.last_slot_start.getTime() + every);
    if (current.getTime() > expectedNext.getTime()) {
      // Whole slots passed without a tick reaching the database.
      if (skip) gaps.push(gap(skip.reason, skip.since, expectedNext, every));
      skip = null;
      gaps.push(gap('NOT_SCHEDULED', expectedNext, current, every));
    }

    const previous =
      state.last_job_id === null
        ? undefined
        : (await tx.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [state.last_job_id])).rows[0];
    const reason: SkipReason | null = hold ?? (previous?.status === 'queued' ? 'BACKLOG' : null);

    let outcome: ScheduleOutcome;
    if (reason) {
      // A different reason ends the current run and starts another.
      if (skip && skip.reason !== reason) {
        gaps.push(gap(skip.reason, skip.since, current, every));
        skip = null;
      }
      skip ??= { since: current, reason };
      await save(state.last_job_id, skip);
      outcome = { kind: 'skipped', reason, slotStart: current, gaps };
    } else {
      if (skip) gaps.push(gap(skip.reason, skip.since, current, every));
      const jobId = await enqueue();
      await save(jobId, null);
      outcome = { kind: 'enqueued', slotStart: current, jobId, gaps };
    }

    for (const recorded of gaps) {
      await tx.query(
        `INSERT INTO schedule_gaps (schedule, reason, gap_start, gap_end, missed_slots, detected_by_session_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [schedule.name, recorded.reason, recorded.start, recorded.end, recorded.missedSlots, input.sessionId],
      );
    }
    return outcome;
  });
}

export interface SchedulerOptions {
  readonly pool: pg.Pool;
  readonly logger: Logger;
  readonly schedules: readonly Schedule[];
  readonly sessionId: string;
  /**
   * How far this machine's clock is from the providers', in ms, or null when
   * unknown. Read once per tick in which a slot begins.
   */
  readonly clockSkewMs: () => Promise<number | null>;
  /** Past this skew, in either direction, slots are held (CLOCK_SKEW). */
  readonly maxClockSkewMs: number;
  /** How often slot boundaries are checked. The database is touched only when one has passed. */
  readonly tickMs?: number;
  /** For tests. */
  readonly now?: () => Date;
}

/**
 * Runs `advanceSchedule` for each schedule as its slots begin. Between slot
 * boundaries a tick is arithmetic only. A failure (the database is down) is
 * logged and retried a few seconds later; the slots it costs are recorded as
 * a gap by the next successful call.
 *
 * Slots are held while the measured clock skew is past `maxClockSkewMs`. An
 * unknown skew does not hold them: the skew is measured from provider
 * responses, so holding until it is known would never send the requests that
 * measure it. With a bad clock that means a few requests every half hour,
 * after the last measurements age out, and then the slots are held again.
 */
export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #stopController = new AbortController();
  /** When each schedule next needs the database; absent means now. */
  readonly #nextDueMs = new Map<string, number>();
  #loop: Promise<void> | null = null;

  constructor(options: SchedulerOptions) {
    validateSchedules(options.schedules);
    this.#options = options;
  }

  /** Advances every schedule that is due. */
  async tick(): Promise<void> {
    const { pool, logger, schedules, sessionId } = this.#options;
    const now = this.#options.now?.() ?? new Date();
    const due = schedules.filter((schedule) => now.getTime() >= (this.#nextDueMs.get(schedule.name) ?? 0));
    if (due.length === 0) return;

    let skewMs: number | null;
    try {
      skewMs = await this.#options.clockSkewMs();
    } catch (error) {
      logger.error({ err: error }, 'clock skew could not be measured; schedules wait');
      for (const schedule of due) this.#nextDueMs.set(schedule.name, now.getTime() + 5_000);
      return;
    }
    const hold = skewMs !== null && Math.abs(skewMs) > this.#options.maxClockSkewMs ? 'CLOCK_SKEW' : null;

    for (const schedule of due) {
      if (this.#stopController.signal.aborted) return;
      const log = logger.child({ schedule: schedule.name });
      try {
        const outcome = await advanceSchedule(pool, schedule, { at: now, sessionId, hold });
        this.#nextDueMs.set(schedule.name, outcome.slotStart.getTime() + schedule.everyMs);
        for (const missed of outcome.gaps) {
          log.warn(
            { reason: missed.reason, gapStart: missed.start.toISOString(), gapEnd: missed.end.toISOString(), missedSlots: missed.missedSlots },
            'scheduled slots were not run; recorded as a gap',
          );
        }
        if (outcome.kind === 'enqueued') log.debug({ jobId: outcome.jobId, slotStart: outcome.slotStart.toISOString() }, 'slot enqueued');
        if (outcome.kind === 'skipped' && outcome.reason === 'BACKLOG') {
          log.warn({ slotStart: outcome.slotStart.toISOString() }, 'slot skipped: the previous slot has not started yet');
        }
        if (outcome.kind === 'skipped' && outcome.reason === 'CLOCK_SKEW') {
          log.error(
            { slotStart: outcome.slotStart.toISOString(), clockSkewMs: skewMs },
            "slot held: this machine's clock is too far from the providers'",
          );
        }
      } catch (error) {
        log.error({ err: error }, 'schedule could not be advanced');
        this.#nextDueMs.set(schedule.name, now.getTime() + 5_000);
      }
    }
  }

  start(): void {
    if (this.#loop) return;
    this.#loop = this.#run();
  }

  /** Stops ticking and waits for a tick in progress to finish. */
  async stop(): Promise<void> {
    this.#stopController.abort();
    await this.#loop;
  }

  async #run(): Promise<void> {
    const signal = this.#stopController.signal;
    while (!signal.aborted) {
      await this.tick();
      await sleep(this.#options.tickMs ?? 1_000, signal);
    }
  }
}
