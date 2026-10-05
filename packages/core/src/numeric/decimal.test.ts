import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecimalString } from '../contracts/primitives.js';
import { isWithinUnitInterval, normalizeScalar, parseDecimal, parseRatio, shiftDecimal, toPlainDecimal } from './decimal.js';

test('shiftDecimal moves the point exactly', () => {
  assert.equal(shiftDecimal('30.68', -2), '0.3068');
  assert.equal(shiftDecimal('0.3068', 2), '30.68');
  assert.equal(shiftDecimal('5', -3), '0.005');
  assert.equal(shiftDecimal('5', 3), '5000');
  assert.equal(shiftDecimal('123.456', 0), '123.456');
  assert.equal(shiftDecimal('123.456', 1), '1234.56');
  assert.equal(shiftDecimal('123.456', 3), '123456');
  assert.equal(shiftDecimal('123.456', -3), '0.123456');
  assert.equal(shiftDecimal('-1.50', -1), '-0.15');
  assert.equal(shiftDecimal('-0.00', 4), '0', 'negative zero is zero');
  assert.throws(() => shiftDecimal('1e5', 1));
  assert.throws(() => shiftDecimal('abc', 1));
  assert.throws(() => shiftDecimal('1', 0.5));
});

test('shiftDecimal keeps digits a float would lose', () => {
  assert.equal(shiftDecimal('295310000.000000000000000001', -2), '2953100.00000000000000000001');
  assert.equal(shiftDecimal('18446744073709551615', -9), '18446744073.709551615');
});

test('toPlainDecimal canonicalises and expands exponents', () => {
  assert.equal(toPlainDecimal('007.500'), '7.5');
  assert.equal(toPlainDecimal('+3'), '3');
  assert.equal(toPlainDecimal(' 1.5e-7 '), '0.00000015');
  assert.equal(toPlainDecimal('1e+21'), '1000000000000000000000');
  assert.equal(toPlainDecimal('-0'), '0');
  for (const bad of ['1,234.5', '.5', '5.', '0x10', '1e', '--', '1e999999', 'Infinity', '']) {
    assert.equal(toPlainDecimal(bad), null, bad);
  }
});

test('every canonical result satisfies the DecimalString contract', () => {
  for (const input of ['007.500', '1.5e-7', '-12.3400', '0', '1e3']) {
    const plain = toPlainDecimal(input);
    assert.ok(plain !== null);
    assert.equal(DecimalString.safeParse(plain).success, true, `${input} -> ${plain}`);
  }
});

test('placeholders and absent values are UNKNOWN, never zero', () => {
  for (const raw of [null, undefined, '', '  ', 'null', 'NULL', '--', '-', 'N/A', 'NaN', Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = normalizeScalar(raw);
    assert.equal(result.state, 'UNKNOWN', String(raw));
    assert.equal(parseDecimal(raw).state, 'UNKNOWN', String(raw));
  }
  assert.deepEqual(normalizeScalar('0'), { state: 'KNOWN', value: '0' }, 'a real zero stays known');
  assert.deepEqual(parseDecimal(0), { state: 'KNOWN', value: '0' });
});

test('non-scalars are UNSUPPORTED', () => {
  assert.equal(normalizeScalar({}).state, 'UNSUPPORTED');
  assert.equal(normalizeScalar([1]).state, 'UNSUPPORTED');
  assert.equal(normalizeScalar(true).state, 'UNSUPPORTED');
});

test('parseDecimal handles numbers that print with an exponent', () => {
  assert.deepEqual(parseDecimal(1.5e-7), { state: 'KNOWN', value: '0.00000015' });
  assert.deepEqual(parseDecimal('garbage'), { state: 'UNKNOWN', reason: 'NOT_NUMERIC' });
});

test('parseRatio converts only when the unit is declared', () => {
  assert.deepEqual(parseRatio('30.68', 'PERCENT'), { state: 'KNOWN', value: '0.3068' });
  assert.deepEqual(parseRatio('0.3068', 'FRACTION'), { state: 'KNOWN', value: '0.3068' });
});

test('an unverified unit is quarantined rather than guessed', () => {
  // 0.5 could be 50% or 0.5%. Both readings are plausible, so neither is used.
  assert.deepEqual(parseRatio('0.5', 'UNVERIFIED'), { state: 'UNKNOWN', reason: 'UNIT_UNVERIFIED' });
  assert.deepEqual(parseRatio('30.68', 'UNVERIFIED'), { state: 'UNKNOWN', reason: 'UNIT_UNVERIFIED' });
  assert.deepEqual(parseRatio('--', 'UNVERIFIED'), { state: 'UNKNOWN', reason: 'PLACEHOLDER' });
});

test('a bounded share outside [0, 1] is rejected as a likely unit mismatch', () => {
  assert.deepEqual(parseRatio('30.68', 'FRACTION', { bounded: true }), { state: 'UNKNOWN', reason: 'OUT_OF_RANGE' });
  assert.deepEqual(parseRatio('130', 'PERCENT', { bounded: true }), { state: 'UNKNOWN', reason: 'OUT_OF_RANGE' });
  assert.deepEqual(parseRatio('-1', 'PERCENT', { bounded: true }), { state: 'UNKNOWN', reason: 'OUT_OF_RANGE' });
  assert.deepEqual(parseRatio('100', 'PERCENT', { bounded: true }), { state: 'KNOWN', value: '1' });
  assert.deepEqual(parseRatio('0', 'PERCENT', { bounded: true }), { state: 'KNOWN', value: '0' });
  assert.deepEqual(parseRatio('130', 'PERCENT'), { state: 'KNOWN', value: '1.3' }, 'unbounded ratios may exceed 1');
});

test('isWithinUnitInterval', () => {
  for (const inside of ['0', '0.5', '1', '1.000', '0.999999999999999999999']) assert.equal(isWithinUnitInterval(inside), true, inside);
  for (const outside of ['-0.1', '1.0001', '2', '10']) assert.equal(isWithinUnitInterval(outside), false, outside);
});
