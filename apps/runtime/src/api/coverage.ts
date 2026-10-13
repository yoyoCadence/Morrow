import type { CoverageGapReason, CoverageReport, CoverageSegment } from '@morrow/core';
import type { Queryable } from '../db/pool.js';
import { LIVENESS_THRESHOLD_MS } from '../session/run-session.js';

/** A worker session, as an interval of time it was running. */
export interface SessionSpan {
  readonly start: number;
  /** Last moment it is known to have been running: now while live, its last heartbeat once silent, its end once ended. */
  readonly end: number;
  readonly mode: string;
  /** Still marked RUNNING but no longer heartbeating: the time after `end` is a gap nobody has recorded yet. */
  readonly lost: boolean;
}

export interface GapSpan {
  readonly kind: 'UNCLEAN_SHUTDOWN' | 'OFFLINE' | 'HEARTBEAT_STALL';
  readonly start: number;
  readonly end: number;
}

const OBSERVING_MODES: ReadonlySet<string> = new Set(['RESEARCH', 'PAPER']);

/**
 * Records that meet are stamped by separate clock reads: a restart's gap ends
 * at the moment the new session's transaction began, and the session row is
 * stamped a little later. An unrecorded stretch shorter than this is that
 * seam, not a real hole, and joins the segment before it.
 */
const SEAM_MS = 1_000;

const covers = (span: { start: number; end: number }, at: number): boolean => span.start <= at && at < span.end;

/** What the worker was doing at one instant: observing (null) or the reason it was not. */
function stateAt(at: number, sessions: readonly SessionSpan[], gaps: readonly GapSpan[]): CoverageGapReason | null {
  // A stall is recorded inside a session: the session was open but nothing ran.
  if (gaps.some((gap) => gap.kind === 'HEARTBEAT_STALL' && covers(gap, at))) return 'HEARTBEAT_STALL';
  const session = sessions.find((candidate) => covers(candidate, at));
  if (session) return OBSERVING_MODES.has(session.mode) ? null : 'MODE_OFF';
  const gap = gaps.find((candidate) => candidate.kind !== 'HEARTBEAT_STALL' && covers(candidate, at));
  if (gap) return gap.kind;
  if (sessions.some((candidate) => candidate.lost && at >= candidate.end)) return 'HEARTBEAT_LOST';
  return 'NO_RECORD';
}

/**
 * Splits [from, to) into consecutive segments, each observing or not with
 * one reason. Every session and gap boundary inside the window starts a new
 * elementary interval; neighbours with the same state are merged.
 */
export function coverageSegments(
  from: number,
  to: number,
  sessions: readonly SessionSpan[],
  gaps: readonly GapSpan[],
): Array<{ start: number; end: number; reason: CoverageGapReason | null }> {
  if (to <= from) return [];
  const cuts = new Set<number>([from, to]);
  for (const span of [...sessions, ...gaps]) {
    for (const at of [span.start, span.end]) if (at > from && at < to) cuts.add(at);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: Array<{ start: number; end: number; reason: CoverageGapReason | null }> = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index] as number;
    const end = points[index + 1] as number;
    let reason = stateAt(start, sessions, gaps);
    const previous = segments[segments.length - 1];
    if (previous && reason === 'NO_RECORD' && end - start < SEAM_MS) reason = previous.reason;
    if (previous && previous.reason === reason) previous.end = end;
    else segments.push({ start, end, reason });
  }
  return segments;
}

/**
 * Coverage of the worker over the last `hours`, ending now by the
 * database's clock (the same clock that stamps heartbeats).
 */
export async function buildCoverage(db: Queryable, hours: number): Promise<CoverageReport> {
  const clock = await db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const to = (clock.rows[0]?.now ?? new Date()).getTime();
  const from = to - hours * 3_600_000;

  const sessionRows = await db.query<{
    mode: string;
    status: string;
    started_at: Date;
    last_heartbeat_at: Date;
    ended_at: Date | null;
  }>(
    `SELECT mode, status, started_at, last_heartbeat_at, ended_at
       FROM run_sessions
      WHERE component = 'worker' AND started_at < $2 AND COALESCE(ended_at, 'infinity'::timestamptz) > $1
      ORDER BY started_at`,
    [new Date(from), new Date(to)],
  );
  const sessions: SessionSpan[] = sessionRows.rows.map((row) => {
    if (row.ended_at !== null) {
      // STOPPED ends when it stopped; ABANDONED was closed at its last heartbeat.
      return { start: row.started_at.getTime(), end: row.ended_at.getTime(), mode: row.mode, lost: false };
    }
    const lost = to - row.last_heartbeat_at.getTime() > LIVENESS_THRESHOLD_MS;
    return { start: row.started_at.getTime(), end: lost ? row.last_heartbeat_at.getTime() : to, mode: row.mode, lost };
  });

  const gapRows = await db.query<{ kind: GapSpan['kind']; gap_start: Date; gap_end: Date }>(
    `SELECT kind, gap_start, gap_end FROM session_gaps
      WHERE component = 'worker' AND gap_start < $2 AND gap_end > $1`,
    [new Date(from), new Date(to)],
  );
  const gaps: GapSpan[] = gapRows.rows.map((row) => ({
    kind: row.kind,
    start: row.gap_start.getTime(),
    end: row.gap_end.getTime(),
  }));

  const spans = coverageSegments(from, to, sessions, gaps);
  const segments: CoverageSegment[] = spans.map((segment) => ({
    start: new Date(segment.start).toISOString(),
    end: new Date(segment.end).toISOString(),
    observing: segment.reason === null,
    reason: segment.reason,
  }));
  const observed = spans
    .filter((segment) => segment.reason === null)
    .reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  return {
    component: 'worker',
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    window_ms: Math.round(to - from),
    observed_ms: Math.round(observed),
    segments,
  };
}
