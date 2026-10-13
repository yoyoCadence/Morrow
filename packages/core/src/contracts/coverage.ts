import { z } from 'zod';
import { UtcTimestamp } from './primitives.js';

/**
 * Why the worker was not observing during a segment.
 *
 * - OFFLINE: stopped cleanly, not running (a recorded gap).
 * - UNCLEAN_SHUTDOWN: crashed or was killed; until the next start (a recorded gap).
 * - HEARTBEAT_STALL: running, but the machine slept or the process froze (a recorded gap).
 * - HEARTBEAT_LOST: the latest session is still marked RUNNING but has stopped
 *   heartbeating. Not recorded as a gap until the next start notices.
 * - MODE_OFF: running in OFF mode, which contacts no provider.
 * - NO_RECORD: no session and no recorded gap covers it, for example before
 *   the first session ever.
 */
export const COVERAGE_GAP_REASONS = [
  'OFFLINE',
  'UNCLEAN_SHUTDOWN',
  'HEARTBEAT_STALL',
  'HEARTBEAT_LOST',
  'MODE_OFF',
  'NO_RECORD',
] as const;
export const CoverageGapReason = z.enum(COVERAGE_GAP_REASONS);
export type CoverageGapReason = z.infer<typeof CoverageGapReason>;

/** A stretch of the window: observing (reason null) or not (with the reason). */
export const CoverageSegment = z.strictObject({
  start: UtcTimestamp,
  end: UtcTimestamp,
  observing: z.boolean(),
  reason: CoverageGapReason.nullable(),
});
export type CoverageSegment = z.infer<typeof CoverageSegment>;

/**
 * Response of `GET /api/coverage?hours=24|168`: when the worker was
 * observing during the last `hours`, as consecutive segments that cover the
 * whole window. Observing means a worker session in RESEARCH or PAPER mode
 * that was heartbeating.
 */
export const CoverageReport = z.strictObject({
  component: z.literal('worker'),
  from: UtcTimestamp,
  to: UtcTimestamp,
  window_ms: z.number().int().min(0),
  /** Time observing within the window. Missing time is a gap, not "nothing happened". */
  observed_ms: z.number().int().min(0),
  segments: z.array(CoverageSegment),
});
export type CoverageReport = z.infer<typeof CoverageReport>;

/** Window lengths the endpoint accepts, in hours: the last day and the last week. */
export const COVERAGE_WINDOWS_HOURS = [24, 168] as const;
