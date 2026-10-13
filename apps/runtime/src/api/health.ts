import {
  overallLevel,
  type EnabledMode,
  type HealthFinding,
  type HealthReport,
  type QuotaView,
  type SessionGapView,
  type SessionView,
  type SourceHealthView,
} from '@morrow/core';
import type pg from 'pg';
import { getMigrationStatus, MigrationError, type MigrationStatus } from '../db/migrate.js';
import { isConnectionTimeout, isQueryReadTimeout, pgErrorCode } from '../db/pool.js';
import { countJobs } from '../jobs/job-queue.js';
import type { Logger } from '../logging/logger.js';
import { CLOCK_SKEW_ATTENTION_MS, CLOCK_SKEW_DEGRADED_MS, measureClockSkew } from '../providers/clock-skew.js';
import { listSourceHealth } from '../providers/source-health.js';
import { getQuotaViews } from '../quota/quota-ledger.js';
import { LIVENESS_THRESHOLD_MS } from '../session/run-session.js';

export interface HealthInputs {
  readonly pool: pg.Pool;
  readonly mode: EnabledMode;
  readonly version: string;
  readonly logger?: Logger;
  readonly migrationsDir?: string;
  readonly now?: () => Date;
}

/**
 * The latest session of each component, with its liveness. Heartbeat age is
 * measured on the database clock, the same clock that wrote the heartbeat.
 */
async function latestSessions(pool: pg.Pool): Promise<SessionView[]> {
  const result = await pool.query<{
    id: string;
    component: SessionView['component'];
    mode: string;
    status: SessionView['status'];
    started_at: Date;
    last_heartbeat_at: Date;
    ended_at: Date | null;
    silent: boolean;
  }>(
    `SELECT DISTINCT ON (component) id, component, mode, status, started_at, last_heartbeat_at, ended_at,
            clock_timestamp() - last_heartbeat_at > make_interval(secs => $1::double precision / 1000) AS silent
       FROM run_sessions ORDER BY component, id DESC`,
    [LIVENESS_THRESHOLD_MS],
  );
  return result.rows.map((row) => ({
    id: row.id,
    component: row.component,
    mode: row.mode,
    status: row.status,
    liveness: row.status !== 'RUNNING' ? 'ENDED' : row.silent ? 'STALE' : 'LIVE',
    started_at: row.started_at.toISOString(),
    last_heartbeat_at: row.last_heartbeat_at.toISOString(),
    ended_at: row.ended_at?.toISOString() ?? null,
  }));
}

/** A capability rejected this many times in a row is broken, not unlucky. */
export const REPEATED_REJECTIONS = 3;

const SEVERITY_ORDER: Record<HealthFinding['severity'], number> = { critical: 0, degraded: 1, attention: 2 };

function sourceFinding(source: SourceHealthView): HealthFinding | null {
  const subject = `${source.provider}/${source.capability}`;
  const why = [source.last_outcome, source.last_http_status !== null ? `HTTP ${source.last_http_status}` : null, source.last_error_class]
    .filter(Boolean)
    .join(', ');
  switch (source.state) {
    case 'HEALTHY':
      return null;
    case 'CREDENTIAL_MISSING':
      return { severity: 'attention', code: 'SOURCE_CREDENTIAL_MISSING', subject, detail: 'no credential is configured; nothing is sent' };
    case 'REQUEST_REJECTED': {
      const repeated = source.consecutive_failures >= REPEATED_REJECTIONS;
      return {
        severity: repeated ? 'degraded' : 'attention',
        code: 'SOURCE_REQUEST_REJECTED',
        subject,
        detail: `${why}; ${source.consecutive_failures} in a row`,
      };
    }
    case 'RATE_LIMITED':
      return { severity: 'degraded', code: 'SOURCE_RATE_LIMITED', subject, detail: why };
    case 'UNAUTHORIZED':
      return { severity: 'degraded', code: 'SOURCE_UNAUTHORIZED', subject, detail: `${why}; blocked until a probe re-tests it` };
    case 'PAYMENT_REQUIRED':
      return { severity: 'degraded', code: 'SOURCE_PAYMENT_REQUIRED', subject, detail: `${why}; nothing is paid` };
    case 'DOWN':
      return { severity: 'degraded', code: 'SOURCE_DOWN', subject, detail: `${why}; ${source.consecutive_failures} in a row` };
  }
}

function quotaFinding(bucket: QuotaView): HealthFinding | null {
  const subject = `${bucket.provider}/${bucket.bucket}`;
  const detail = `${bucket.used} used; warn at ${bucket.warn_at}, hard stop at ${bucket.hard_stop_at}`;
  if (bucket.state === 'HARD_STOP') return { severity: 'degraded', code: 'QUOTA_HARD_STOP', subject, detail };
  if (bucket.state === 'WARN') return { severity: 'attention', code: 'QUOTA_WARN', subject, detail };
  return null;
}

interface FindingInputs {
  readonly mode: EnabledMode;
  readonly sessions: readonly SessionView[];
  readonly sources: readonly SourceHealthView[];
  readonly quota: readonly QuotaView[];
  readonly deadJobs: number;
  readonly recentConflicts: number;
  readonly clock?: HealthReport['clock'];
}

