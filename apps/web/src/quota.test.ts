import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeProjection, periodBounds, projectHardStop, usedPercent } from './quota.js';
import { quotaBucket } from './test-support/report.js';

const DAY = 86_400_000;

test('the used share is rounded down and exact shares stay exact', () => {
  assert.equal(usedPercent(24_650, 85_000), 29, 'dividing first gives 28.999…, shown as 28%');
  for (const used of [29, 57, 58]) assert.equal(usedPercent(used, 100), used);
  assert.equal(usedPercent(84_999, 85_000), 99, '99.99% is not yet 100%');
  assert.equal(usedPercent(85_000, 85_000), 100);
  assert.equal(usedPercent(0, 0), 100, 'no hard stop counts as used up');
});

test('a period is a UTC calendar month', () => {
  assert.deepEqual(periodBounds('2026-10-01'), { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 10, 1) });
  assert.deepEqual(periodBounds('2026-12-01'), { start: Date.UTC(2026, 11, 1), end: Date.UTC(2027, 0, 1) }, 'December ends in January');
});

test('the hard stop is projected from the average rate of the month so far', () => {
  const tenDaysIn = Date.UTC(2026, 9, 11);
  // 42,500 in 10 days is 4,250 a day: the remaining 42,500 take 10 more days.
  assert.deepEqual(projectHardStop(quotaBucket('okx', 'basic', 42_500), tenDaysIn), { kind: 'before_end', at: Date.UTC(2026, 9, 21) });

  // 8,500 in 10 days is 850 a day: 26,350 by the end of October, 31% of the hard stop.
  const slow = projectHardStop(quotaBucket('okx', 'basic', 8_500), tenDaysIn);
  assert.equal(slow.kind, 'not_this_period');
  assert.equal(describeProjection(slow), '本月不會達到（月底約為上限的 31%）');
});

test('no projection from too little, nothing, or a bucket already stopped', () => {
  const start = Date.UTC(2026, 9, 1);
  assert.deepEqual(projectHardStop(quotaBucket('okx', 'basic', 500), start + DAY - 1), { kind: 'too_early' });
  assert.deepEqual(projectHardStop(quotaBucket('okx', 'basic', 0), start + 10 * DAY), { kind: 'no_usage' });
  assert.deepEqual(projectHardStop(quotaBucket('okx', 'basic', 85_000), start + 10 * DAY), { kind: 'reached' });
  assert.deepEqual(projectHardStop(quotaBucket('okx', 'basic', 10, { state: 'HARD_STOP' }), start + 10 * DAY), { kind: 'reached' });
});

test('the projected date is the Asia/Taipei date', () => {
  // 16:30 UTC on 10/20 is already 10/21 in Taipei.
  assert.equal(describeProjection({ kind: 'before_end', at: Date.parse('2026-10-20T16:30:00Z') }), '約 10/21 達到硬性上限');
  assert.equal(describeProjection({ kind: 'reached' }), '已達硬性上限，本月不再請求');
  assert.equal(describeProjection({ kind: 'no_usage' }), '本月尚無用量');
  assert.equal(describeProjection({ kind: 'too_early' }), '本月未滿一天，暫不推估');
});
