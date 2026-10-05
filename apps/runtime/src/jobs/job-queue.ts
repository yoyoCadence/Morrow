import type pg from 'pg';
import type { Queryable } from '../db/pool.js';

export interface EnqueueInput {
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
  /** When set, a job with this key is created at most once. Re-enqueueing returns the existing job. */
  readonly dedupeKey?: string;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
}

export interface EnqueueResult {
  readonly jobId: string;
  /** False when the dedupe key matched an existing job. */
  readonly enqueued: boolean;
}

/**
 * Adds a job. Pass the transaction client that also writes the data the job
 * is about: if that transaction rolls back, the job is never visible, and if
 * it commits, the job cannot be lost.
 */
export async function enqueueJob(db: Queryable, input: EnqueueInput): Promise<EnqueueResult> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, dedupe_key, run_at, max_attempts)
     VALUES ($1, $2::jsonb, $3, COALESCE($4, clock_timestamp()), COALESCE($5, 5))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [input.kind, JSON.stringify(input.payload ?? {}), input.dedupeKey ?? null, input.runAt ?? null, input.maxAttempts ?? null],
  );
  const created = inserted.rows[0];
  if (created) return { jobId: created.id, enqueued: true };

  const existing = await db.query<{ id: string }>('SELECT id FROM jobs WHERE dedupe_key = $1', [input.dedupeKey]);
  const found = existing.rows[0];
  if (!found) throw new Error(`Job with dedupe key "${input.dedupeKey}" conflicted but cannot be read`);
  return { jobId: found.id, enqueued: false };
}

export interface ClaimedJob {
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  /** 1 on the first delivery. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface ClaimOptions {
  readonly workerId: string;
  /** Only these kinds are claimed, so a worker never takes a job it cannot handle. */
  readonly kinds: readonly string[];
  /** How long the worker has before the job may be handed to someone else. */
  readonly leaseMs: number;
}

/**
 * Claims the oldest runnable job. `FOR UPDATE SKIP LOCKED` lets concurrent
 * workers each take a different job without blocking. A job whose lease ran
 * out (its worker crashed or stalled) becomes claimable again, which is what
 * makes delivery at-least-once.
 */
export async function claimJob(pool: pg.Pool, options: ClaimOptions): Promise<ClaimedJob | null> {
  if (options.kinds.length === 0) return null;

  // A job that used its last attempt and then lost its lease will not be retried.
  await pool.query(
    `UPDATE jobs
        SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
            last_error = 'lease expired on the final attempt',
            finished_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE status = 'leased' AND lease_expires_at <= clock_timestamp() AND attempts >= max_attempts`,
  );

  const result = await pool.query<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(
    `WITH candidate AS (
       SELECT id FROM jobs
        WHERE kind = ANY($1::text[])
          AND ((status = 'queued' AND run_at <= clock_timestamp())
            OR (status = 'leased' AND lease_expires_at <= clock_timestamp() AND attempts < max_attempts))
        ORDER BY run_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs
        SET status = 'leased', lease_owner = $2,
            lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000),
            attempts = jobs.attempts + 1, updated_at = clock_timestamp()
       FROM candidate
      WHERE jobs.id = candidate.id
      RETURNING jobs.id, jobs.kind, jobs.payload, jobs.attempts, jobs.max_attempts`,
    [options.kinds, options.workerId, options.leaseMs],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind, payload: row.payload, attempt: row.attempts, maxAttempts: row.max_attempts };
}

/**
 * Marks a job done. Returns false if this worker no longer holds the lease,
 * in which case another worker may be running the job and the caller must not
 * assume its own work counted.
 */
export async function completeJob(db: Queryable, jobId: string, workerId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE jobs
        SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            finished_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'leased' AND lease_owner = $2`,
    [jobId, workerId],
  );
  return result.rowCount === 1;
}

export type FailOutcome = 'retry' | 'dead' | 'lease_lost';

/** Records a failure. The job is retried after `retryDelayMs`, or goes to the dead letter state once attempts run out. */
export async function failJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  error: string,
  retryDelayMs: number,
): Promise<FailOutcome> {
  const result = await db.query<{ status: string }>(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            run_at = CASE WHEN attempts >= max_attempts THEN run_at
                          ELSE clock_timestamp() + make_interval(secs => $4::double precision / 1000) END,
            finished_at = CASE WHEN attempts >= max_attempts THEN clock_timestamp() END,
            lease_owner = NULL, lease_expires_at = NULL,
            last_error = $3, updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'leased' AND lease_owner = $2
      RETURNING status`,
    [jobId, workerId, error.slice(0, 2000), retryDelayMs],
  );
  const row = result.rows[0];
  if (!row) return 'lease_lost';
  return row.status === 'dead' ? 'dead' : 'retry';
}

/**
 * Consumer-side dedupe. Returns true the first time a consumer sees a key and
 * false afterwards. Call it in the same transaction as the consumer's effects
 * so that "seen" and "done" commit together.
 */
export async function markProcessed(db: Queryable, consumer: string, messageKey: string): Promise<boolean> {
  const result = await db.query(
    'INSERT INTO consumer_inbox (consumer, message_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [consumer, messageKey],
  );
  return result.rowCount === 1;
}

export interface JobCounts {
  readonly queued: number;
  readonly leased: number;
  readonly dead: number;
}

export async function countJobs(db: Queryable): Promise<JobCounts> {
  const result = await db.query<{ status: string; count: string }>(
    "SELECT status, count(*)::text AS count FROM jobs WHERE status IN ('queued', 'leased', 'dead') GROUP BY status",
  );
  const counts = { queued: 0, leased: 0, dead: 0 };
  for (const row of result.rows) {
    if (row.status === 'queued' || row.status === 'leased' || row.status === 'dead') counts[row.status] = Number(row.count);
  }
  return counts;
}

export interface JobState {
  readonly status: 'queued' | 'leased' | 'succeeded' | 'dead';
  readonly attempts: number;
  readonly lastError: string | null;
}

export async function getJobState(db: Queryable, jobId: string): Promise<JobState | null> {
  const result = await db.query<{ status: JobState['status']; attempts: number; last_error: string | null }>(
    'SELECT status, attempts, last_error FROM jobs WHERE id = $1',
    [jobId],
  );
  const row = result.rows[0];
  return row ? { status: row.status, attempts: row.attempts, lastError: row.last_error } : null;
}
