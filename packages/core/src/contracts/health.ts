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

export const SessionView = z.strictObject({
  id: z.string(),
  component: z.enum(['api', 'worker']),
  mode: z.string(),
  status: z.enum(['RUNNING', 'STOPPED', 'ABANDONED']),
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

/** Response of `GET /api/health`. */
export const HealthReport = z.strictObject({
  status: z.enum(['ok', 'degraded']),
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
});
export type HealthReport = z.infer<typeof HealthReport>;
