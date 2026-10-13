import type { HealthReport } from '@morrow/core';

type Bucket = HealthReport['quota'][number];

const DAY_MS = 86_400_000;

/**
 * How much of the hard stop is used, in whole percent, rounded down: 99.6%
 * is not yet 100%. Multiplied before dividing, so an exact share stays
 * exact (24,650 of 85,000 is 29%; dividing first gives 28.999…, shown as 28%).
 * A bucket without a hard stop counts as fully used.
 */
export function usedPercent(used: number, hardStopAt: number): number {
  return hardStopAt > 0 ? Math.floor((used * 100) / hardStopAt) : 100;
}

/** A rate measured over less than this says more about one burst than about the month. */
export const MIN_PROJECTION_MS = DAY_MS;

/** Start and end (exclusive) of a billing period: a UTC calendar month starting on `period_start`. */
export function periodBounds(periodStart: string): { start: number; end: number } {
  const [year, month] = periodStart.split('-').map(Number);
  const start = Date.UTC(year ?? 1970, (month ?? 1) - 1, 1);
  const end = Date.UTC(year ?? 1970, month ?? 1, 1);
  return { start, end };
}

export type Projection =
  | { readonly kind: 'reached' }
  | { readonly kind: 'no_usage' }
  | { readonly kind: 'too_early' }
  /** At the month's average rate so far, the hard stop is reached at `at`, before the period ends. */
  | { readonly kind: 'before_end'; readonly at: number }
  /** Not reached this period; `share` is the projected end-of-period use as a fraction of the hard stop. */
  | { readonly kind: 'not_this_period'; readonly share: number };

/**
 * When the bucket reaches its hard stop if use continues at this month's
 * average rate so far. The average is over calendar time, so hours the
 * machine was off count as hours without use: it is a rough guide, not a
 * forecast.
 */
export function projectHardStop(bucket: Bucket, nowMs: number): Projection {
  if (bucket.state === 'HARD_STOP' || bucket.used >= bucket.hard_stop_at) return { kind: 'reached' };
  if (bucket.used === 0) return { kind: 'no_usage' };
  const { start, end } = periodBounds(bucket.period_start);
  const elapsed = nowMs - start;
  if (elapsed < MIN_PROJECTION_MS) return { kind: 'too_early' };
  const rate = bucket.used / elapsed;
  const at = nowMs + (bucket.hard_stop_at - bucket.used) / rate;
  if (at < end) return { kind: 'before_end', at };
  return { kind: 'not_this_period', share: (bucket.used + rate * Math.max(0, end - nowMs)) / bucket.hard_stop_at };
}

const taipeiDate = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' });

/** The projection in words, with the date in Asia/Taipei. */
export function describeProjection(projection: Projection): string {
  switch (projection.kind) {
    case 'reached':
      return '已達硬性上限，本月不再請求';
    case 'no_usage':
      return '本月尚無用量';
    case 'too_early':
      return '本月未滿一天，暫不推估';
    case 'before_end':
      return `約 ${taipeiDate.format(new Date(projection.at))} 達到硬性上限`;
    case 'not_this_period':
      return `本月不會達到（月底約為上限的 ${Math.floor(projection.share * 100)}%）`;
  }
}
