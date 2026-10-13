import type { CoverageGapReason, CoverageReport } from '@morrow/core';

export const COVERAGE_REASON_LABELS: Record<CoverageGapReason, string> = {
  OFFLINE: '已停止',
  UNCLEAN_SHUTDOWN: '異常中止',
  HEARTBEAT_STALL: '休眠或凍結',
  HEARTBEAT_LOST: '心跳中斷',
  MODE_OFF: 'OFF 模式',
  NO_RECORD: '沒有紀錄',
};

/**
 * How a segment is drawn: observing; a gap nobody chose (a crash, a sleep, a
 * lost heartbeat); stopped on purpose or in OFF mode; or no record at all.
 */
export type CoverageKind = 'observing' | 'abnormal' | 'stopped' | 'unknown';

export function coverageKind(reason: CoverageGapReason | null): CoverageKind {
  if (reason === null) return 'observing';
  if (reason === 'NO_RECORD') return 'unknown';
  return reason === 'OFFLINE' || reason === 'MODE_OFF' ? 'stopped' : 'abnormal';
}

/** "92.3%": rounded down, so a window with any gap never shows 100%. */
export function coveragePercent(report: CoverageReport): string {
  if (report.window_ms <= 0) return '—';
  return `${(Math.floor((report.observed_ms / report.window_ms) * 1000) / 10).toFixed(1)}%`;
}

/** Total time per reason the worker was not observing, longest first. */
export function gapTotals(report: CoverageReport): Array<{ reason: CoverageGapReason; ms: number }> {
  const totals = new Map<CoverageGapReason, number>();
  for (const segment of report.segments) {
    if (segment.reason === null) continue;
    totals.set(segment.reason, (totals.get(segment.reason) ?? 0) + (Date.parse(segment.end) - Date.parse(segment.start)));
  }
  return [...totals].map(([reason, ms]) => ({ reason, ms })).sort((a, b) => b.ms - a.ms);
}

/** "45 秒", "12 分鐘", "3.5 小時", "2.1 天". */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分鐘`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} 小時`;
  return `${(seconds / 86_400).toFixed(1)} 天`;
}
