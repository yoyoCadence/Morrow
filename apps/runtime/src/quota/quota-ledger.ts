import type { QuotaView } from '@morrow/core';
import type pg from 'pg';
import type { Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { RequestReason } from '../db/raw-store.js';

/**
 * Local budget for one metered provider bucket.
 *
 * `warnAt` and `hardStopAt` sit below the provider's own limit on purpose: we
 * stop ourselves before the provider would, and we never pay or switch
 * accounts to get past a limit.
 */
export interface QuotaPolicy {
  readonly provider: string;
  readonly bucket: string;
  /** The provider's published free allowance per period. */
  readonly sourceLimit: number;
  readonly warnAt: number;
  readonly hardStopAt: number;
  /** Where the numbers come from, shown to the operator. */
  readonly basis: string;
}

export const QUOTA_POLICIES: readonly QuotaPolicy[] = [
  {
    provider: 'okx',
    bucket: 'basic',
    sourceLimit: 100_000,
    warnAt: 70_000,
    hardStopAt: 85_000,
    basis: 'Blueprint: OKX Market free tier, Basic 100K calls/month; warn 70K, local hard stop 85K.',
  },
  {
    provider: 'okx',
    bucket: 'premium',
    sourceLimit: 100_000,
    warnAt: 70_000,
    hardStopAt: 85_000,
    basis: 'Blueprint: OKX Market free tier, Premium 100K calls/month; warn 70K, local hard stop 85K.',
  },
  {
    provider: 'helius',
    bucket: 'credits',
    sourceLimit: 1_000_000,
    warnAt: 700_000,
    hardStopAt: 850_000,
    basis:
      'Blueprint: Helius free tier, 1M credits/month. The blueprint sets no thresholds for Helius; ' +
      'these reuse the OKX 70%/85% ratios until per-endpoint credit cost is measured.',
  },
];

export function findQuotaPolicy(provider: string, bucket: string): QuotaPolicy {
  const policy = QUOTA_POLICIES.find((candidate) => candidate.provider === provider && candidate.bucket === bucket);
  if (!policy) throw new Error(`No quota policy for ${provider}/${bucket}`);
  return policy;
}

/**
 * First day of the billing period containing `at`, as YYYY-MM-DD.
 *
 * Periods are UTC calendar months. Whether each provider resets on the UTC
 * month boundary is not yet confirmed against an account dashboard.
 */
export function periodStart(at: Date): string {
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${at.getUTCFullYear()}-${month}-01`;
}

export interface ReserveInput {
  readonly capability: string;
  readonly reason: RequestReason;
  readonly units: number;
  readonly at: Date;
}

export interface QuotaDecision {
  readonly decision: 'ALLOW' | 'ALLOW_WARN' | 'DENY_HARD_STOP';
  readonly usedAfter: number;
  /** True for the one reservation that takes usage across the warning line. */
  readonly crossedWarn: boolean;
}

/**
 * Reserves budget before a request is sent.
 *
 * The increment and the limit check are one UPDATE, so concurrent callers
 * cannot together exceed the hard stop. A reservation is not refunded if the
 * request then fails: every attempt counts, including retries and probes.
 */
export async function reserveQuota(pool: pg.Pool, policy: QuotaPolicy, input: ReserveInput): Promise<QuotaDecision> {
  if (!Number.isInteger(input.units) || input.units < 1) throw new Error('Quota units must be a positive integer');
  const period = periodStart(input.at);

  return withTransaction(pool, async (tx) => {
    await tx.query(
      'INSERT INTO quota_counters (provider, bucket, period_start) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [policy.provider, policy.bucket, period],
    );
    const updated = await tx.query<{ used: string }>(
      `UPDATE quota_counters SET used = used + $4
        WHERE provider = $1 AND bucket = $2 AND period_start = $3 AND used + $4 <= $5
        RETURNING used`,
      [policy.provider, policy.bucket, period, input.units, policy.hardStopAt],
    );

    let decision: QuotaDecision;
    const allowed = updated.rows[0];
    if (allowed) {
      const usedAfter = Number(allowed.used);
      const warn = usedAfter >= policy.warnAt;
      decision = {
        decision: warn ? 'ALLOW_WARN' : 'ALLOW',
        usedAfter,
        crossedWarn: warn && usedAfter - input.units < policy.warnAt,
      };
    } else {
      const current = await tx.query<{ used: string }>(
        'SELECT used FROM quota_counters WHERE provider = $1 AND bucket = $2 AND period_start = $3',
        [policy.provider, policy.bucket, period],
      );
      decision = { decision: 'DENY_HARD_STOP', usedAfter: Number(current.rows[0]?.used ?? 0), crossedWarn: false };
    }

    await tx.query(
      `INSERT INTO quota_events (
         provider, bucket, period_start, capability, reason, units, decision, used_after, warn_at, hard_stop_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        policy.provider,
        policy.bucket,
        period,
        input.capability,
        input.reason,
        input.units,
        decision.decision,
        decision.usedAfter,
        policy.warnAt,
        policy.hardStopAt,
      ],
    );
    return decision;
  });
}

/** Current usage of every metered bucket, for the health report. */
export async function getQuotaViews(db: Queryable, now: Date): Promise<QuotaView[]> {
  const period = periodStart(now);
  const result = await db.query<{ provider: string; bucket: string; used: string }>(
    'SELECT provider, bucket, used FROM quota_counters WHERE period_start = $1',
    [period],
  );
  return QUOTA_POLICIES.map((policy) => {
    const row = result.rows.find((candidate) => candidate.provider === policy.provider && candidate.bucket === policy.bucket);
    const used = Number(row?.used ?? 0);
    const state =used >= policy.hardStopAt ? 'HARD_STOP' : used >= policy.warnAt ? 'WARN' : 'OK';
    return {
      provider: policy.provider,
      bucket: policy.bucket,
      period_start: period,
      used,
      warn_at: policy.warnAt,
      hard_stop_at: policy.hardStopAt,
      state,
    };
  });
}
