import type { RequestOutcome, SourceHealthView, SourceState } from '@morrow/core';
import type { Queryable } from '../db/pool.js';
import type { RequestReason } from '../db/raw-store.js';

export interface SourceHealth {
  readonly state: SourceState;
  readonly lastOutcome: RequestOutcome;
  readonly lastHttpStatus: number | null;
  readonly consecutiveFailures: number;
  /** No request is sent before this time. */
  readonly blockedUntil: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
}

export interface OutcomeInfo {
  readonly outcome: RequestOutcome;
  readonly httpStatus: number | null;
  /** From a Retry-After header, when the provider sent one. */
  readonly retryAfterMs: number | null;
}

const MAX_FAILURE_BACKOFF_MS = 5 * 60_000;
const MIN_RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;

function failureBackoffMs(consecutiveFailures: number): number {
  return Math.min(5_000 * 2 ** (consecutiveFailures - 1), MAX_FAILURE_BACKOFF_MS);
}

function rateLimitBackoffMs(consecutiveFailures: number, retryAfterMs: number | null): number {
  const fallback = MIN_RATE_LIMIT_BACKOFF_MS * 2 ** (consecutiveFailures - 1);
  // Honour the provider's Retry-After, but never retry sooner than our own floor.
  return Math.min(Math.max(retryAfterMs ?? 0, fallback, MIN_RATE_LIMIT_BACKOFF_MS), MAX_RATE_LIMIT_BACKOFF_MS);
}

/**
 * Whether a request should be skipped without touching the network.
 *
 * - While backing off (rate limited or failing), everything waits. A manual
 *   refresh or a probe does not get to jump a provider's rate limit.
 * - PAYMENT_REQUIRED and UNAUTHORIZED need a human: fixing a plan or a
 *   credential. They stay blocked until an explicit probe re-tests them.
 */
export function shouldSuppress(health: SourceHealth | null, reason: RequestReason, now: Date): boolean {
  if (!health) return false;
  if (health.blockedUntil && now.getTime() < health.blockedUntil.getTime()) return true;
  if (health.state === 'PAYMENT_REQUIRED' || health.state === 'UNAUTHORIZED') return reason !== 'probe';
  return false;
}

/**
 * The health that follows an outcome. Returns null for outcomes where no
 * request was sent and nothing was learned about the provider.
 */
export function nextHealth(previous: SourceHealth | null, info: OutcomeInfo, now: Date): SourceHealth | null {
  const base = {
    lastOutcome: info.outcome,
    lastHttpStatus: info.httpStatus,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastFailureAt: previous?.lastFailureAt ?? null,
  };
  const failures = (previous?.consecutiveFailures ?? 0) + 1;
  const after = (ms: number): Date => new Date(now.getTime() + ms);

  switch (info.outcome) {
    case 'QUOTA_HARD_STOP':
    case 'SUPPRESSED':
    case 'ENDPOINT_UNVERIFIED':
      return null;

    case 'OK':
    // The provider answered. A 404 or 400 is about the request, not the source.
    case 'NOT_FOUND':
    case 'CLIENT_ERROR':
      return {
        ...base,
        state: 'HEALTHY',
        consecutiveFailures: 0,
        blockedUntil: null,
        lastSuccessAt: info.outcome === 'OK' ? now : base.lastSuccessAt,
      };

    case 'CREDENTIAL_MISSING':
      return { ...base, state: 'CREDENTIAL_MISSING', consecutiveFailures: 0, blockedUntil: null };

    case 'RATE_LIMITED':
      return {
        ...base,
        state: 'RATE_LIMITED',
        consecutiveFailures: failures,
        blockedUntil: after(rateLimitBackoffMs(failures, info.retryAfterMs)),
        lastFailureAt: now,
      };

    case 'PAYMENT_REQUIRED':
      return { ...base, state: 'PAYMENT_REQUIRED', consecutiveFailures: failures, blockedUntil: null, lastFailureAt: now };

    case 'UNAUTHORIZED':
      return { ...base, state: 'UNAUTHORIZED', consecutiveFailures: failures, blockedUntil: null, lastFailureAt: now };

    case 'SERVER_ERROR':
    case 'TIMEOUT':
    case 'TLS_UNTRUSTED':
    case 'NETWORK_ERROR':
    case 'RESPONSE_TOO_LARGE':
      return {
        ...base,
        state: 'DOWN',
        consecutiveFailures: failures,
        blockedUntil: after(failureBackoffMs(failures)),
        lastFailureAt: now,
      };
  }
}

interface SourceHealthRow {
  provider: string;
  capability: string;
  state: SourceState;
  last_outcome: RequestOutcome;
  last_http_status: number | null;
  consecutive_failures: number;
  blocked_until: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  updated_at: Date;
}

const COLUMNS = `provider, capability, state, last_outcome, last_http_status, consecutive_failures,
                 blocked_until, last_success_at, last_failure_at, updated_at`;

export async function readSourceHealth(db: Queryable, provider: string, capability: string): Promise<SourceHealth | null> {
  const result = await db.query<SourceHealthRow>(
    `SELECT ${COLUMNS} FROM source_health WHERE provider = $1 AND capability = $2`,
    [provider, capability],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    state: row.state,
    lastOutcome: row.last_outcome,
    lastHttpStatus: row.last_http_status,
    consecutiveFailures: row.consecutive_failures,
    blockedUntil: row.blocked_until,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
  };
}

export async function writeSourceHealth(
  db: Queryable,
  provider: string,
  capability: string,
  health: SourceHealth,
  rawObservationId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO source_health (
       provider, capability, state, last_outcome, last_http_status, consecutive_failures,
       blocked_until, last_success_at, last_failure_at, last_raw_observation_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
     ON CONFLICT (provider, capability) DO UPDATE SET
       state = EXCLUDED.state,
       last_outcome = EXCLUDED.last_outcome,
       last_http_status = EXCLUDED.last_http_status,
       consecutive_failures = EXCLUDED.consecutive_failures,
       blocked_until = EXCLUDED.blocked_until,
       last_success_at = EXCLUDED.last_success_at,
       last_failure_at = EXCLUDED.last_failure_at,
       last_raw_observation_id = COALESCE(EXCLUDED.last_raw_observation_id, source_health.last_raw_observation_id),
       updated_at = EXCLUDED.updated_at`,
    [
      provider,
      capability,
      health.state,
      health.lastOutcome,
      health.lastHttpStatus,
      health.consecutiveFailures,
      health.blockedUntil,
      health.lastSuccessAt,
      health.lastFailureAt,
      rawObservationId,
    ],
  );
}

export async function listSourceHealth(db: Queryable): Promise<SourceHealthView[]> {
  const result = await db.query<SourceHealthRow>(`SELECT ${COLUMNS} FROM source_health ORDER BY provider, capability`);
  return result.rows.map((row) => ({
    provider: row.provider,
    capability: row.capability,
    state: row.state,
    last_outcome: row.last_outcome,
    last_http_status: row.last_http_status,
    consecutive_failures: row.consecutive_failures,
    blocked_until: row.blocked_until?.toISOString() ?? null,
    last_success_at: row.last_success_at?.toISOString() ?? null,
    last_failure_at: row.last_failure_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  }));
}
