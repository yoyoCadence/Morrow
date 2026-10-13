import type { HealthReport } from '@morrow/core';
import type { Queryable } from '../db/pool.js';

/**
 * Clock skew thresholds. A Date header has one-second resolution and the
 * network adds latency, so a few seconds is noise. Past 30 s, signed requests
 * start failing and every "how old is this data" judgement is off, so the
 * scheduler holds new slots (blueprint fail-safe: clock drift).
 */
export const CLOCK_SKEW_ATTENTION_MS = 5_000;
export const CLOCK_SKEW_DEGRADED_MS = 30_000;
/** Fewer recent responses than this and the skew is not estimated. */
export const CLOCK_SKEW_MIN_SAMPLES = 3;

/**
 * How far this machine's clock is from the providers': the median of the
 * offsets estimated from up to 20 responses of the last 30 minutes (see
 * `clockOffsetMs`). Null when there are too few to say; that is unknown, not zero.
 */
export async function measureClockSkew(db: Queryable): Promise<HealthReport['clock']> {
  const result = await db.query<{ samples: number; median: number | null }>(
    `SELECT count(*)::int AS samples, percentile_cont(0.5) WITHIN GROUP (ORDER BY clock_offset_ms) AS median
       FROM (SELECT clock_offset_ms
               FROM raw_observations
              WHERE clock_offset_ms IS NOT NULL AND available_at > clock_timestamp() - interval '30 minutes'
              ORDER BY available_at DESC
              LIMIT 20) recent`,
  );
  const row = result.rows[0];
  const samples = row?.samples ?? 0;
  if (samples < CLOCK_SKEW_MIN_SAMPLES || row?.median === null || row?.median === undefined) return { skew_ms: null, samples };
  return { skew_ms: Math.round(Number(row.median)), samples };
}
