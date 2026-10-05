import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isAssetIdString } from './asset-id.js';
import { DecimalString, SCHEMA_VERSION, UtcTimestamp } from './primitives.js';
import { Provenance } from './provenance.js';
import { isWithinUnitInterval } from '../numeric/decimal.js';

/**
 * Canonical events use a small fixed set of domains plus a free-form action
 * and a versioned payload. A new strategy feature becomes a registered signal,
 * not a new event domain.
 */
export const EVENT_DOMAINS = [
  'asset',
  'market',
  'liquidity',
  'flow',
  'ownership',
  'project',
  'security',
  'system',
  'decision',
] as const;
export const EventDomain = z.enum(EVENT_DOMAINS);
export type EventDomain = z.infer<typeof EventDomain>;

export const EVENT_SEVERITIES = ['INFO', 'NOTICE', 'WARNING', 'CRITICAL'] as const;
export const EventSeverity = z.enum(EVENT_SEVERITIES);
export type EventSeverity = z.infer<typeof EventSeverity>;

/** Lowercase dotted action name, for example `pool.created`. */
export const EventAction = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'expected a lowercase dotted action name');

const NON_ASSET_SUBJECT = /^(system|provider|portfolio):[a-z0-9][a-z0-9_.-]{0,62}$/;

/** What an event is about: an asset id, or a `system:` / `provider:` / `portfolio:` reference. */
export const EventSubject = z
  .string()
  .max(256)
  .refine(
    (value) => isAssetIdString(value) || NON_ASSET_SUBJECT.test(value),
    'expected an asset id or a system:/provider:/portfolio: reference',
  );

const Confidence = DecimalString.refine(isWithinUnitInterval, 'confidence must be within [0, 1]');

/** The fields a producer supplies. `event_id` and `available_at` are assigned on append. */
export const NewEvent = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  /**
   * Identifies the underlying fact, so the same fact arriving twice is stored
   * once. On-chain facts must include signature, instruction path and event
   * ordinal; "same token in the same minute" is not a valid key.
   */
  dedupe_key: z.string().min(1).max(512),
  domain: EventDomain,
  action: EventAction,
  subject: EventSubject,
  payload_version: z.number().int().min(1),
  payload: z.record(z.string(), z.unknown()),
  event_time: UtcTimestamp.nullable(),
  observed_at: UtcTimestamp,
  provenance: Provenance,
  severity: EventSeverity,
  /** Null when no confidence was assessed. Not a default of 1. */
  confidence: Confidence.nullable(),
  causation_id: z.uuid().nullable(),
  correlation_id: z.uuid().nullable(),
});
export type NewEvent = z.infer<typeof NewEvent>;

export const CanonicalEvent = NewEvent.extend({
  event_id: z.uuid(),
  available_at: UtcTimestamp,
});
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;

/**
 * Derives the event id from the dedupe key, so replaying the same inputs
 * yields the same ids. The result is a version-8 (custom) UUID per RFC 9562.
 */
export function eventIdFor(dedupeKey: string): string {
  const bytes = createHash('sha256').update(`morrow:event:${dedupeKey}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
