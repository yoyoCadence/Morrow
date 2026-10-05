import { z } from 'zod';

/**
 * Version of the canonical contract set. Stored with every event so a later
 * reader knows which rules the record was written under. Bump it on a breaking
 * contract change and add an explicit converter; never rewrite old records.
 */
export const SCHEMA_VERSION = 1;

/** A UTC instant such as `2026-10-05T12:00:00.000Z`. Storage is always UTC; the UI converts to Asia/Taipei. */
export const UtcTimestamp = z.iso.datetime();
export type UtcTimestamp = z.infer<typeof UtcTimestamp>;

/**
 * A non-negative integer carried as a string. Raw token amounts and slots use
 * this so they never pass through a JavaScript float.
 */
export const UIntString = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/, 'expected a non-negative integer string without leading zeros');
export type UIntString = z.infer<typeof UIntString>;

/**
 * A decimal number carried as a plain string: optional minus sign, no
 * exponent, no thousands separators. Money and ratios use this.
 */
export const DecimalString = z
  .string()
  .max(96)
  .regex(/^-?(0|[1-9]\d*)(\.\d+)?$/, 'expected a plain decimal string');
export type DecimalString = z.infer<typeof DecimalString>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase SHA-256 hex digest');
export type Sha256Hex = z.infer<typeof Sha256Hex>;
