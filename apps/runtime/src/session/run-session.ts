import os from 'node:os';
import type pg from 'pg';
import { writeAudit } from '../db/audit.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode, withTransaction } from '../db/pool.js';

export type Component = 'api' | 'worker';
export type GapKind = 'UNCLEAN_SHUTDOWN' | 'OFFLINE' | 'HEARTBEAT_STALL';

export const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * A session with no heartbeat for this long is treated as gone, and a gap this
 * long between two heartbeats of one session (sleep, hibernate, a long freeze)
 * is recorded as a stall.
 */
export const LIVENESS_THRESHOLD_MS = 30_000;

export class SessionConflictError extends Error {
  constructor(component: Component, pid: number, host: string) {
    super(
      `A ${component} session is already running (pid ${pid} on ${host}). ` +
        `Stop it first with "morrow stop ${component}", or wait ${LIVENESS_THRESHOLD_MS / 1000}s if it crashed.`,
    );
    this.name = 'SessionConflictError';
  }
}

export interface SessionGap {
  readonly kind: GapKind;
  readonly start: Date;
  readonly end: Date;
}

export interface StartSessionInput {
  readonly component: Component;
  readonly mode: string;
  readonly appVersion: string;
  readonly host?: string;
  readonly pid?: number;
  /** Whether a process id is alive on this host. Injectable for tests. */
  readonly isPidAlive?: (pid: number) => boolean;
  readonly livenessThresholdMs?: number;
}

export interface StartedSession {
  readonly sessionId: string;
  /** The interval nobody was observing before this start, if there was one. */
  readonly gap: SessionGap | null;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface SessionRow {
  id: string;
  status: string;
  host: string;
  pid: number;
  last_heartbeat_at: Date;
  ended_at: Date | null;
  db_now: Date;
}

/**
 * Opens a session for a component and records what happened since the last
 * one. If the previous session never stopped cleanly it is marked ABANDONED
 * and the time since its last heartbeat becomes an UNCLEAN_SHUTDOWN gap; after
 * a clean stop the downtime becomes an OFFLINE gap. Either way the gap is
 * explicit, so missing data is never mistaken for "nothing happened".
 */
export async function startSession(pool: pg.Pool, input: StartSessionInput): Promise<StartedSession> {
  const host = input.host ?? os.hostname();
  const pid = input.pid ?? process.pid;
  const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;
  const threshold = input.livenessThresholdMs ?? LIVENESS_THRESHOLD_MS;

  try {
    return await withTransaction(pool, async (tx) => {
      const previous = (
        await tx.query<SessionRow>(
          `SELECT id, status, host, pid, last_heartbeat_at, ended_at, clock_timestamp() AS db_now
             FROM run_sessions WHERE component = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [input.component],
        )
      ).rows[0];

      let pendingGap: (SessionGap & { previousSessionId: string }) | null = null;

      if (previous?.status === 'RUNNING') {
        const heartbeatAge = previous.db_now.getTime() - previous.last_heartbeat_at.getTime();
        // A recycled pid can make a dead process look alive, so a fresh
        // heartbeat is required as well.
        const processMayExist = previous.host !== host || isPidAlive(previous.pid);
        if (heartbeatAge < threshold && processMayExist) {
          throw new SessionConflictError(input.component, previous.pid, previous.host);
        }
        await tx.query("UPDATE run_sessions SET status = 'ABANDONED', ended_at = last_heartbeat_at WHERE id = $1", [
          previous.id,
        ]);
        await writeAudit(tx, {
          actor: input.component,
          action: 'session.abandoned',
          subject: `run_session:${previous.id}`,
          detail: { last_heartbeat_at: previous.last_heartbeat_at.toISOString() },
        });
        pendingGap = {
          kind: 'UNCLEAN_SHUTDOWN',
          start: previous.last_heartbeat_at,
          end: previous.db_now,
          previousSessionId: previous.id,
        };
      } else if (previous?.ended_at) {
        pendingGap = {
          // The previous session stopped cleanly; the downtime since is a gap.
          kind: 'OFFLINE',
          start: previous.ended_at,
          end: previous.db_now,
          previousSessionId: previous.id,
        };
      }

      const created = await tx.query<{ id: string }>(
        'INSERT INTO run_sessions (component, mode, host, pid, app_version) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [input.component, input.mode, host, pid, input.appVersion],
      );
      const sessionId = created.rows[0]?.id;
      if (!sessionId) throw new Error('run_sessions insert returned no row');

      if (pendingGap) {
        await tx.query(
          `INSERT INTO session_gaps (component, kind, gap_start, gap_end, previous_session_id, detected_by_session_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.component, pendingGap.kind, pendingGap.start, pendingGap.end, pendingGap.previousSessionId, sessionId],
        );
      }
      await writeAudit(tx, {
        actor: input.component,
        action: 'session.started',
        subject: `run_session:${sessionId}`,
        detail: { mode: input.mode, app_version: input.appVersion, gap: pendingGap?.kind ?? null },
        runSessionId: sessionId,
      });

      return {
        sessionId,
        gap: pendingGap ? { kind: pendingGap.kind, start: pendingGap.start, end: pendingGap.end } : null,
      };
    });
  } catch (error) {
    // Two processes started at the same instant; the unique index let one in.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new SessionConflictError(input.component, pid, host);
    throw error;
  }
}

export type HeartbeatResult =
  | { readonly status: 'ok'; readonly stopRequested: boolean; readonly stall: SessionGap | null }
  /** The session is no longer RUNNING: another process took over after a long stall. */
  | { readonly status: 'lost' };

/**
 * Records that the session is alive. If the previous heartbeat is older than
 * the stall threshold (the machine slept, or the process froze), the silent
 * interval is stored as a HEARTBEAT_STALL gap.
 */
export async function heartbeat(
  pool: pg.Pool,
  sessionId: string,
  component: Component,
  stallThresholdMs: number = LIVENESS_THRESHOLD_MS,
): Promise<HeartbeatResult> {
  return withTransaction(pool, async (tx) => {
    const result = await tx.query<{ previous: Date; current: Date; stop_requested_at: Date | null }>(
      `WITH previous AS (
         SELECT last_heartbeat_at FROM run_sessions WHERE id = $1 AND status = 'RUNNING' FOR UPDATE
       )
       UPDATE run_sessions
          SET last_heartbeat_at = clock_timestamp()
         FROM previous
        WHERE run_sessions.id = $1
        RETURNING previous.last_heartbeat_at AS previous, run_sessions.last_heartbeat_at AS current,
                  run_sessions.stop_requested_at`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) return { status: 'lost' };

    let stall: SessionGap | null = null;
    if (row.current.getTime() - row.previous.getTime() > stallThresholdMs) {
      stall = { kind: 'HEARTBEAT_STALL', start: row.previous, end: row.current };
      await tx.query(
        `INSERT INTO session_gaps (component, kind, gap_start, gap_end, previous_session_id, detected_by_session_id)
         VALUES ($1, 'HEARTBEAT_STALL', $2, $3, $4, $4)`,
        [component, stall.start, stall.end, sessionId],
      );
    }
    return { status: 'ok', stopRequested: row.stop_requested_at !== null, stall };
  });
}

/** Closes a session cleanly. Returns false if it was not running. */
export async function stopSession(pool: pg.Pool, sessionId: string, component: Component): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const result = await tx.query(
      "UPDATE run_sessions SET status = 'STOPPED', ended_at = clock_timestamp() WHERE id = $1 AND status = 'RUNNING'",
      [sessionId],
    );
    if (result.rowCount !== 1) return false;
    await writeAudit(tx, {
      actor: component,
      action: 'session.stopped',
      subject: `run_session:${sessionId}`,
      runSessionId: sessionId,
    });
    return true;
  });
}

