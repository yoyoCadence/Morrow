import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleDedupeKey, slotStart, validateSchedules } from './scheduler.js';

test('slots are aligned to the UTC epoch, not to when the worker started', () => {
  const fiveMinutes = 300_000;
  assert.equal(slotStart(new Date('2026-10-14T03:07:59.999Z'), fiveMinutes).toISOString(), '2026-10-14T03:05:00.000Z');
  assert.equal(slotStart(new Date('2026-10-14T03:10:00.000Z'), fiveMinutes).toISOString(), '2026-10-14T03:10:00.000Z');
  assert.equal(slotStart(new Date('2026-10-14T03:00:30.000Z'), 60_000).toISOString(), '2026-10-14T03:00:00.000Z');
  assert.equal(
    slotStart(new Date('2026-10-14T20:00:00.000Z'), 86_400_000).toISOString(),
    '2026-10-14T00:00:00.000Z',
    'a daily slot starts at UTC midnight, whatever day it already is in Taipei',
  );
});

test('a slot has one dedupe key, readable in the jobs table', () => {
  assert.equal(scheduleDedupeKey('jupiter.recent', new Date('2026-10-14T03:05:00Z')), 'schedule:jupiter.recent:2026-10-14T03:05:00.000Z');
});

test('schedule lists that cannot work are refused before anything runs', () => {
  const ok = { name: 'okx.hot-token', kind: 'okx.hot_token', everyMs: 300_000 };
  assert.doesNotThrow(() => validateSchedules([ok, { ...ok, name: 'jupiter.recent', everyMs: 60_000 }]));
  assert.throws(() => validateSchedules([ok, ok]), /defined twice/);
  assert.throws(() => validateSchedules([{ ...ok, name: 'Has Spaces' }]), /must match/);
  assert.throws(() => validateSchedules([{ ...ok, name: 'a:b' }]), /must match/, 'the name is part of a colon-separated key');
  assert.throws(() => validateSchedules([{ ...ok, everyMs: 999 }]), /at least 1000/);
  assert.throws(() => validateSchedules([{ ...ok, everyMs: 60_000.5 }]), /whole number/);
});
