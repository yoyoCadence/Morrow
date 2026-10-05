import type { EnabledMode, HealthReport, SessionGapView, SessionView } from '@morrow/core';
import type pg from 'pg';
import { getMigrationStatus, MigrationError } from '../db/migrate.js';
import { pgErrorCode } from '../db/pool.js';
import { countJobs } from '../jobs/job-queue.js';
import type { Logger } from '../logging/logger.js';
import { listSourceHealth } from '../providers/source-health.js';
import { getQuotaViews } from '../quota/quota-ledger.js';

export interface HealthInputs {
  readonly pool: pg.Pool;
  readonly mode: EnabledMode;
  readonly version: string;
  readonly logger?: Logger;
  readonly migrationsDir?: string;
  readonly now?: () => Date;
}

async function latestSessions(pool: pg.Pool): Promise<SessionView[]> {
  const result = await pool.query<{
    id: string;
    component: SessionView['component'];
    mode: string;
    status: SessionView['status'];
    started_at: Date;
    last_heartbeat_at: Date;
    ended_at: Date | null;
  }>(
    `SELECT DISTINCT ON (component) id, component, mode, status, started_at, last_heartbeat_at, ended_at
       FROM run_sessions ORDER BY component, id DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    component: row.component,
    mode: row.mode,
    status: row.status,
    started_at: row.started_at.toISOString(),
    last_heartbeat_at: row.last_heartbeat_at.toISOString(),
    ended_at: row.ended_at?.toISOString() ?? null,
  }));
}

async function recentGaps(pool: pg.Pool): Promise<SessionGapView[]> {
  const result = await pool.query<{
    component: SessionGapView['component'];
    kind: SessionGapView['kind'];
    gap_start: Date;
    gap_end: Date;
  }>('SELECT component, kind, gap_start, gap_end FROM session_gaps ORDER BY id DESC LIMIT 10');
  return result.rows.map((row) => ({
    component: row.component,
    kind: row.kind,
    gap_start: row.gap_start.toISOString(),
    gap_end: row.gap_end.toISOString(),
  }));
}

function errorLabel(error: unknown): string {
  const code = pgErrorCode(error);
  if (code) return code;
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * Collects the operator's view of the system. It reports what is wrong
 * without hiding it: an unreachable database, a schema that does not match
 * this build, a source that is not healthy, an exhausted budget or a dead job
 * all make the status `degraded`.
 */
export async function buildHealthReport(inputs: HealthInputs): Promise<HealthReport> {
  const now = (inputs.now ?? (() => new Date()))();
  const base = {
    time: now.toISOString(),
    version: inputs.version,
    mode: inputs.mode,
    live_trading_enabled: false,
  } as const;
  const empty = {
    sessions: [],
    recent_gaps: [],
    sources: [],
    quota: [],
    jobs: { queued: 0, leased: 0, dead: 0 },
  };
  const incomplete = (reachable: boolean, applied: number, pending: number, problem: string): HealthReport => ({
    ...base,
    ...empty,
    status: 'degraded',
    database: { reachable, migrations_applied: applied, migrations_pending: pending, problem },
  });

  try {
    await inputs.pool.query('SELECT 1');
  } catch (error) {
    inputs.logger?.error({ err: error }, 'health: database unreachable');
    return incomplete(false, 0, 0, `database unreachable (${errorLabel(error)})`);
  }

  let migrations;
  try {
    migrations = await getMigrationStatus(inputs.pool, inputs.migrationsDir);
  } catch (error) {
    inputs.logger?.error({ err: error }, 'health: migration state is invalid');
    const problem = error instanceof MigrationError ? error.message : `cannot read migration state (${errorLabel(error)})`;
    return incomplete(true, 0, 0, problem);
  }
  if (migrations.pending > 0) {
    // Tables this build expects may not exist yet, so nothing else is queried.
    return incomplete(true, migrations.applied, migrations.pending, 'migrations are pending; run "npm run migrate"');
  }

  try {
    const [sessions, gaps, sources, quota, jobs] = await Promise.all([
      latestSessions(inputs.pool),
      recentGaps(inputs.pool),
      listSourceHealth(inputs.pool),
      getQuotaViews(inputs.pool, now),
      countJobs(inputs.pool),
    ]);
    const degraded =
      sources.some((source) => source.state !== 'HEALTHY') ||
      quota.some((bucket) => bucket.state === 'HARD_STOP') ||
      jobs.dead > 0;
    return {
      ...base,
      status: degraded ? 'degraded' : 'ok',
      database: { reachable: true, migrations_applied: migrations.applied, migrations_pending: 0, problem: null },
      sessions,
      recent_gaps: gaps,
      sources,
      quota,
      jobs,
    };
  } catch (error) {
    inputs.logger?.error({ err: error }, 'health: status query failed');
    return incomplete(true, migrations.applied, 0, `status query failed (${errorLabel(error)})`);
  }
}
