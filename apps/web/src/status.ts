import type { HealthReport } from '@morrow/core';
import { sourceTone } from './sources';
import { formatRelative } from './time';

export type Tone = 'good' | 'warn' | 'bad' | 'critical' | 'neutral';

export const LEVELS: Record<HealthReport['status'], { label: string; tone: Tone }> = {
  ok: { label: '正常', tone: 'good' },
  attention: { label: '需注意', tone: 'warn' },
  degraded: { label: '異常', tone: 'bad' },
  critical: { label: '嚴重', tone: 'critical' },
};

/** One small fact in the status bar. The text alone must say it; the tone only repeats it. */
export interface Indicator {
  readonly key: string;
  readonly tone: Tone;
  readonly text: string;
}

function workerIndicator(report: HealthReport, now: number): Indicator {
  const worker = report.sessions.find((session) => session.component === 'worker');
  if (worker?.liveness === 'LIVE') {
    return { key: 'worker', tone: 'good', text: `worker 心跳 ${formatRelative(Date.parse(worker.last_heartbeat_at), now)}` };
  }
  if (worker?.liveness === 'STALE') return { key: 'worker', tone: 'bad', text: 'worker 心跳中斷' };
  // Not running is a problem only in a mode that needs it, and then the report says so.
  const needed = report.findings.some((finding) => finding.code === 'WORKER_NOT_RUNNING');
  return { key: 'worker', tone: needed ? 'bad' : 'neutral', text: 'worker 未執行' };
}

function sourcesIndicator(report: HealthReport): Indicator {
  // Rows with capability "*" record a provider-wide rate limit, not a capability.
  const sources = report.sources.filter((source) => source.capability !== '*');
  if (sources.length === 0) return { key: 'sources', tone: 'neutral', text: '來源 尚未請求' };
  const healthy = sources.filter((source) => source.state === 'HEALTHY').length;
  // A provider-wide backoff suppresses every capability of that provider, even
  // the ones whose own row still reads HEALTHY, so the text names it.
  const sharedLimits = report.sources
    .filter((source) => source.capability === '*' && source.state !== 'HEALTHY')
    .map((source) => source.provider);
  const tone: Tone = sources.some((source) => sourceTone(source.state) === 'bad')
    ? 'bad'
    : healthy < sources.length || sharedLimits.length > 0
      ? 'warn'
      : 'good';
  const shared = sharedLimits.length > 0 ? ` · ${sharedLimits.join('、')} 共用限流中` : '';
  return { key: 'sources', tone, text: `來源 正常 ${healthy}/${sources.length}${shared}` };
}

function quotaIndicator(report: HealthReport): Indicator {
  let highest: HealthReport['quota'][number] | null = null;
  let highestShare = -1;
  for (const bucket of report.quota) {
    const share = bucket.hard_stop_at > 0 ? bucket.used / bucket.hard_stop_at : 1;
    if (share > highestShare) {
      highest = bucket;
      highestShare = share;
    }
  }
  if (highest === null) return { key: 'quota', tone: 'neutral', text: '額度 —' };
  const tone: Tone = highest.state === 'HARD_STOP' ? 'bad' : highest.state === 'WARN' ? 'warn' : 'good';
  // Rounded down: 99.6% of the hard stop is not yet 100%.
  const percent = Math.floor(highestShare * 100);
  return { key: 'quota', tone, text: `額度 最高 ${percent}%（${highest.provider}/${highest.bucket}）` };
}

function deadJobsIndicator(report: HealthReport): Indicator {
  const dead = report.jobs.dead;
  return { key: 'jobs', tone: dead > 0 ? 'bad' : 'good', text: `失敗終止的工作 ${dead}` };
}

const UNKNOWN_INDICATORS: readonly Indicator[] = [
  { key: 'worker', tone: 'neutral', text: 'worker 未知' },
  { key: 'sources', tone: 'neutral', text: '來源 未知' },
  { key: 'quota', tone: 'neutral', text: '額度 未知' },
  { key: 'jobs', tone: 'neutral', text: '失敗終止的工作 未知' },
];

/**
 * The small facts shown next to the overall status, in a fixed order. When
 * the report could not read past the database (`database.problem` is set),
 * its sessions, sources, quota and jobs are empty placeholders, not facts,
 * so every indicator says unknown rather than "not running" or "0".
 */
export function indicators(report: HealthReport, now: number): Indicator[] {
  if (report.database.problem !== null) return [...UNKNOWN_INDICATORS];
  return [workerIndicator(report, now), sourcesIndicator(report), quotaIndicator(report), deadJobsIndicator(report)];
}

/** What the page knows right now: still loading, the API not answering, or a current report's status. */
export type PageState = 'loading' | 'unreachable' | HealthReport['status'];

/** Browser tab title: the state first, so it can be read from a narrow tab. */
export function pageTitle(state: PageState): string {
  if (state === 'loading') return 'Morrow';
  return `${state === 'unreachable' ? '連線中斷' : LEVELS[state].label} · Morrow`;
}

/** Favicon file in `public/`. Static files, because the API's CSP allows no `data:` URLs. */
export function faviconPath(state: PageState): string {
  return `/favicon-${state === 'loading' || state === 'unreachable' ? 'unknown' : state}.svg`;
}