/** Asks running sessions to shut down. Returns the components that were asked. */
export async function requestStop(pool: pg.Pool, components: readonly Component[]): Promise<Component[]> {
  return withTransaction(pool, async (tx) => {
    const result = await tx.query<{ id: string; component: Component }>(
      `UPDATE run_sessions SET stop_requested_at = clock_timestamp()
        WHERE status = 'RUNNING' AND component = ANY($1::text[]) AND stop_requested_at IS NULL
        RETURNING id, component`,
      [components],
    );
    for (const row of result.rows) {
      await writeAudit(tx, { actor: 'operator', action: 'session.stop_requested', subject: `run_session:${row.id}` });
    }
    return result.rows.map((row) => row.component);
  });
}

export interface SessionKeeperOptions {
  readonly pool: pg.Pool;
  readonly sessionId: string;
  readonly component: Component;
  readonly intervalMs?: number;
  /** Called once when the process should shut down: a stop was requested or the session was lost. */
  readonly onShutdownRequested: (reason: 'stop_requested' | 'session_lost') => void;
  readonly onStall?: (gap: SessionGap) => void;
  readonly onError?: (error: unknown) => void;
}

/** Sends heartbeats on a timer and relays stop requests. Returns a function that stops the timer. */
export function keepSessionAlive(options: SessionKeeperOptions): () => void {
  let notified = false;
  let busy = false;
  const timer = setInterval(() => {
    if (busy || notified) return;
    busy = true;
    heartbeat(options.pool, options.sessionId, options.component)
      .then((result) => {
        if (result.status === 'lost') {
          notified = true;
          options.onShutdownRequested('session_lost');
          return;
        }
        if (result.stall) options.onStall?.(result.stall);
        if (result.stopRequested) {
          notified = true;
          options.onShutdownRequested('stop_requested');
        }
      })
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        busy = false;
      });
  }, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}
