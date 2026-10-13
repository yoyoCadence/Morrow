// Time display. Storage is UTC; the operator reads Asia/Taipei.

const taipeiTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Full date and time in Asia/Taipei, or a dash when there is none. */
export function formatTime(iso: string | null): string {
  return iso === null ? '—' : taipeiTime.format(new Date(iso));
}

/**
 * "12 秒前", "3 分鐘前", "5 小時前", "2 天前", or the same with 後 for a time
 * still ahead. Rounded down, so a heartbeat is never shown fresher than it is.
 */
export function formatRelative(targetMs: number, nowMs: number): string {
  const diff = nowMs - targetMs;
  const suffix = diff >= 0 ? '前' : '後';
  const seconds = Math.floor(Math.abs(diff) / 1000);
  if (seconds < 1) return diff >= 0 ? '剛剛' : '即將';
  if (seconds < 60) return `${seconds} 秒${suffix}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小時${suffix}`;
  return `${Math.floor(hours / 24)} 天${suffix}`;
}

/**
 * The server's current time, estimated from the report's own timestamp plus
 * the time that has passed here since it arrived. Relative times computed
 * against this stay right even when the browser's clock is off.
 */
export function serverNow(reportTimeIso: string, fetchedAtMs: number, nowMs: number): number {
  return Date.parse(reportTimeIso) + Math.max(0, nowMs - fetchedAtMs);
}

export type Freshness = 'fresh' | 'late' | 'stale';

/**
 * How current the shown report is. Late after one and a half refresh
 * intervals without an update, stale after three.
 */
export function freshness(ageMs: number, refreshMs: number): Freshness {
  if (ageMs < refreshMs * 1.5) return 'fresh';
  return ageMs < refreshMs * 3 ? 'late' : 'stale';
}
