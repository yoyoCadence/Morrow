import type { HealthReport } from '@morrow/core';
import type { Tone } from './status';

type Source = HealthReport['sources'][number];

const BAD_STATES: ReadonlySet<Source['state']> = new Set(['DOWN', 'UNAUTHORIZED', 'PAYMENT_REQUIRED']);

/** good: delivering; warn: incomplete or held back but not broken; bad: should work and does not. */
export function sourceTone(state: Source['state']): Tone {
  if (state === 'HEALTHY') return 'good';
  return BAD_STATES.has(state) ? 'bad' : 'warn';
}

const RANK: Record<string, number> = { bad: 2, warn: 1, good: 0 };
const rank = (source: Source): number => RANK[sourceTone(source.state)] ?? 0;

export interface SourceGroup {
  readonly provider: string;
  /** Problems first; within the same tone the provider-wide row, then by capability. */
  readonly rows: readonly Source[];
  /** Capabilities of the provider, before any filter. The provider-wide `*` row is not one. */
  readonly total: number;
  /** Capabilities that are not HEALTHY, before any filter. */
  readonly problems: number;
  /** The provider-wide row (`*`) is not HEALTHY: requests to every capability are held back. */
  readonly sharedLimit: boolean;
  readonly worst: Tone;
}

/** "7 個功能，2 個有問題", or with a shared limit "5 個功能，整個供應商限流中". */
export function groupSummary(group: SourceGroup): string {
  const parts = [`${group.total} 個功能`];
  if (group.sharedLimit) parts.push('整個供應商限流中');
  if (group.problems > 0) parts.push(`${group.sharedLimit ? '另有 ' : ''}${group.problems} 個有問題`);
  else if (!group.sharedLimit) parts.push('全部正常');
  return parts.join('，');
}

/**
 * Sources grouped by provider, the group with the worst row first, so a
 * problem is never below a screenful of healthy rows. With `onlyIssues`,
 * HEALTHY rows are left out, and so is a group that has nothing else.
 */
export function groupSources(sources: readonly Source[], onlyIssues: boolean): SourceGroup[] {
  const byProvider = new Map<string, Source[]>();
  for (const source of sources) {
    const rows = byProvider.get(source.provider) ?? [];
    rows.push(source);
    byProvider.set(source.provider, rows);
  }
  const groups: SourceGroup[] = [];
  for (const [provider, all] of byProvider) {
    const sorted = [...all].sort(
      (a, b) =>
        rank(b) - rank(a) ||
        Number(b.capability === '*') - Number(a.capability === '*') ||
        a.capability.localeCompare(b.capability),
    );
    const rows = onlyIssues ? sorted.filter((source) => source.state !== 'HEALTHY') : sorted;
    if (rows.length === 0) continue;
    const worstRank = Math.max(...all.map(rank));
    const capabilities = all.filter((source) => source.capability !== '*');
    groups.push({
      provider,
      rows,
      total: capabilities.length,
      problems: capabilities.filter((source) => source.state !== 'HEALTHY').length,
      sharedLimit: all.some((source) => source.capability === '*' && source.state !== 'HEALTHY'),
      worst: worstRank === 2 ? 'bad' : worstRank === 1 ? 'warn' : 'good',
    });
  }
  return groups.sort((a, b) => (RANK[b.worst] ?? 0) - (RANK[a.worst] ?? 0) || a.provider.localeCompare(b.provider));
}

/**
 * "basic · 14%": the bucket a capability draws from and how much of the
 * hard stop it has used this month. The share is rounded down; "—" when the
 * capability has no monthly allowance, and the bucket alone when the report
 * has no usage row for it.
 */
export function bucketUsage(source: Source, quota: HealthReport['quota']): string {
  if (source.quota_bucket === null) return '—';
  const bucket = quota.find((entry) => entry.provider === source.provider && entry.bucket === source.quota_bucket);
  if (!bucket || bucket.hard_stop_at <= 0) return source.quota_bucket;
  return `${source.quota_bucket} · ${Math.floor((bucket.used / bucket.hard_stop_at) * 100)}%`;
}
