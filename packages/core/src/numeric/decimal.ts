import { knownValue, unknownValue, unsupportedValue, type Observed } from '../contracts/observed.js';

/**
 * Exact decimal handling on strings. Nothing here goes through a JavaScript
 * float, so amounts and ratios keep every digit the source gave us.
 */

const NUMERIC = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Values providers send in place of "no data". None of them mean zero. */
const PLACEHOLDERS = new Set(['', 'null', 'undefined', 'nan', 'n/a', 'na', '-', '--', '—']);

function canonical(negative: boolean, integerDigits: string, fractionDigits: string): string {
  const integer = integerDigits.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionDigits.replace(/0+$/, '');
  const magnitude = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  const isZero = /^[0.]*$/.test(magnitude);
  return negative && !isZero ? `-${magnitude}` : magnitude;
}

/**
 * Multiplies a plain decimal string by 10^places by moving the decimal point.
 * `shiftDecimal('30.68', -2)` is `'0.3068'`.
 */
export function shiftDecimal(value: string, places: number): string {
  const match = NUMERIC.exec(value);
  if (!match || match[4] !== undefined) {
    throw new Error(`shiftDecimal expects a plain decimal string, got "${value}"`);
  }
  if (!Number.isInteger(places)) throw new Error('shiftDecimal expects an integer number of places');

  const negative = match[1] === '-';
  const integerDigits = match[2] ?? '0';
  const fractionDigits = match[3] ?? '';
  const digits = integerDigits + fractionDigits;
  const point = integerDigits.length + places;

  if (point <= 0) return canonical(negative, '0', '0'.repeat(-point) + digits);
  if (point >= digits.length) return canonical(negative, digits + '0'.repeat(point - digits.length), '');
  return canonical(negative, digits.slice(0, point), digits.slice(point));
}

/**
 * Turns numeric text into a canonical plain decimal string, expanding an
 * exponent if present. Returns null for anything that is not unambiguously a
 * number (for example `1,234.5` or `.5`): we do not guess.
 */
export function toPlainDecimal(text: string): string | null {
  const match = NUMERIC.exec(text.trim());
  if (!match) return null;
  const negative = match[1] === '-';
  const plain = canonical(negative, match[2] ?? '0', match[3] ?? '');
  if (match[4] === undefined) return plain;
  const exponent = Number(match[4]);
  // An absurd exponent is a malformed payload, not a number worth expanding.
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return null;
  return shiftDecimal(plain, exponent);
}

/**
 * Normalises one scalar from a provider payload. Absent values and placeholder
 * strings become UNKNOWN, never zero.
 */
export function normalizeScalar(raw: unknown): Observed<string> {
  if (raw === null || raw === undefined) return unknownValue('MISSING');
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return PLACEHOLDERS.has(trimmed.toLowerCase()) ? unknownValue('PLACEHOLDER') : knownValue(trimmed);
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? knownValue(String(raw)) : unknownValue('NOT_FINITE');
  }
  if (typeof raw === 'bigint') return knownValue(raw.toString());
  return unsupportedValue('NOT_A_SCALAR');
}

/** Parses a provider scalar into a canonical decimal string. */
export function parseDecimal(raw: unknown): Observed<string> {
  const scalar = normalizeScalar(raw);
  if (scalar.state !== 'KNOWN') return scalar;
  const plain = toPlainDecimal(scalar.value);
  return plain === null ? unknownValue('NOT_NUMERIC') : knownValue(plain);
}

/**
 * How a provider expresses a ratio.
 * - FRACTION: 0.3068 means 30.68%.
 * - PERCENT: 30.68 means 30.68%.
 * - UNVERIFIED: the unit has not been confirmed against the provider's
 *   documentation or a known sample. The value is quarantined.
 */
export type RatioUnit = 'FRACTION' | 'PERCENT' | 'UNVERIFIED';

export interface ParseRatioOptions {
  /** Set for shares of a whole, which must land in [0, 1]. */
  readonly bounded?: boolean;
}

/**
 * Parses a ratio into a fraction (1 = 100%).
 *
 * The unit must be declared by the caller. We never infer it from the size of
 * the number: 0.5 could be 50% or 0.5%, and guessing wrong is off by 100x.
 * With an UNVERIFIED unit, or a bounded value outside [0, 1], the result is
 * UNKNOWN so the caller quarantines the field instead of using it.
 */
export function parseRatio(raw: unknown, unit: RatioUnit, options: ParseRatioOptions = {}): Observed<string> {
  const decimal = parseDecimal(raw);
  if (decimal.state !== 'KNOWN') return decimal;
  if (unit === 'UNVERIFIED') return unknownValue('UNIT_UNVERIFIED');

  const fraction = unit === 'PERCENT' ? shiftDecimal(decimal.value, -2) : decimal.value;
  if (options.bounded && !isWithinUnitInterval(fraction)) return unknownValue('OUT_OF_RANGE');
  return knownValue(fraction);
}

/** True when a canonical decimal string is within [0, 1]. */
export function isWithinUnitInterval(value: string): boolean {
  if (value.startsWith('-')) return false;
  const [integer = '0', fraction = ''] = value.split('.');
  if (integer === '0') return true;
  return integer === '1' && /^0*$/.test(fraction);
}
