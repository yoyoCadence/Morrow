import { z } from 'zod';
import { UtcTimestamp } from './primitives.js';

/** Result of one attempt to reach a provider. Shared by source health, probes and raw observations. */
export const REQUEST_OUTCOMES = [
  'OK',
  /** A required credential is not configured. No request was sent. */
  'CREDENTIAL_MISSING',
  /** This capability has no verified endpoint definition yet. No request was sent. */
  'ENDPOINT_UNVERIFIED',
  /** The local monthly budget is exhausted. No request was sent. */
  'QUOTA_HARD_STOP',
  /** Skipped because the capability is backing off or needs operator action. No request was sent. */
  'SUPPRESSED',
  'UNAUTHORIZED',
  /** HTTP 402. We never pay and never switch accounts to get around it. */
  'PAYMENT_REQUIRED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'CLIENT_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
  /** The TLS certificate could not be verified, for example because the connection is intercepted. */
  'TLS_UNTRUSTED',
  'NETWORK_ERROR',
  'RESPONSE_TOO_LARGE',
] as const;
export const RequestOutcome = z.enum(REQUEST_OUTCOMES);
export type RequestOutcome = z.infer<typeof RequestOutcome>;

export const SOURCE_STATES = [
  'HEALTHY',
  'RATE_LIMITED',
  'PAYMENT_REQUIRED',
  'UNAUTHORIZED',
  'CREDENTIAL_MISSING',
  'DOWN',
  /**
   * The provider answered, and the answer was an error about the request: a
   * 404, another 4xx, or an error inside a 2xx body that is not about
   * credentials or limits. The source is reachable, but this capability did
   * not deliver data. Not backed off, and never shown as healthy.
   */
  'REQUEST_REJECTED',
] as const;
export const SourceState = z.enum(SOURCE_STATES);
export type SourceState = z.infer<typeof SourceState>;

export const SourceHealthView = z.strictObject({
  provider: z.string(),
  capability: z.string(),
  state: SourceState,
  last_outcome: RequestOutcome,
  last_http_status: z.number().int().nullable(),
  consecutive_failures: z.number().int().min(0),
  blocked_until: UtcTimestamp.nullable(),
  last_success_at: UtcTimestamp.nullable(),
  last_failure_at: UtcTimestamp.nullable(),
  /**
   * Machine-readable reason of the last outcome when it was a failure, for
   * example `OKX_CODE_50113`; null when there is none or no request was sent.
   */
  last_error_class: z.string().nullable(),
  updated_at: UtcTimestamp,
});
export type SourceHealthView = z.infer<typeof SourceHealthView>;

export const QuotaView = z.strictObject({
  provider: z.string(),
  bucket: z.string(),
  period_start: z.string(),
  used: z.number().int().min(0),
  warn_at: z.number().int(),
  hard_stop_at: z.number().int(),
  state: z.enum(['OK', 'WARN', 'HARD_STOP']),
});
export type QuotaView = z.infer<typeof QuotaView>;

/**
 * Whether a session is alive now, derived when the report is built. The
 * stored status alone cannot say: a process that crashes or is killed stays
 * RUNNING until the next start of that component notices.
 *
 * - LIVE: RUNNING, with a heartbeat within the liveness threshold.
 * - STALE: RUNNING, but silent for longer than that. It crashed, was killed,
 *   is frozen, or the machine is asleep. Nothing is being observed.
 * - ENDED: STOPPED or ABANDONED.
 */
export const SessionLiveness = z.enum(['LIVE', 'STALE', 'ENDED']);
export type SessionLiveness = z.infer<typeof SessionLiveness>;

export const SessionView = z.strictObject({
  id: z.string(),
  component: z.enum(['api', 'worker']),
  mode: z.string(),
  status: z.enum(['RUNNING', 'STOPPED', 'ABANDONED']),
  liveness: SessionLiveness,
  started_at: UtcTimestamp,
  last_heartbeat_at: UtcTimestamp,
  ended_at: UtcTimestamp.nullable(),
});
export type SessionView = z.infer<typeof SessionView>;

export const SessionGapView = z.strictObject({
  component: z.enum(['api', 'worker']),
  kind: z.enum(['UNCLEAN_SHUTDOWN', 'OFFLINE', 'HEARTBEAT_STALL']),
  gap_start: UtcTimestamp,
  gap_end: UtcTimestamp,
});
export type SessionGapView = z.infer<typeof SessionGapView>;

