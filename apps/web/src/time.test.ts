import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRelative, formatTime, freshness, serverNow } from './time.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

test('relative times are rounded down, so nothing looks fresher than it is', () => {
  const now = 1_000_000_000_000;
  const ago = (ms: number) => formatRelative(now - ms, now);
  assert.equal(ago(0), '剛剛');
  assert.equal(ago(999), '剛剛');
  assert.equal(ago(12 * SECOND), '12 秒前');
  assert.equal(ago(MINUTE - 1), '59 秒前');
  assert.equal(ago(MINUTE), '1 分鐘前');
  assert.equal(ago(HOUR - 1), '59 分鐘前');
  assert.equal(ago(HOUR), '1 小時前');
  assert.equal(ago(48 * HOUR - 1), '47 小時前', 'hours up to two days');
  assert.equal(ago(48 * HOUR), '2 天前');
});

test('a time still ahead reads as "後"', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatRelative(now + 41 * SECOND, now), '41 秒後');
  assert.equal(formatRelative(now + 500, now), '即將');
  assert.equal(formatRelative(now + 3 * HOUR, now), '3 小時後');
});

test('full times are shown in Asia/Taipei, whatever the machine is set to', () => {
  // Which space separates the date from the time is ICU's choice (78 uses a thin space).
  assert.equal(formatTime('2026-10-13T16:05:09Z').replace(/\s/gu, ' '), '2026/10/14 00:05:09', 'UTC+8 crosses midnight');
  assert.equal(formatTime(null), '—');
});

test('the server clock is the report time plus what has passed here since the request', () => {
  const requestedAt = 5_000;
  assert.equal(serverNow('2026-10-14T03:00:00.000Z', requestedAt, requestedAt + 2_500), Date.parse('2026-10-14T03:00:02.500Z'));
  assert.equal(
    serverNow('2026-10-14T03:00:00.000Z', requestedAt, requestedAt - 60_000),
    Date.parse('2026-10-14T03:00:00.000Z'),
    'a browser clock set back never moves the server time backwards',
  );
});

test('a report is late after one and a half refresh intervals and stale after three', () => {
  const refresh = 10 * SECOND;
  assert.equal(freshness(0, refresh), 'fresh');
  assert.equal(freshness(15 * SECOND - 1, refresh), 'fresh');
  assert.equal(freshness(15 * SECOND, refresh), 'late');
  assert.equal(freshness(30 * SECOND - 1, refresh), 'late');
  assert.equal(freshness(30 * SECOND, refresh), 'stale');
});
