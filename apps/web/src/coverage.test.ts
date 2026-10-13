import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COVERAGE_GAP_REASONS, type CoverageReport } from '@morrow/core';
import { coverageKind, coveragePercent, formatSpan, gapTotals } from './coverage.js';

const HOUR = 3_600_000;

function report(observedMs: number, windowMs: number, segments: CoverageReport['segments'] = []): CoverageReport {
  return { component: 'worker', from: '2026-10-13T03:00:00.000Z', to: '2026-10-14T03:00:00.000Z', window_ms: windowMs, observed_ms: observedMs, segments };
}

test('gaps nobody chose are told apart from stopping on purpose and from having no record', () => {
  assert.equal(coverageKind(null), 'observing');
  const kinds = Object.fromEntries(COVERAGE_GAP_REASONS.map((reason) => [reason, coverageKind(reason)]));
  assert.deepEqual(kinds, {
    OFFLINE: 'stopped',
    UNCLEAN_SHUTDOWN: 'abnormal',
    HEARTBEAT_STALL: 'abnormal',
    HEARTBEAT_LOST: 'abnormal',
    MODE_OFF: 'stopped',
    NO_RECORD: 'unknown',
  });
});

test('coverage is rounded down, so any gap keeps it below 100%', () => {
  const day = 24 * HOUR;
  assert.equal(coveragePercent(report(day, day)), '100.0%');
  assert.equal(coveragePercent(report(day - 1, day)), '99.9%', 'one missing millisecond');
  assert.equal(coveragePercent(report(923, 1_000)), '92.3%');
  assert.equal(coveragePercent(report(0, day)), '0.0%');
  assert.equal(coveragePercent(report(0, 0)), '—', 'an empty window has no share');
});

test('gap totals add up each reason, longest first, and leave out observing time', () => {
  const totals = gapTotals(
    report(0, 0, [
      { start: '2026-10-13T03:00:00.000Z', end: '2026-10-13T04:00:00.000Z', observing: false, reason: 'OFFLINE' },
      { start: '2026-10-13T04:00:00.000Z', end: '2026-10-13T10:00:00.000Z', observing: true, reason: null },
      { start: '2026-10-13T10:00:00.000Z', end: '2026-10-13T12:00:00.000Z', observing: false, reason: 'UNCLEAN_SHUTDOWN' },
      { start: '2026-10-13T12:00:00.000Z', end: '2026-10-13T13:30:00.000Z', observing: false, reason: 'OFFLINE' },
    ]),
  );
  assert.deepEqual(totals, [
    { reason: 'OFFLINE', ms: 2.5 * HOUR },
    { reason: 'UNCLEAN_SHUTDOWN', ms: 2 * HOUR },
  ]);
});

test('spans read in the largest unit that fits', () => {
  assert.equal(formatSpan(-5), '0 秒');
  assert.equal(formatSpan(44_400), '44 秒');
  assert.equal(formatSpan(60_000), '1 分鐘');
  assert.equal(formatSpan(12 * 60_000), '12 分鐘');
  assert.equal(formatSpan(HOUR), '1.0 小時');
  assert.equal(formatSpan(3.5 * HOUR), '3.5 小時');
  assert.equal(formatSpan(48 * HOUR), '2.0 天');
});
