import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conflictingValues, knownValue, staleValue, unknownValue, unsupportedValue } from '@morrow/core';
import {
  assetParts,
  describeObserved,
  fractionAsPercent,
  groupDigits,
  isStale,
  reasonLabel,
  SNAPSHOT_STALE_MS,
  sharedNotKnown,
  shortAddress,
} from './market.js';

test('digits are grouped without changing any of them', () => {
  assert.equal(groupDigits('30663136.63'), '30,663,136.63');
  assert.equal(groupDigits('120.78'), '120.78');
  assert.equal(groupDigits('0.00000001234'), '0.00000001234', 'a tiny price keeps every digit');
  assert.equal(groupDigits('-1234567'), '-1,234,567');
  assert.equal(groupDigits('123456789012345678901234567890'), '123,456,789,012,345,678,901,234,567,890', 'past 2^53, still exact');
  assert.equal(groupDigits('1.23456789012'), '1.23456789012', 'the fraction is not grouped');
  assert.equal(groupDigits('1e5'), '1e5', 'not a plain decimal: shown as is');
});

test('a fraction reads as an exact percentage with its sign', () => {
  assert.equal(fractionAsPercent('0.0125'), '+1.25%');
  assert.equal(fractionAsPercent('-0.0084'), '-0.84%');
  assert.equal(fractionAsPercent('0'), '0%');
  assert.equal(fractionAsPercent('12.5'), '+1,250%');
  assert.equal(fractionAsPercent('0.000000123'), '+0.0000123%');
});

test('addresses and asset ids are shortened for a table cell', () => {
  assert.equal(shortAddress('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'), 'Czfq…44zE');
  assert.equal(shortAddress('short'), 'short');
  assert.deepEqual(assetParts('solana:mainnet-beta:So11111111111111111111111111111111111111112'), {
    reference: 'So11111111111111111111111111111111111111112',
    network: 'solana:mainnet-beta',
  });
});

test('a snapshot is out of date after five minutes', () => {
  const observed = '2026-10-14T00:00:00.000Z';
  const t = Date.parse(observed);
  assert.equal(isStale(observed, t + SNAPSHOT_STALE_MS), false);
  assert.equal(isStale(observed, t + SNAPSHOT_STALE_MS + 1), true);
  assert.equal(isStale(observed, t - 60_000), false, 'a snapshot from slightly ahead of the clock is not out of date');
});

test('a value that is not known says why, and is never shown as zero or blank', () => {
  const format = (value: string) => groupDigits(value);
  assert.deepEqual(describeObserved(knownValue('1234.5'), format), { kind: 'known', text: '1,234.5', title: null });
  assert.deepEqual(describeObserved(knownValue('0'), format), { kind: 'known', text: '0', title: null }, 'a real zero is a zero');

  const unit = describeObserved(unknownValue('UNIT_UNVERIFIED'), format);
  assert.deepEqual(unit, { kind: 'unknown', text: '未知：單位未確認', title: 'UNKNOWN · UNIT_UNVERIFIED' });
  assert.equal(describeObserved(unknownValue('MISSING'), format).text, '未知：來源未提供');
  assert.equal(describeObserved(unsupportedValue('NOT_A_SCALAR'), format).text, '不支援：不是單一值');
  assert.equal(describeObserved(staleValue('5', 'OLD'), format).kind, 'stale');
  assert.match(describeObserved(staleValue('5', 'OLD'), format).text, /^5（過時：OLD）$/);
  const conflicting = describeObserved(conflictingValues(['1', '2'], 'SOURCES_DISAGREE'), format);
  assert.equal(conflicting.kind, 'conflicting');
  assert.equal(conflicting.text, '來源不一致（2 個值）');
  assert.match(conflicting.title ?? '', /1 \/ 2/);

  for (const state of [unknownValue('MISSING'), unknownValue('ANYTHING'), unsupportedValue('X')]) {
    const shown = describeObserved(state, format);
    assert.notEqual(shown.text.trim(), '');
    assert.doesNotMatch(shown.text, /^0/);
  }
});

test('an unlabelled reason is shown as its code, and object keys are not reasons', () => {
  assert.equal(reasonLabel('UNIT_UNVERIFIED'), '單位未確認');
  assert.equal(reasonLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
  assert.equal(reasonLabel('constructor'), 'constructor');
  assert.equal(reasonLabel('__proto__'), '__proto__');
});

test('windows that are all unknown for the same reason are stated once', () => {
  const unit = unknownValue('UNIT_UNVERIFIED');
  assert.deepEqual(sharedNotKnown([unit, unit, unit, unit]), unit);
  assert.equal(sharedNotKnown([unit, unit, unit, unknownValue('MISSING')]), null, 'different reasons are each shown');
  assert.equal(sharedNotKnown([unit, unit, unit, unsupportedValue('UNIT_UNVERIFIED')]), null, 'different states are each shown');
  assert.equal(sharedNotKnown([knownValue('1'), knownValue('1'), knownValue('1'), knownValue('1')]), null, 'known values are shown per window');
  assert.equal(sharedNotKnown([staleValue('1', 'OLD'), staleValue('2', 'OLD')]), null, 'stale values carry a value of their own');
  assert.equal(sharedNotKnown([]), null);
});