/** Every reason the status is not ok, worst first. */
export function healthFindings(inputs: FindingInputs): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const session of inputs.sessions) {
    if (session.liveness === 'STALE') {
      findings.push({
        severity: 'degraded',
        code: 'SESSION_STALE',
        subject: session.component,
        detail: `RUNNING on record, but no heartbeat for more than ${LIVENESS_THRESHOLD_MS / 1000}s`,
      });
    }
  }
  // RESEARCH and PAPER exist to observe, and only the worker observes.
  const workerLive = inputs.sessions.some((session) => session.component === 'worker' && session.liveness === 'LIVE');
  if (inputs.mode !== 'OFF' && !workerLive) {
    findings.push({
      severity: 'degraded',
      code: 'WORKER_NOT_RUNNING',
      subject: 'worker',
      detail: `${inputs.mode} observes through the worker, and no worker is heartbeating`,
    });
  }
  for (const source of inputs.sources) {
    const finding = sourceFinding(source);
    if (finding) findings.push(finding);
  }
  for (const bucket of inputs.quota) {
    const finding = quotaFinding(bucket);
    if (finding) findings.push(finding);
  }
  if (inputs.deadJobs > 0) {
    findings.push({ severity: 'degraded', code: 'JOBS_DEAD', subject: null, detail: `${inputs.deadJobs} job(s) ran out of attempts` });
  }
  const skew = inputs.clock?.skew_ms ?? null;
  if (skew !== null && Math.abs(skew) > CLOCK_SKEW_ATTENTION_MS) {
    findings.push({
      severity: Math.abs(skew) > CLOCK_SKEW_DEGRADED_MS ? 'degraded' : 'attention',
      code: 'CLOCK_SKEW',
      subject: null,
      detail: `this machine's clock is about ${Math.round(Math.abs(skew) / 1000)}s ${skew > 0 ? 'behind' : 'ahead of'} the providers' (median of ${inputs.clock?.samples ?? 0} recent responses)`,
    });
  }
  if (inputs.recentConflicts > 0) {
    findings.push({
      severity: 'attention',
      code: 'EVENT_CONFLICTS',
      subject: null,
      detail: `${inputs.recentConflicts} event(s) in the last 24h contradicted one already stored; see event_conflicts`,
    });
  }
  // Stable sort: worst first, then in the order found.
  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

async function recentConflicts(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM event_conflicts WHERE detected_at > clock_timestamp() - interval '24 hours'",
  );
  return result.rows[0]?.n ?? 0;
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
  if (isConnectionTimeout(error)) return 'connection timed out';
  if (isQueryReadTimeout(error)) return 'no answer in time';
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * Collects the operator's view of the system. It reports what is wrong
 * without hiding it, and says how bad: every problem is a finding with a
 * severity, and the worst finding decides the status (see HEALTH_LEVELS).
 * Missing credentials are not an outage, and an outage is not a database
 * that cannot be reached.
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
    recent_event_conflicts: 0,
    clock: { skew_ms: null, samples: 0 },
  };
  // Nothing past the database part could be read, so nothing past it is reported.
  const incomplete = (
    code: HealthFinding['code'],
    database: { reachable: boolean; applied: number; pending: number; problem: string },
  ): HealthReport => ({
    ...base,
    ...empty,
    status: 'critical',
    findings: [{ severity: 'critical', code, subject: null, detail: database.problem }],
    database: {
      reachable: database.reachable,
      migrations_applied: database.applied,
      migrations_pending: database.pending,
      problem: database.problem,
    },
  });

  try {
    await inputs.pool.query('SELECT 1');
  } catch (error) {
    inputs.logger?.error({ err: error }, 'health: database unreachable');
    return incomplete('DATABASE_UNREACHABLE', { reachable: false, applied: 0, pending: 0, problem: `database unreachable (${errorLabel(error)})` });
  }

  let migrations: MigrationStatus;
  try {
    migrations = await getMigrationStatus(inputs.pool, inputs.migrationsDir);
  } catch (error) {
    inputs.logger?.error({ err: error }, 'health: migration state is invalid');
    const problem = error instanceof MigrationError ? error.message : `cannot read migration state (${errorLabel(error)})`;
    return incomplete('MIGRATION_STATE_INVALID', { reachable: true, applied: 0, pending: 0, problem });
  }
  if (migrations.pending > 0) {
    // Tables this build expects may not exist yet, so nothing else is queried.
    return incomplete('MIGRATIONS_PENDING', {
      reachable: true,
      applied: migrations.applied,
      pending: migrations.pending,
      problem: 'migrations are pending; run "npm run migrate"',
    });
  }

  try {
    const [sessions, gaps, sources, quota, jobs, conflicts, clock] = await Promise.all([
      latestSessions(inputs.pool),
      recentGaps(inputs.pool),
      listSourceHealth(inputs.pool),
      getQuotaViews(inputs.pool, now),
      countJobs(inputs.pool),
      recentConflicts(inputs.pool),
      measureClockSkew(inputs.pool),
    ]);
    const findings = healthFindings({
      mode: inputs.mode,
      sessions,
      sources,
      quota,
      deadJobs: jobs.dead,
      recentConflicts: conflicts,
      clock,
    });
    return {
      ...base,
      status: overallLevel(findings),
      findings,
      database: { reachable: true, migrations_applied: migrations.applied, migrations_pending: 0, problem: null },
      sessions,
      recent_gaps: gaps,
      sources,
      quota,
      jobs,
      recent_event_conflicts: conflicts,
      clock,
    };
  } catch (error) {
    inputs.logger?.error({ err: error }, 'health: status query failed');
    return incomplete('STATUS_QUERY_FAILED', {
      reachable: true,
      applied: migrations.applied,
      pending: 0,
      problem: `status query failed (${errorLabel(error)})`,
    });
  }
}