/**
 * Overall status, from best to worst. The worst finding decides it.
 *
 * - ok: nothing to report.
 * - attention: works, but incomplete or close to a limit. Missing
 *   credentials, a rejected request, a quota past its warning line.
 * - degraded: something that should be working is not. A source down or
 *   blocked, a stopped heartbeat, no worker where one is needed, a hard
 *   quota stop, a dead job.
 * - critical: the report itself cannot be trusted or nothing can run. The
 *   database is unreachable, or the schema does not match this build.
 */
export const HEALTH_LEVELS = ['ok', 'attention', 'degraded', 'critical'] as const;
export const HealthLevel = z.enum(HEALTH_LEVELS);
export type HealthLevel = z.infer<typeof HealthLevel>;

export const HEALTH_FINDING_CODES = [
  'DATABASE_UNREACHABLE',
  'MIGRATION_STATE_INVALID',
  'MIGRATIONS_PENDING',
  'STATUS_QUERY_FAILED',
  'SESSION_STALE',
  'WORKER_NOT_RUNNING',
  'SOURCE_DOWN',
  'SOURCE_RATE_LIMITED',
  'SOURCE_UNAUTHORIZED',
  'SOURCE_PAYMENT_REQUIRED',
  'SOURCE_REQUEST_REJECTED',
  'SOURCE_CREDENTIAL_MISSING',
  'QUOTA_WARN',
  'QUOTA_HARD_STOP',
  'JOBS_DEAD',
  'EVENT_CONFLICTS',
  'CLOCK_SKEW',
] as const;
export const HealthFindingCode = z.enum(HEALTH_FINDING_CODES);
export type HealthFindingCode = z.infer<typeof HealthFindingCode>;

/** One reason the status is not `ok`. */
export const HealthFinding = z.strictObject({
  severity: z.enum(['attention', 'degraded', 'critical']),
  code: HealthFindingCode,
  /** What it is about, for example `worker` or `okx/token.holders`; null for the system as a whole. */
  subject: z.string().nullable(),
  /** Short English detail for the operator. Never contains a secret. */
  detail: z.string(),
});
export type HealthFinding = z.infer<typeof HealthFinding>;

/** The worst level among the findings, or `ok` when there are none. */
export function overallLevel(findings: readonly Pick<HealthFinding, 'severity'>[]): HealthLevel {
  let worst = 0;
  for (const finding of findings) worst = Math.max(worst, HEALTH_LEVELS.indexOf(finding.severity));
  return HEALTH_LEVELS[worst] ?? 'critical';
}

/** Response of `GET /api/health`. */
export const HealthReport = z.strictObject({
  status: HealthLevel,
  /** Why the status is what it is, worst first. Empty when the status is `ok`. */
  findings: z.array(HealthFinding),
  time: UtcTimestamp,
  version: z.string(),
  mode: z.enum(['OFF', 'RESEARCH', 'PAPER']),
  /** Always false in this build. Present so the dashboard can state it explicitly. */
  live_trading_enabled: z.literal(false),
  database: z.strictObject({
    reachable: z.boolean(),
    migrations_applied: z.number().int().min(0),
    migrations_pending: z.number().int().min(0),
    /** Why the database part of the report is incomplete, or null when it is fine. */
    problem: z.string().nullable(),
  }),
  sessions: z.array(SessionView),
  recent_gaps: z.array(SessionGapView),
  sources: z.array(SourceHealthView),
  quota: z.array(QuotaView),
  jobs: z.strictObject({
    queued: z.number().int().min(0),
    leased: z.number().int().min(0),
    dead: z.number().int().min(0),
  }),
  /** Contradictions recorded in event_conflicts during the last 24 hours. */
  recent_event_conflicts: z.number().int().min(0),
  /**
   * How far this machine's clock is from the providers', estimated from the
   * Date headers of recent responses: the median of their clock offsets
   * (provider time minus ours at the moment the headers arrived). Positive
   * means our clock is behind. Null when there are too few recent responses
   * to say; that is unknown, not zero.
   */
  clock: z.strictObject({
    skew_ms: z.number().int().nullable(),
    samples: z.number().int().min(0),
  }),
});
export type HealthReport = z.infer<typeof HealthReport>;
